// claude API response generation

import { buildSystemPrompt, CHAR_LIMIT, stampNotice } from './prompt.mjs';
import { recordUsage } from '../db/usage.mjs';

export { stampNotice };

const RESPONDER_MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

function apiHeaders(apiKey) {
  return { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
}

// ─── SSE stream accumulation ───

export function newStreamAcc() {
  return { blocks: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0, error: null };
}

// Fold one parsed SSE event into the accumulator. Text is kept PER CONTENT
// BLOCK (by the event's block index) so tool-use rounds can be told apart
// from the reply afterwards — blindly concatenating every text_delta is what
// leaked "I'll search all the key areas of the Sign document…" into a sent
// message (msg #438, Oct 2026).
export function applyStreamEvent(acc, evt) {
  if (!evt || typeof evt !== 'object') return acc;
  switch (evt.type) {
    case 'content_block_start': {
      const type = evt.content_block?.type || 'text';
      acc.blocks[evt.index] = { type, text: evt.content_block?.text || '' };
      break;
    }
    case 'content_block_delta': {
      if (evt.delta?.type !== 'text_delta') break;
      const i = typeof evt.index === 'number' ? evt.index : Math.max(0, acc.blocks.length - 1);
      if (!acc.blocks[i]) acc.blocks[i] = { type: 'text', text: '' };
      acc.blocks[i].text += evt.delta.text || '';
      break;
    }
    case 'message_start':
      if (evt.message?.usage) {
        acc.inputTokens = evt.message.usage.input_tokens || 0;
        acc.cacheReadTokens = evt.message.usage.cache_read_input_tokens || 0;
      }
      break;
    case 'message_delta':
      if (evt.usage) {
        acc.outputTokens = evt.usage.output_tokens || acc.outputTokens;
        acc.webSearches = evt.usage.server_tool_use?.web_search_requests || acc.webSearches;
      }
      break;
    case 'error':
      acc.error = evt.error?.message || 'stream error';
      break;
  }
  return acc;
}

// POST a streaming Messages request and collect it. Streaming keeps bytes
// flowing on big contexts (a 436K-char governing doc plus references plus
// web-search rounds) that otherwise hit the gateway's ~100s limit with a 524.
async function streamClaude(apiKey, requestBody, label = 'AI') {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: apiHeaders(apiKey),
    body: JSON.stringify({ ...requestBody, stream: true }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.log(`[${label}] API error: ${resp.status} ${errText}`);
    throw new Error(`Claude API ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const acc = newStreamAcc();
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        applyStreamEvent(acc, JSON.parse(payload));
      } catch { /* partial JSON across chunk boundary — ignore */ }
    }
  }
  if (acc.error) throw new Error(`Claude API stream: ${acc.error}`);
  acc.blocks = acc.blocks.filter(Boolean);
  return acc;
}

// ─── reply hygiene ───

// Narration the model emits right before calling a tool ("I'll search…",
// "Let me look up…"). Only ever applied to text that a tool block follows.
const PREAMBLE_RE = /^(?:i(?:'|’)?ll|i will|i(?:'|’)?m going to|let me)\s+(?:\w+\s+){0,3}(?:search|look|pull|check|find|verify|research|gather|dig|grab|get|run|do)\b|^(?:searching|looking (?:up|into)|checking|pulling up)\b/i;

function looksLikePreamble(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (PREAMBLE_RE.test(t)) return true;
  if (t.length >= 200) return false;
  // short block right before a tool call: trailing "..."/":" or a preamble
  // phrase after a lead-in ("Good question, let me search.")
  if (/(?:\.\.\.|…|:)$/.test(t)) return true;
  return t.split(/[.,;:—–]\s*/).some(clause => PREAMBLE_RE.test(clause.trim()));
}

// "Sam,\n\nSam," → one greeting; "…back to Sam.Sam," (preamble glued onto the
// greeting) → drop the preamble when it reads like one, else break the line.
function collapseGreeting(text) {
  let t = text.replace(/^\s*([A-Z][\w'’-]*)\s*[,—–-]+\s*\n+(?=\s*\1\s*[,—–-])/, '');
  const glued = t.match(/^([\s\S]{0,400}?[A-Z][\w'’-]*\.)(?=([A-Z][\w'’-]*),)/);
  if (glued) {
    const prefix = glued[1];
    const name = glued[2];
    if (prefix.endsWith(`${name}.`) || prefix.endsWith(` ${name}.`)) {
      t = looksLikePreamble(prefix) ? t.slice(prefix.length) : `${prefix}\n\n${t.slice(prefix.length)}`;
    }
  }
  return t;
}

// Reduce an ordered list of content blocks [{ type, text }] to the reply text.
// With tool blocks present: keep only the text after the last tool round when
// it is substantial; otherwise keep every text block except tool preambles.
export function cleanReplyText(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return '';
  const lastTool = blocks.reduce((last, b, i) => (b && b.type !== 'text' ? i : last), -1);
  const textOf = bs => bs.filter(b => b && b.type === 'text').map(b => (b.text || '').trim()).filter(Boolean).join('\n\n');

  let text = null;
  if (lastTool >= 0) {
    const trailing = textOf(blocks.slice(lastTool + 1));
    if (trailing.length >= 400) text = trailing;
  }
  if (text === null) {
    const kept = blocks.filter((b, i) => {
      if (!b || b.type !== 'text') return false;
      const toolFollows = i < lastTool;
      return !(toolFollows && looksLikePreamble(b.text));
    });
    text = textOf(kept) || textOf(blocks);
  }
  return collapseGreeting(text).trim();
}

// Third-person narrative references to the contact ("Sam has been", "Sam's
// message", "the user") — Dennis writes TO the contact, so these are slips.
// Direct address ("Sam,", "Sam —", "thanks, Sam.") and quoted speech pass.
// Returns the offending snippets, [] when clean.
export function voiceViolations(text, contactName) {
  if (!text) return [];
  const rawNames = (Array.isArray(contactName) ? contactName : [contactName]).flatMap(n => String(n || '').split(/[\s,]+/));
  const names = [...new Set(rawNames.filter(n => n && n.length >= 2).flatMap(n => {
    const cap = n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
    return [cap, n.toUpperCase()];
  }))].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  // quoted speech and quoted lines are the contact's words, not Dennis's voice
  const scrubbed = text
    .replace(/"[^"\n]{1,400}"/g, '""')
    .replace(/“[^”\n]{1,400}”/g, '“”')
    .replace(/^\s*>.*$/gm, '');

  const patterns = [/\bthe (?:user|sender|inmate|recipient|requester)\b/gi];
  if (names.length) {
    const alt = `(?:${names.join('|')})`;
    const verbs = "(?:has|had|have|is|was|asked|asks|said|says|wants|wanted|mentioned|mentions|sent|sends|wrote|writes|needs|needed|thinks|thought|feels|felt|seems|seemed|shared|shares|described|requested|requests|told|tells|brought|raised|will|would|should|can|could|did|does|doesn(?:'|’)t|didn(?:'|’)t|isn(?:'|’)t|hasn(?:'|’)t|also|clearly|recently|just)";
    patterns.push(new RegExp(`\\b${alt}\\s+${verbs}\\b`, 'g'));
    patterns.push(new RegExp(`\\b${alt}(?:'|’)s\\b`, 'g'));
    patterns.push(new RegExp(`\\b(?:to|for|with|about|from|tell|telling|told|ask|asking|asked|help|helping|thank|thanking)\\s+${alt}\\b(?!\\s*[,.!?—–-])`, 'g'));
  }

  const out = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(scrubbed)) !== null) {
      const snippet = scrubbed.slice(m.index, m.index + m[0].length + 40).split('\n')[0].trim();
      if (!out.includes(snippet)) out.push(snippet);
    }
  }
  return out;
}

export async function generateResponse(env, inboundMessage, conversationHistory, knowledgeEntries, subjectLength, topicHistory, topicName, { fullDocument = false, currentDocument = null, language = 'en', contactName = null, contactNick = null, referenceDocs = [], manifest = null, profile = null } = {}) {
  if (!env.ANTHROPIC_API_KEY) {
    console.log('[AI] no ANTHROPIC_API_KEY, skipping response generation');
    return null;
  }

  const nick = (contactNick || 'sam').toLowerCase();
  const systemPrompt = buildSystemPrompt(conversationHistory, knowledgeEntries, subjectLength, topicHistory, topicName, { fullDocument, currentDocument, language, contactName, contactNick: nick, referenceDocs, manifest, profile });

  const acc = await streamClaude(env.ANTHROPIC_API_KEY, {
    model: RESPONDER_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    // server-side web search: lets replies ground factual questions (health,
    // law, media, current events) in live sources instead of model memory.
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [
      {
        role: 'user',
        content: `from ${nick}, received just now:\n\n${inboundMessage}`,
      },
    ],
  });

  if (acc.webSearches) console.log(`[AI] used ${acc.webSearches} web search(es)`);
  await recordUsage(env.DB, {
    kind: 'reply', model: RESPONDER_MODEL,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    webSearches: acc.webSearches,
  }).catch(e => console.log(`[USAGE] record failed: ${e.message}`));

  const rawLen = acc.blocks.filter(b => b.type === 'text').reduce((n, b) => n + b.text.length, 0);
  const responseText = cleanReplyText(acc.blocks);
  if (responseText.length !== rawLen) console.log(`[AI] hygiene: ${acc.blocks.length} blocks, ${rawLen} → ${responseText.length} chars`);
  console.log(`[AI] generated response (${responseText.length} chars)`);
  return responseText;
}

// Maintain the single governing document for a (contact, topic). Given the
// current body (empty for makenew) and the latest exchange, return the COMPLETE
// updated document with the new material integrated in place. This is separate
// from the conversational reply — it produces the living artifact.
export async function buildDocument(env, { tag, title, currentDoc, newMaterial, command, authorName = 'the author', language = 'en' }) {
  if (!env.ANTHROPIC_API_KEY) return null;

  const isNew = command === 'makenew' || !currentDoc;
  const langLine = language === 'es'
    ? '\n- Write the ENTIRE document in Spanish (Español) — it belongs to a Spanish-speaking author.'
    : '';
  const system = `You are the editor of a single living document titled "${title}". This is ${authorName}'s working manuscript for the "${tag}" project — the combined, authoritative version that accumulates and integrates everything over time. ${authorName} sends direction and notes; Dennis drafts and writes content with them. Your document is the assembled result of that collaboration.

Your job: take the CURRENT DOCUMENT and the NEW MATERIAL (the latest exchange — ${authorName}'s direction plus the drafted content), and produce the COMPLETE UPDATED DOCUMENT with the new material integrated in place.

Rules:
- ${isNew ? `This is a NEW document. Build a well-structured first version from the material — a clear title, organized sections, and headers. Pull the actual drafted content into the body; use ${authorName}'s notes to guide structure and intent.` : 'REVISE the existing document. Weave the new drafted content into the RIGHT sections. Add new sections where the material warrants. Keep all prior content unless the new material explicitly supersedes or corrects it.'}
- Preserve structure, headers, and prior detail. Never drop content silently. Never summarize away existing material to make room.
- Integrate — do not just append. If new material expands a section, edit that section. If it's genuinely new, add a section.
- This is the manuscript itself, not a conversation. Write it as a document: no speaker dialogue, no "here's your update" framing, no salutations or sign-offs. Just the assembled work with headers and organized prose.${langLine}
- Output ONLY the complete document body. No preamble, no commentary, no meta-notes about what you changed.`;

  const user = isNew
    ? `NEW MATERIAL (build the initial document from this):\n\n${newMaterial}`
    : `CURRENT DOCUMENT:\n\n${currentDoc}\n\n─────────────────────\n\nNEW MATERIAL (integrate this into the document above, then output the complete updated document):\n\n${newMaterial}`;

  // Stream the response — a large document (up to 32k tokens) can take minutes,
  // and a non-streaming request stalls the connection long enough to hit a
  // gateway 524 timeout. Streaming keeps bytes flowing and avoids that.
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 32000,
      stream: true,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.log(`[DOC] build error: ${resp.status} ${errText.substring(0, 200)}`);
    throw new Error(`Doc build ${resp.status}: ${errText.substring(0, 200)}`);
  }

  // parse the SSE stream, accumulating text_delta events + usage (input tokens
  // arrive on message_start, output tokens accumulate on message_delta).
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let streamErr = null;
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          content += evt.delta.text;
        } else if (evt.type === 'message_start' && evt.message?.usage) {
          inputTokens = evt.message.usage.input_tokens || 0;
          cacheReadTokens = evt.message.usage.cache_read_input_tokens || 0;
        } else if (evt.type === 'message_delta' && evt.usage) {
          outputTokens = evt.usage.output_tokens || outputTokens;
        } else if (evt.type === 'error') {
          streamErr = evt.error?.message || 'stream error';
        }
      } catch { /* partial JSON across chunk boundary — ignore */ }
    }
  }
  if (streamErr) throw new Error(`Doc build stream: ${streamErr}`);

  await recordUsage(env.DB, {
    kind: 'doc-build', model: 'claude-sonnet-4-6',
    inputTokens, outputTokens, cacheReadTokens,
  }).catch(e => console.log(`[USAGE] record failed: ${e.message}`));

  console.log(`[DOC] built "${tag}" body ${content.length} chars (was ${(currentDoc || '').length})`);
  return content || null;
}

// Drain an SSE /v1/messages stream: accumulated text + usage. Same event
// handling as buildDocument/generateResponse (kept inline there on purpose).
async function readTextStream(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let streamErr = null;
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          text += evt.delta.text;
        } else if (evt.type === 'message_start' && evt.message?.usage) {
          inputTokens = evt.message.usage.input_tokens || 0;
          cacheReadTokens = evt.message.usage.cache_read_input_tokens || 0;
        } else if (evt.type === 'message_delta' && evt.usage) {
          outputTokens = evt.usage.output_tokens || outputTokens;
        } else if (evt.type === 'error') {
          streamErr = evt.error?.message || 'stream error';
        }
      } catch { /* partial JSON across chunk boundary — ignore */ }
    }
  }
  return { text, streamErr, inputTokens, outputTokens, cacheReadTokens };
}

// Parse the patch JSON a doc-patch call returns. Tolerates prose or code fences
// around the object (outermost {...} is extracted) and normalizes the shape to
// { patch: { section_updates, new_sections }, changelog }. Throws on anything
// that is not a usable patch. Pure.
export function parseDocPatch(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('doc-patch: no JSON object in model output');
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(`doc-patch: invalid JSON (${e.message.substring(0, 80)})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('doc-patch: output is not an object');

  const section = (s, withAfter) => {
    if (!s || typeof s !== 'object' || typeof s.heading !== 'string' || !s.heading.trim()) return null;
    const out = { heading: s.heading.trim(), body: s.body == null ? '' : String(s.body) };
    if (withAfter && typeof s.after === 'string' && s.after.trim()) out.after = s.after.trim();
    return out;
  };
  const list = (v) => Array.isArray(v) ? v : [];
  const patch = {
    section_updates: list(parsed.section_updates).map(s => section(s, false)).filter(Boolean),
    new_sections: list(parsed.new_sections).map(s => section(s, true)).filter(Boolean),
  };
  if (!patch.section_updates.length && !patch.new_sections.length) throw new Error('doc-patch: patch touches no sections');
  const changelog = typeof parsed.changelog === 'string' ? parsed.changelog.trim() : '';
  return { patch, changelog };
}

// Documents v2: ask for a PATCH to the sectioned governing document instead of
// a whole rewrite (docs/V2_ARCHITECTURE.md §6). Output is bounded by the
// sections actually touched, so a 130K-char document no longer truncates at
// the output cap. Returns { patch, changelog, replace } — `replace` is true for
// makefull, the one whole-rewrite case: the caller applies the patch to []
// instead of the current sections. Throws with a clear message on failure.
export async function buildDocumentPatch(env, { tag, title, sections = [], newMaterial, command = 'makeupdate', authorName = 'the author', language = 'en', entryDate = null }) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('doc-patch: no ANTHROPIC_API_KEY');
  const date = entryDate || new Date().toISOString().slice(0, 10);
  const isNew = command === 'makenew' || !sections.length;
  const isFull = command === 'makefull' && !isNew;
  const langLine = language === 'es'
    ? `\n- Write all section bodies, headings and the changelog in Spanish (Español) — the document belongs to a Spanish-speaking author.`
    : '';

  const modeRule = isNew
    ? `- MODE makenew: there is no existing document. Build the initial document from the NEW MATERIAL as new_sections (clear headings, organized prose, the drafted content pulled into the bodies). section_updates stays empty.`
    : isFull
      ? `- MODE makefull (full rewrite — the ONLY case where the whole document is rebuilt): return the COMPLETE document. Every section that should survive must appear — existing headings in section_updates with their full bodies, new ones in new_sections. Any section you leave out is dropped. Keep all prior content unless the new material supersedes it.`
      : `- MODE makeupdate: integrate the NEW MATERIAL into the existing sections. Touch only the sections the material genuinely changes; add a section only when the material fits none. Everything you do not mention is kept exactly as is.`;

  const system = `You maintain a single living document titled "${title}" — ${authorName}'s working manuscript for the "${tag}" project. ${authorName} sends direction and notes; the assistant (writing as Dennis) drafts content with them. The document is stored as an ordered list of SECTIONS (heading + body). You never rewrite the document; you return a PATCH.

Output STRICT JSON and nothing else — no prose before or after, no code fences:
{"section_updates":[{"heading":"...","body":"..."}],"new_sections":[{"heading":"...","body":"...","after":"..."}],"changelog":"one or two sentences: what changed and why"}

Rules:
- section_updates: existing sections whose body changes. "heading" is copied exactly from the current document; "body" is the COMPLETE new body of that section — it replaces the old body, so keep everything that still applies. Never shorten a section to save space; never summarize existing material away.
- new_sections: genuinely new material that fits no existing section. "after" names the existing heading it should follow (omit it to append at the end).
- Only sections that genuinely change appear in the patch. Never drop a section; there is no delete.
${modeRule}
- ATTRIBUTION (strict): what ${authorName} stated, decided or wrote is recorded as ${authorName}'s own, in ${authorName}'s terms. Anything the assistant contributes — research, suggestions, analysis, or drafted prose ${authorName} did not write — is marked inside the body as the assistant's: a paragraph beginning "Assistant note:" or an item ending with "(AI)". Never merge the two voices into one, never credit ${authorName} with the assistant's ideas, and never present the assistant's words as ${authorName}'s.
- Date new material ${date} where it helps the reader (e.g. "Added ${date}:"). Do not restamp untouched text.
- Document voice: this is the manuscript, not a conversation — no salutations, sign-offs, or "here's your update" framing inside bodies.
- Bodies are markdown; use "###" or lower for any sub-headings inside a body (never "#" or "##", which denote sections).
- changelog: one or two plain sentences naming the sections changed and why.${langLine}`;

  const rendered = sections.length
    ? sections.map(s => `=== SECTION: ${s.heading} ===\n${(s.body || '').trim()}`).join('\n\n')
    : '(none)';
  const user = `CURRENT DOCUMENT (${sections.length} section${sections.length === 1 ? '' : 's'}; headings are the lines "=== SECTION: <heading> ==="):\n\n${rendered}\n\n─────────────────────\n\nNEW MATERIAL (dated ${date} — ${authorName}'s direction/notes plus the assistant's drafted reply):\n\n${newMaterial}\n\n─────────────────────\n\nReturn the JSON patch now.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: RESPONDER_MODEL,
      max_tokens: 16000,
      stream: true,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.log(`[DOC] patch error: ${resp.status} ${errText.substring(0, 200)}`);
    throw new Error(`Doc patch ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const { text, streamErr, inputTokens, outputTokens, cacheReadTokens } = await readTextStream(resp);
  if (streamErr) throw new Error(`Doc patch stream: ${streamErr}`);

  await recordUsage(env.DB, {
    kind: 'doc-patch', model: RESPONDER_MODEL,
    inputTokens, outputTokens, cacheReadTokens,
  }).catch(e => console.log(`[USAGE] record failed: ${e.message}`));

  const { patch, changelog } = parseDocPatch(text);
  console.log(`[DOC] patch for "${tag}" (${command}): ${patch.section_updates.length} update(s), ${patch.new_sections.length} new, ${outputTokens} out tokens`);
  return { patch, changelog, replace: isFull };
}

// split a response into parts that each fit within the securus char limit
// subject + body must be <= 20,000 chars per message.
// options.maxParts caps the count (overflow is dropped — use planParts to see
// what fell off). Uncapped by default: makefull sends whole governing docs.
export function splitForSend(subject, body, { maxParts = Infinity } = {}) {
  const parts = Number.isFinite(maxParts) ? planParts(subject, body, maxParts).parts : splitAll(subject, body);
  if (parts.length > 1) console.log(`[AI] split response into ${parts.length} parts: ${parts.map(p => p.body.length).join(', ')} chars`);
  return parts;
}

// Pure: { parts, truncated, overflowText } — parts is the first maxParts of
// the natural split; overflowText is whatever would have gone into the rest.
export function planParts(subject, body, maxParts = 3) {
  const all = splitAll(subject, body || '');
  const cap = Math.max(1, Math.floor(maxParts) || 1);
  if (all.length <= cap) return { parts: all, truncated: false, overflowText: '' };
  return {
    parts: all.slice(0, cap),
    truncated: true,
    overflowText: all.slice(cap).map(p => p.body).join('\n\n'),
  };
}

function splitAll(subject, body) {
  const maxBodyPerMessage = CHAR_LIMIT - subject.length - 20; // safety margin

  if (body.length <= maxBodyPerMessage) {
    return [{ subject, body }];
  }

  // split into multiple messages at paragraph boundaries
  const parts = [];
  let remaining = body;
  let partNum = 1;

  while (remaining.length > 0) {
    const isLast = remaining.length <= maxBodyPerMessage;
    const partSubject = partNum === 1 ? subject : `${subject} (pt ${partNum})`;
    const maxBody = CHAR_LIMIT - partSubject.length - 20;

    if (remaining.length <= maxBody) {
      parts.push({ subject: partSubject, body: remaining });
      break;
    }

    // find a good split point — paragraph break, sentence end, or word boundary
    let splitAt = maxBody;

    // try paragraph break first (double newline)
    const lastPara = remaining.lastIndexOf('\n\n', splitAt);
    if (lastPara > maxBody * 0.5) {
      splitAt = lastPara;
    } else {
      // try sentence end
      const lastSentence = remaining.lastIndexOf('. ', splitAt);
      if (lastSentence > maxBody * 0.5) {
        splitAt = lastSentence + 1;
      } else {
        // try word boundary
        const lastSpace = remaining.lastIndexOf(' ', splitAt);
        if (lastSpace > maxBody * 0.5) {
          splitAt = lastSpace;
        }
      }
    }

    parts.push({ subject: partSubject, body: remaining.substring(0, splitAt).trim() });
    remaining = remaining.substring(splitAt).trim();
    partNum++;
  }

  return parts;
}

// ─── reply budget (hard cap on parts) ───

// Pure: parse the compressor's JSON → { text, overflowItems } or null.
export function parseBudgetJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] || '');
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) return null;
    const items = Array.isArray(parsed.overflow_items) ? parsed.overflow_items : [];
    return {
      text: parsed.text.trim(),
      overflowItems: items.map(s => String(s || '').trim()).filter(Boolean),
    };
  } catch { return null; }
}

// Drop overflow at the planned boundary; name what fell off as one item.
function hardCut(plan, extraItems = []) {
  const text = plan.parts.map(p => p.body).join('\n\n');
  const items = [...extraItems];
  if (plan.truncated) items.push(`remainder of the reply (${plan.overflowText.length.toLocaleString()} chars not sent)`);
  return { text, overflowItems: items, compressed: false, truncated: plan.truncated };
}

// Fit a draft into at most maxParts messages. Fits already → unchanged. Else
// ONE compression call that keeps the most important content and lists what
// it deferred (the request ledger turns overflowItems into followup requests).
export async function budgetReply(env, draft, { subject = '', subjectLength = null, maxParts = 3 } = {}) {
  const subj = subject || 'x'.repeat(Math.max(0, subjectLength || 0));
  const plan = planParts(subj, draft || '', maxParts);
  if (!plan.truncated) return { text: draft, overflowItems: [], compressed: false, truncated: false };

  const perPart = CHAR_LIMIT - subj.length - 20 - 8; // "(pt N)" suffix room
  const budget = Math.floor(perPart * maxParts * 0.9); // headroom for the pipeline footer
  console.log(`[BUDGET] draft ${draft.length} chars needs ${plan.parts.length}+ parts (cap ${maxParts}); compressing to ≤${budget}`);

  if (!env.ANTHROPIC_API_KEY) return hardCut(plan);

  const system = `You tighten a personal letter so it fits a hard length budget. Output STRICT JSON only: {"text": "...", "overflow_items": ["...", ...]}
- "text": the rewritten letter, at most ${budget} characters. Keep the writer's voice, greeting and sign-off. Keep the most important content whole — direct answers, decisions, anything the recipient explicitly asked for — and compress or cut the rest.
- "overflow_items": a short label (under 12 words) for each substantive item you cut, or shortened so much it needs its own later message. Empty array if nothing was dropped.
- Never add new claims. Never promise follow-ups inside "text" — the system tracks the overflow items and delivers them.
- Escape newlines as \\n inside the JSON string.`;

  try {
    const acc = await streamClaude(env.ANTHROPIC_API_KEY, {
      model: RESPONDER_MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: `DRAFT (${draft.length} chars; budget ${budget}):\n\n${draft}` }],
    }, 'BUDGET');
    await recordUsage(env.DB, {
      kind: 'budget', model: RESPONDER_MODEL,
      inputTokens: acc.inputTokens, outputTokens: acc.outputTokens, cacheReadTokens: acc.cacheReadTokens,
    }).catch(e => console.log(`[USAGE] record failed: ${e.message}`));

    const parsed = parseBudgetJson(acc.blocks.filter(b => b.type === 'text').map(b => b.text).join(''));
    if (!parsed) {
      console.log('[BUDGET] compressor returned no usable JSON; hard-cutting');
      return hardCut(plan);
    }
    const replan = planParts(subj, parsed.text, maxParts);
    if (!replan.truncated) {
      console.log(`[BUDGET] compressed ${draft.length} → ${parsed.text.length} chars, ${parsed.overflowItems.length} deferred`);
      return { text: parsed.text, overflowItems: parsed.overflowItems, compressed: true, truncated: false };
    }
    console.log(`[BUDGET] compressed text still ${replan.parts.length}+ parts; hard-cutting`);
    return { ...hardCut(replan, parsed.overflowItems), compressed: true };
  } catch (e) {
    console.log(`[BUDGET] compression failed: ${e.message}; hard-cutting`);
    return hardCut(plan);
  }
}

// ─── pipeline footer (appended by index.js, never written by the model) ───

// Factual trailer stating what the system actually did with this message.
// '' when there is nothing to say.
export function replyFooter(manifest) {
  if (!manifest) return '';
  const lines = [];
  const attachments = (manifest.attachments || []).filter(a => a && a.label);
  if (attachments.length) {
    lines.push('Attached: ' + attachments.map((a, i) => `${i + 1}) ${a.label}${a.model ? ` — ${a.model}` : ''}`).join(' · '));
  }
  const failed = (manifest.failed || []).filter(f => f && f.label);
  if (failed.length) {
    lines.push("Couldn't produce: " + failed.map(f => `${f.label}${f.reason ? ` (${f.reason})` : ''}`).join(' · '));
  }
  const open = (manifest.openRequests || []).filter(r => r && r.label);
  if (open.length) {
    lines.push(`Still working on: ${open.map(r => r.label).join(', ')} — coming in a later message`);
  }
  const stamps = stampNotice(manifest.stampsLeft);
  if (stamps) lines.push(stamps);
  return lines.join('\n');
}

export function shouldEscalate(messageBody) {
  if (!messageBody) return false;
  const lower = messageBody.toLowerCase();
  const urgentPhrases = [
    'i need help now', 'call 911', 'please help me',
    'im dying', "i'm dying", 'i am dying',
    'in the hospital', 'at the hospital', 'taken to the hospital',
    'medical emergency', 'this is urgent', 'this is an emergency',
    'i need you to call', 'come get me', 'something happened to',
  ];
  return urgentPhrases.some(p => lower.includes(p));
}

// Turn Sam's raw image request into an engineered generation prompt (GH#7).
// Iteration-aware: given the previous prompt + his refinement notes, produce
// the revised prompt. Returns { prompt, note } — note is a one-line summary of
// what the prompt emphasizes (echoed back to Sam).
export async function engineerImagePrompt(env, { intent, project, previousPrompt = null, docExcerpt = null }) {
  if (!env.ANTHROPIC_API_KEY) return { prompt: intent, note: '' };

  const system = `You write prompts for a text-to-image model (photorealistic-capable, strong at cinematic and illustration styles). Rules:
- Output STRICT JSON: {"prompt": "...", "note": "..."}
- "prompt": one paragraph, concrete and visual — subject, composition, lighting, style, mood. No camera jargon soup; no negative-prompt syntax.
- "note": one short sentence describing the key choices, written to the requester.
- Facility-safe content only: no violence/gore, no weapons glorification, no nudity/sexual content, no gang or escape imagery, nothing targeting real private individuals. If the request pushes there, steer to the nearest safe artistic treatment and say so in the note.
${previousPrompt ? '- This is an ITERATION: start from the previous prompt and apply the requested changes; keep what was not asked to change.' : ''}`;

  const userMsg = [
    previousPrompt ? `PREVIOUS PROMPT:\n${previousPrompt}` : '',
    docExcerpt ? `PROJECT CONTEXT (excerpt from the "${project}" document):\n${docExcerpt}` : '',
    `REQUEST:\n${intent}`,
  ].filter(Boolean).join('\n\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: RESPONDER_MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: userMsg }] }),
  });
  if (!resp.ok) throw new Error(`prompt-eng API ${resp.status}`);
  const data = await resp.json();
  const u = data.usage || {};
  await recordUsage(env.DB, { kind: 'prompt-eng', model: RESPONDER_MODEL, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 }).catch(() => {});
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
    if (parsed.prompt) return { prompt: parsed.prompt, note: parsed.note || '' };
  } catch { /* fall through */ }
  return { prompt: text.trim().substring(0, 1500) || intent, note: '' };
}

// Plain-language image intent resolver (grammar v2): when no strict command
// matched but the message smells like an image request, classify it.
// Returns { wantsImage, project|null, prompt|null } — conservative by design.
// Plain-language reference resolution: given candidate document names that
// appear in the body (whole-word prefilter upstream), decide which ones the
// sender actually wants used as context. Conservative — a casual mention
// ("see you monday") must not drag a document in.
export async function resolveReferences(env, { body, candidateTags = [] }) {
  if (!env.ANTHROPIC_API_KEY || !candidateTags.length) return [];
  const system = `The sender keeps named living documents. Candidate document names mentioned in this message: ${JSON.stringify(candidateTags)}.
Decide which of these documents the sender wants USED AS CONTEXT for the response (e.g. "based on my values in monday", "use what we wrote in swarm", "pull from my parole file").
Output STRICT JSON only: {"references": ["name", ...]}
- Include a name ONLY when the sender clearly wants that document's content consulted or applied.
- A casual mention — a weekday, a topic in passing, narrating events — is NOT a reference: exclude it.
- When unsure, exclude. An empty list is a fine answer.`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: RESPONDER_MODEL, max_tokens: 200, system, messages: [{ role: 'user', content: body.substring(0, 4000) }] }),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  const u = data.usage || {};
  await recordUsage(env.DB, { kind: 'intent', model: RESPONDER_MODEL, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 }).catch(() => {});
  try {
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    return (parsed.references || []).map(r => String(r).toLowerCase()).filter(r => candidateTags.includes(r));
  } catch { return []; }
}

export async function resolveImageIntent(env, { body, knownProjects = [] }) {
  if (!env.ANTHROPIC_API_KEY) return { wantsImage: false };
  const system = `You classify whether a message is asking for an IMAGE to be generated. Output STRICT JSON only:
{"wantsImage": bool, "project": "name-or-null", "prompt": "what to generate, in the sender's intent, or null"}
- wantsImage true ONLY when the sender is clearly asking you to create/make/design a picture, logo, drawing, or similar.
- project: if they tie it to one of their projects ${JSON.stringify(knownProjects)}, use that exact name (lowercase); else null.
- Mentions of images in passing (describing a scene in their writing, asking ABOUT a picture) are NOT requests: wantsImage false.`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: RESPONDER_MODEL, max_tokens: 300, system, messages: [{ role: 'user', content: body.substring(0, 4000) }] }),
  });
  if (!resp.ok) return { wantsImage: false };
  const data = await resp.json();
  const u = data.usage || {};
  await recordUsage(env.DB, { kind: 'intent', model: RESPONDER_MODEL, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 }).catch(() => {});
  try {
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    return { wantsImage: !!parsed.wantsImage, project: parsed.project || null, prompt: parsed.prompt || null };
  } catch { return { wantsImage: false }; }
}

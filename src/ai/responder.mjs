// claude API response generation

import { buildSystemPrompt, CHAR_LIMIT } from './prompt.mjs';
import { recordUsage } from '../db/usage.mjs';

const RESPONDER_MODEL = 'claude-sonnet-4-6';

export async function generateResponse(env, inboundMessage, conversationHistory, knowledgeEntries, subjectLength, topicHistory, topicName, { fullDocument = false, currentDocument = null, language = 'en', contactName = null, contactNick = null, referenceDocs = [] } = {}) {
  if (!env.ANTHROPIC_API_KEY) {
    console.log('[AI] no ANTHROPIC_API_KEY, skipping response generation');
    return null;
  }

  const nick = (contactNick || 'sam').toLowerCase();
  const systemPrompt = buildSystemPrompt(conversationHistory, knowledgeEntries, subjectLength, topicHistory, topicName, { fullDocument, currentDocument, language, contactName, contactNick: nick, referenceDocs });

  // Stream the response — big contexts (a 436K-char governing doc plus
  // references) plus web-search tool rounds can run past the gateway's ~100s
  // limit, which killed msg 449's replies with Claude API 524 (Oct 2026).
  // Streaming keeps bytes flowing; text accumulates across all text blocks.
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: RESPONDER_MODEL,
      max_tokens: 8192,
      stream: true,
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
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.log(`[AI] API error: ${resp.status} ${errText}`);
    throw new Error(`Claude API ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let responseText = '';
  let streamErr = null;
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, webSearches = 0;
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
          responseText += evt.delta.text;
        } else if (evt.type === 'message_start' && evt.message?.usage) {
          inputTokens = evt.message.usage.input_tokens || 0;
          cacheReadTokens = evt.message.usage.cache_read_input_tokens || 0;
        } else if (evt.type === 'message_delta' && evt.usage) {
          outputTokens = evt.usage.output_tokens || outputTokens;
          webSearches = evt.usage.server_tool_use?.web_search_requests || webSearches;
        } else if (evt.type === 'error') {
          streamErr = evt.error?.message || 'stream error';
        }
      } catch { /* partial JSON across chunk boundary — ignore */ }
    }
  }
  if (streamErr) throw new Error(`Claude API stream: ${streamErr}`);

  const u = { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cacheReadTokens };
  if (webSearches) console.log(`[AI] used ${webSearches} web search(es)`);
  await recordUsage(env.DB, {
    kind: 'reply', model: RESPONDER_MODEL,
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    webSearches,
  }).catch(e => console.log(`[USAGE] record failed: ${e.message}`));

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
// subject + body must be <= 20,000 chars per message
export function splitForSend(subject, body) {
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

  console.log(`[AI] split response into ${parts.length} parts: ${parts.map(p => p.body.length).join(', ')} chars`);
  return parts;
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

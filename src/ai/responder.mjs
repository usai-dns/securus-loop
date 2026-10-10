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

  const data = await resp.json();
  // with server tools in play, text arrives across multiple content blocks
  const responseText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

  const u = data.usage || {};
  const webSearches = u.server_tool_use?.web_search_requests || 0;
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

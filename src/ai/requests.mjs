// LLM side of the request ledger (v2 §3): extract discrete requests from an
// inbound message, and reconcile a drafted reply against the open set.

import { recordUsage } from '../db/usage.mjs';
import { normalizeRequests } from '../db/requests.mjs';

const MODEL = 'claude-sonnet-4-6';

async function callJson(env, { system, user, maxTokens = 1200, kind }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!resp.ok) throw new Error(`${kind} API ${resp.status}`);
  const data = await resp.json();
  const u = data.usage || {};
  await recordUsage(env.DB, { kind, model: MODEL, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 }).catch(() => {});
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : {};
}

// Extract the discrete requests in a message. `explicitImages` are directives
// already parsed deterministically (MakeImage - Label: ...); the model only
// adds image requests for asks the parser can't see (e.g. "four pictures:
// exploded, top, side, front" => four image requests in one group).
export async function extractRequests(env, { body, subject, contactNick = 'sam', knownProjects = [], docTag = null, explicitImages = [] }) {
  if (!env.ANTHROPIC_API_KEY || !body) return [];
  const system = `You turn a message from ${contactNick} into a list of discrete REQUESTS the assistant must fulfil. Output STRICT JSON only:
{"requests":[{"kind":"answer|image|doc_update|research|followup","label":"<= 8 words","spec":{...},"priority":1-9}]}
Rules:
- One request per distinct deliverable. A question with sub-parts that will be answered together is ONE "answer" request; separate topics are separate requests.
- "image": something to generate as a picture. spec = {"prompt": "complete generation prompt in the sender's words", "model": null unless the sender NAMES a model ("seedream" | "gpt-image" | "nano-banana" | "soul"), "group": "shared name when several images belong together or null", "count": 1}. A request for several distinct pictures (e.g. "four pictures: exploded diagram, top view, side view, front view") is SEVERAL image requests sharing a group, one per picture, each with its own complete prompt.
- "research": needs current web information (specs, papers, events, products) before answering.
- "doc_update": an explicit in-body instruction to change specific document content (confirm/insert/remove a rule, add X to the backlog). The MakeUpdate/MakeNew/MakeFull command line and its title or version label ("MakeUpdate Qualia", "S&Wv1.2", "10-26 A") are NOT requests — the document update is automatic. Never emit a doc_update for them.
- "followup": the sender says more is coming / wait / no reply needed — spec = {"wait": true}.
- Already-parsed image directives (tracked separately): ${JSON.stringify(explicitImages.map(i => i.label || i.prompt?.substring(0, 50)))}. Do NOT re-emit them — EXCEPT when one directive asks for SEVERAL distinct pictures: then emit one image request per picture (own prompt, shared group) and set "replaces": "<that directive's label>" on each so the umbrella entry is dropped.
- Known projects: ${JSON.stringify(knownProjects)}; current project tag: ${docTag || 'none'}.
- priority: 9 urgent/explicit deadline, 7 explicit deliverable, 5 default, 3 nice-to-have.
- Never invent requests. If the message is only conversation, return {"requests":[{"kind":"answer","label":"Reply","spec":{},"priority":5}]}.`;
  const user = `SUBJECT: ${subject || ''}\n\nMESSAGE:\n${body.substring(0, 12000)}`;
  try {
    const parsed = await callJson(env, { system, user, kind: 'request-extract' });
    return normalizeRequests(parsed.requests);
  } catch (e) {
    console.log(`[REQUESTS] extraction failed: ${e.message}`);
    return [{ kind: 'answer', label: 'Reply', spec: {}, priority: 5 }];
  }
}

// Which open non-image requests does this draft fully answer? Images are
// reconciled deterministically by the pipeline, never here.
export async function reconcileRequests(env, { draft, openRequests }) {
  const candidates = (openRequests || []).filter(r => r.kind !== 'image');
  if (!env.ANTHROPIC_API_KEY || !candidates.length || !draft) return { done: [], partial: [] };
  const system = `You check a drafted reply against a list of open requests. Output STRICT JSON only:
{"done":[ids fully satisfied by the draft],"partial":[{"id":n,"note":"what is still missing, <= 15 words"}]}
- "done" only when the draft substantively delivers the request — a mention, a promise, or "I'll cover this later" is NOT done.
- Requests the draft does not touch at all: omit from both lists.`;
  const list = candidates.map(r => `#${r.id} [${r.kind}] ${r.label}${r.spec?.prompt ? ` — ${r.spec.prompt.substring(0, 120)}` : ''}`).join('\n');
  const user = `OPEN REQUESTS:\n${list}\n\nDRAFT REPLY:\n${draft.substring(0, 30000)}`;
  try {
    const parsed = await callJson(env, { system, user, maxTokens: 600, kind: 'request-reconcile' });
    const ids = new Set(candidates.map(r => r.id));
    return {
      done: (parsed.done || []).map(Number).filter(id => ids.has(id)),
      partial: (parsed.partial || []).filter(p => ids.has(Number(p.id))).map(p => ({ id: Number(p.id), note: String(p.note || '').substring(0, 120) })),
    };
  } catch (e) {
    console.log(`[REQUESTS] reconcile failed: ${e.message}`);
    return { done: [], partial: [] };
  }
}

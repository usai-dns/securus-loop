// LLM side of the Project State registry (v2 §13): pull fact changes out of
// an exchange, and tell the document patcher which sections went stale.

import { recordUsage } from '../db/usage.mjs';
import { normalizeKey } from '../db/project_state.mjs';

const MODEL = 'claude-sonnet-4-6';

async function callJson(env, { system, user, maxTokens = 1500, kind }) {
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

// Extract state changes from the author's message plus the assistant's reply.
// Only facts that are SETTLED in this exchange: a confirmed part, a chosen
// value, an explicit correction or retraction. Questions and options are not
// state. Returns [{ key, value, action, note }].
export async function extractStateChanges(env, { tag, currentState = [], authorMessage, assistantReply, authorName = 'the author' }) {
  if (!env.ANTHROPIC_API_KEY || !authorMessage) return [];
  const current = currentState.map(r => `${r.key} = ${JSON.stringify(r.value)}`).join('\n') || '(none yet)';
  const system = `You maintain the authoritative STATE of the "${tag}" project as typed facts. Output STRICT JSON only:
{"changes":[{"key":"namespace.name","value":<json>,"action":"set|retract","note":"<= 12 words of evidence"}]}
Rules:
- Keys are dotted lowercase: hardware.rangefinder, hardware.cameras.forward, rules.battery_reposition_pct, decisions.first_test.relay_drones, software.cv_model, people.<role>, timeline.<milestone>. Reuse an existing key when the fact already exists — a changed value SUPERSEDES it.
- Values are compact JSON: a number, a string, or a small object like {"model":"Garmin LIDAR-Lite v3","range_m":40}.
- Record only facts that are settled in this exchange: ${authorName} states or confirms something, chooses between options, corrects an earlier value ("we switched to the 40m model"), or the assistant confirms a value and ${authorName} does not dispute it. Questions, proposals under discussion, and backlog ideas are NOT state.
- A correction that invalidates an old fact is a "set" with the new value on the SAME key. Use "retract" only when a fact is explicitly dropped with no replacement.
- Prefer few, high-value facts (hardware parts and specs, numeric thresholds, chosen architectures, decisions, names/roles, dates). Never invent.
- If nothing settled changed, return {"changes":[]}.

CURRENT STATE:
${current.substring(0, 8000)}`;
  const user = `${authorName.toUpperCase()}'S MESSAGE:\n${authorMessage.substring(0, 12000)}\n\n─────\n\nASSISTANT'S REPLY (facts here count only when confirmed or uncontested):\n${(assistantReply || '').substring(0, 12000)}`;
  try {
    const parsed = await callJson(env, { system, user, kind: 'state-extract' });
    return (parsed.changes || [])
      .filter(c => c && c.key && (c.action === 'retract' || c.value !== undefined))
      .map(c => ({ key: normalizeKey(c.key), value: c.value, action: c.action === 'retract' ? 'retract' : 'set', note: String(c.note || '').substring(0, 120) }))
      .filter(c => c.key.length >= 3)
      .slice(0, 40);
  } catch (e) {
    console.log(`[STATE] extraction failed for ${tag}: ${e.message}`);
    return [];
  }
}

// One-time seed for an existing project: mine the current document for its
// settled facts so the registry doesn't start empty (otherwise the 40m
// rangefinder only becomes state the next time Sam mentions it). Later
// sections win over earlier ones when the document contradicts itself.
export async function bootstrapStateFromDocument(env, { tag, document, authorName = 'the author' }) {
  if (!env.ANTHROPIC_API_KEY || !document) return [];
  const body = document.length > 110000
    ? document.substring(0, 55000) + '\n\n[... middle omitted ...]\n\n' + document.substring(document.length - 55000)
    : document;
  const system = `You are seeding the authoritative STATE registry of the "${tag}" project from its working document. Output STRICT JSON only:
{"changes":[{"key":"namespace.name","value":<json>,"action":"set","note":"<= 12 words: where in the doc"}]}
Rules:
- Keys are dotted lowercase: hardware.<part>, hardware.<part>.<attr>, rules.<name>, decisions.<topic>, software.<component>, people.<role>, timeline.<milestone>, design.<element>.
- Values are compact JSON (number, string, or a small object such as {"model":"Garmin LIDAR-Lite v3","range_m":40}).
- Record only facts the document presents as CURRENT and settled: confirmed parts and specs, numeric thresholds, chosen architectures, named decisions, people and roles, dates. When the document contradicts itself, the LATER statement wins and the note should say "supersedes earlier X".
- Skip questions, options under evaluation, backlog items, and prose explanations.
- 15–60 facts. Never invent.`;
  try {
    const parsed = await callJson(env, { system, user: `DOCUMENT:\n${body}`, maxTokens: 6000, kind: 'state-bootstrap' });
    return (parsed.changes || [])
      .filter(c => c && c.key && c.value !== undefined)
      .map(c => ({ key: normalizeKey(c.key), value: c.value, action: 'set', note: String(c.note || '').substring(0, 120) }))
      .filter(c => c.key.length >= 3)
      .slice(0, 80);
  } catch (e) {
    console.log(`[STATE] bootstrap failed for ${tag}: ${e.message}`);
    return [];
  }
}

// Build the extra instruction for buildDocumentPatch when facts changed:
// name the superseded values and the sections that still cite them.
export function consistencySweepInstruction(superseded, staleHeadings) {
  if (!(superseded || []).length) return '';
  const facts = superseded.map(s => `- ${s.key}: ${JSON.stringify(s.from)} → ${JSON.stringify(s.to)}`).join('\n');
  const where = (staleHeadings || []).length ? `Sections that still cite the old values: ${staleHeadings.join('; ')}.` : 'Scan every section for the old values.';
  return `CONSISTENCY SWEEP — these facts changed and the document must agree everywhere:\n${facts}\n${where} Update each affected section so only the new value appears (do not leave "previously X" notes in the body; the change log records history).`;
}

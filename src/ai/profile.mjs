// Contact profile document (v2 §8): one protected doc per contact, tag
// `profile`, maintained by the pipeline after each GENERATE cycle that produced
// output. Injected into every reply prompt (<contact_profile>) so replies stop
// starting cold (Sam #463 item 1). Never edited by the contact's commands.

import { recordUsage } from '../db/usage.mjs';
import { getDocument, saveDocument, setProtected, listDocumentsForContact } from '../db/documents.mjs';
import { getRecentMessages } from '../db/messages.mjs';
import { getOpenRequests, requestLabel } from '../db/requests.mjs';

export const PROFILE_TAG = 'profile';
export const PROFILE_TITLE = 'Contact profile — maintained by the assistant';
export const PROFILE_MAX_CHARS = 7000;
export const PROFILE_SECTIONS = [
  'Preferences & voice',
  'Projects index',
  'Commitments & cadence',
  'Open threads',
  'Glossary',
];

const MODEL = 'claude-sonnet-4-6';
const ARCHIVED_RE = /-archived-\d{8}/;

// Tags that are the contact's own working topics — the profile itself and
// archived copies are pipeline artifacts, not user topics.
export function isUserDocTag(tag) {
  return !!tag && tag !== PROFILE_TAG && !ARCHIVED_RE.test(tag);
}

// Pure: coerce model output into the exact five-section layout. Sections are
// matched by heading (case-insensitive, "&"/"and" interchangeable); missing
// ones are added empty, extras are dropped, and the result is capped at
// PROFILE_MAX_CHARS (last section trimmed first, never a heading).
export function normalizeProfile(text) {
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/```[a-z]*\n?|```/g, '');
  const bodies = new Map();
  let current = null;
  const canon = (h) => h.toLowerCase().replace(/\band\b/g, '&').replace(/[^a-z&]+/g, '');
  const wanted = new Map(PROFILE_SECTIONS.map(s => [canon(s), s]));
  for (const line of src.split('\n')) {
    const h = line.match(/^\s*#{1,3}\s+(.+?)\s*#*\s*$/);
    if (h) {
      const key = wanted.get(canon(h[1]));
      current = key || null;
      if (key && !bodies.has(key)) bodies.set(key, []);
      continue;
    }
    if (current) bodies.get(current).push(line);
  }
  const sections = PROFILE_SECTIONS.map(h => {
    const body = (bodies.get(h) || []).join('\n').trim();
    return { heading: h, body: body || '(nothing recorded yet)' };
  });
  let out = sections.map(s => `## ${s.heading}\n\n${s.body}`).join('\n\n');
  for (let i = sections.length - 1; out.length > PROFILE_MAX_CHARS && i >= 0; i--) {
    const over = out.length - PROFILE_MAX_CHARS;
    const keep = Math.max(0, sections[i].body.length - over - 2);
    sections[i].body = keep ? sections[i].body.substring(0, keep).trimEnd() + ' …' : '…';
    out = sections.map(s => `## ${s.heading}\n\n${s.body}`).join('\n\n');
  }
  return out;
}

// Pure: the material the model sees. Exposed for tests / dry runs.
export function buildProfileInput({ current, docs, messages, openRequests, contactId }) {
  const docList = (docs || []).filter(d => isUserDocTag(d.tag))
    .map(d => `- ${d.tag} — "${d.title || d.tag}" (v${d.version}, ${(d.length || 0).toLocaleString()} chars)`).join('\n') || '(no documents)';
  const msgList = (messages || []).slice().reverse().map(m => {
    const who = m.direction === 'inbound' ? contactId : 'dennis';
    const when = (m.timestamp || '').substring(0, 10);
    return `[${when}] ${who}: "${m.subject || ''}" — ${(m.body || '').replace(/\s+/g, ' ').substring(0, 400)}`;
  }).join('\n') || '(no messages)';
  const reqList = (openRequests || []).map(r => `- ${requestLabel(r)} (${r.kind}, ${r.status})`).join('\n') || '(none)';
  return `CURRENT PROFILE (may be empty):\n${current || '(none yet)'}\n\n─────\nDOCUMENTS:\n${docList}\n\n─────\nRECENT MESSAGES (oldest first; subject — first 400 chars):\n${msgList}\n\n─────\nOPEN REQUESTS:\n${reqList}`;
}

// One LLM call → the refreshed profile → saved as the protected `profile`
// document. Returns { version, chars } or null when nothing could be built.
export async function refreshProfile(env, contactId) {
  if (!env.ANTHROPIC_API_KEY || !contactId) return null;
  const existing = await getDocument(env.DB, contactId, PROFILE_TAG);
  const docs = await listDocumentsForContact(env.DB, contactId);
  const messages = await getRecentMessages(env.DB, 12, contactId);
  const openRequests = await getOpenRequests(env.DB, contactId, { limit: 20 });

  const system = `You maintain a continuity file about ${contactId} for an assistant that writes to ${contactId} as "Dennis" through a prison messaging platform. Rewrite the profile from the material given. Output STRICT MARKDOWN with exactly these five level-2 headings, in this order, and nothing before the first heading:
## Preferences & voice
## Projects index
## Commitments & cadence
## Open threads
## Glossary
Rules:
- Preferences & voice: how ${contactId} likes replies (length, tone, format, what annoys him), stated preferences only — cite the message date in parentheses when known.
- Projects index: one line per document/project: tag, one-line description, last activity date, status (active / paused / archived).
- Commitments & cadence: standing agreements, scheduled check-ins, things Dennis said he would do regularly.
- Open threads: unresolved questions or deliverables still owed, one line each, newest first.
- Glossary: ${contactId}'s own terms, names and abbreviations with a short gloss.
- Keep what is still true from the current profile; update or drop what the new material contradicts. Never invent facts. Terse bullet points. Total length under ${PROFILE_MAX_CHARS} characters.`;

  const user = buildProfileInput({ current: existing?.content, docs, messages, openRequests, contactId });
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, system, messages: [{ role: 'user', content: user.substring(0, 60000) }] }),
  });
  if (!resp.ok) throw new Error(`profile API ${resp.status}: ${(await resp.text()).substring(0, 160)}`);
  const data = await resp.json();
  const u = data.usage || {};
  await recordUsage(env.DB, { kind: 'profile', model: MODEL, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 }).catch(() => {});
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const content = normalizeProfile(text);
  if (!content || /^(## [^\n]+\n\n\(nothing recorded yet\)\n*)+$/.test(content)) return null;

  // force: the profile is protected against command paths, not against its
  // own maintainer
  const version = await saveDocument(env.DB, {
    contactId, tag: PROFILE_TAG, title: PROFILE_TITLE, content,
    changeNote: `profile refresh (${content.length} chars)`, force: true,
  });
  await setProtected(env.DB, contactId, PROFILE_TAG, true);
  console.log(`[PROFILE] ${contactId} → v${version} (${content.length} chars)`);
  return { version, chars: content.length };
}

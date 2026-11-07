// Project upgrade to v2 (V2_ARCHITECTURE §6, §13): carry an existing
// document into the sectioned/attributed model, seed its state registry from
// the current text, back-fill the entries ledger from message history, and
// sweep sections that contradict the seeded facts. Idempotent per step.

import { getSections, saveSections, appendEntry, getEntries, applyPatch, renderSections, listDocumentsForContact } from '../db/documents.mjs';
import { getMessagesByDocTag } from '../db/messages.mjs';
import { getCurrentState, applyStateChanges, sectionsCitingStale } from '../db/project_state.mjs';
import { bootstrapStateFromDocument, extractStateChanges, consistencySweepInstruction } from '../ai/state.mjs';
import { buildDocumentPatch } from '../ai/responder.mjs';

const SKIP_TAGS = new Set(['profile']);
const SKIP_TAG_RE = /-archived-\d{8}/;

// Which of a contact's documents are live projects (not protected references,
// archives, or the profile). Pure.
export function upgradeableTags(docs) {
  return (docs || [])
    .filter(d => d && d.tag && !d.protected && !SKIP_TAGS.has(d.tag) && !SKIP_TAG_RE.test(d.tag))
    .map(d => d.tag);
}

// One ledger entry per message in the project's history. Pure.
export function entriesFromMessages(messages, contactId) {
  return (messages || []).map(m => ({
    author: m.direction === 'inbound' ? contactId : 'ai',
    entryDate: String(m.timestamp || m.created_at || '').substring(0, 10) || null,
    inboundId: m.direction === 'inbound' ? m.id : null,
    outboundId: m.direction === 'outbound' ? m.id : null,
    summary: String(m.subject || '').substring(0, 200),
    content: String(m.body || '').substring(0, 20000),
  })).filter(e => e.entryDate);
}

// The ledger in send order, paired: each contact entry with the AI entry that
// answered it (same inbound id, else the next AI entry). Pure.
export function pairEntries(rowsAsc) {
  const pairs = [];
  const ai = (rowsAsc || []).filter(r => r.author === 'ai');
  for (const r of rowsAsc || []) {
    if (r.author === 'ai') continue;
    const reply = ai.find(a => a.inbound_id && a.inbound_id === r.inbound_id) || ai.find(a => a.id > r.id);
    pairs.push({ author: r, reply: reply || null });
  }
  return pairs;
}

// Replay the project's history through state extraction, oldest → newest,
// so the registry ends on the latest settled values (a doc-derived seed can
// be stale: Swarm's text still said TFmini-S 12m after the Garmin 40m call).
async function replayHistory(env, { contactId, tag, limit = 40, from = null }) {
  const res = await env.DB.prepare(
    "SELECT id, author, entry_date, inbound_id, content FROM document_entries WHERE contact_id = ? AND tag = ? ORDER BY id ASC"
  ).bind(contactId, tag).all();
  const all = pairEntries(res.results || []);
  // chunked mode (from = index into the chronological pair list) lets a long
  // replay run as several short synchronous calls instead of one background job
  const pairs = from === null ? all.slice(-limit) : all.slice(from, from + limit);
  const superseded = [];
  let applied = 0, exchanges = 0;
  const total = all.length;
  const nextFrom = from === null ? null : (from + limit < total ? from + limit : null);
  for (const p of pairs) {
    if (!p.author?.content) continue;
    exchanges++;
    const current = await getCurrentState(env.DB, contactId, tag);
    const changes = await extractStateChanges(env, {
      tag, currentState: current,
      authorMessage: p.author.content, assistantReply: p.reply?.content || '', authorName: contactId,
    });
    if (!changes.length) continue;
    const out = await applyStateChanges(env.DB, { contactId, tag, changes, inboundId: p.author.inbound_id || null, author: contactId });
    applied += out.set.length + out.superseded.length;
    superseded.push(...out.superseded);
  }
  return { exchanges, applied, superseded, total, nextFrom };
}

// Every fact the registry has superseded, paired with its current value —
// the sweep input when the replay already happened in an earlier run.
async function supersededFromRegistry(env, contactId, tag) {
  const res = await env.DB.prepare(
    "SELECT key, value, status FROM project_state WHERE contact_id = ? AND tag = ? AND status IN ('current','superseded') ORDER BY id ASC"
  ).bind(contactId, tag).all();
  const current = new Map(), old = new Map();
  for (const r of res.results || []) {
    let v; try { v = JSON.parse(r.value); } catch { v = r.value; }
    if (r.status === 'current') current.set(r.key, v); else old.set(r.key, v);   // latest superseded wins (ASC order)
  }
  const out = [];
  for (const [key, from] of old) if (current.has(key)) out.push({ key, from, to: current.get(key) });
  return out;
}

// Steps: sections → entries → state → history → sweep. `options` can switch
// steps off (e.g. { sweep: false } for a dry pass). `registrySweep` sweeps
// against every supersession already recorded (use after an interrupted
// history replay). Returns a per-step report.
export async function upgradeProject(env, { contactId, tag, sections = true, entries = true, state = true, history = false, historyLimit = 40, historyFrom = null, sweep = true, registrySweep = false } = {}) {
  const report = { contactId, tag, steps: {} };
  const cur = await getSections(env.DB, contactId, tag);
  if (!cur) return { ...report, error: 'document not found' };
  if (cur.protected) return { ...report, error: 'protected document — not upgraded' };
  const today = new Date().toISOString().slice(0, 10);

  // 1. persist sections (lazy split → stored JSON) once
  if (sections) {
    if (cur.derived) {
      const version = await saveSections(env.DB, {
        contactId, tag, title: cur.title, sections: cur.sections,
        changelogEntry: `Migrated to v2: ${cur.sections.length} sections, change log and entries ledger started`,
        changeNote: 'v2 migration: sections', date: today,
      });
      report.steps.sections = { migrated: true, count: cur.sections.length, version };
    } else {
      report.steps.sections = { migrated: false, count: cur.sections.length, note: 'already sectioned' };
    }
  }

  // 2. back-fill entries from message history (skip if any entries exist)
  if (entries) {
    const existing = await getEntries(env.DB, contactId, tag, { limit: 1 });
    if (existing.length) {
      report.steps.entries = { added: 0, note: 'ledger already has entries' };
    } else {
      const msgs = await getMessagesByDocTag(env.DB, contactId, tag);
      const rows = entriesFromMessages(msgs, contactId);
      for (const e of rows) await appendEntry(env.DB, { contactId, tag, ...e });
      report.steps.entries = { added: rows.length };
    }
  }

  // 3. seed state from the document (skip if the registry already has facts)
  let superseded = [];
  if (state) {
    const have = await getCurrentState(env.DB, contactId, tag);
    if (have.length) {
      report.steps.state = { seeded: 0, note: `registry already has ${have.length} facts` };
    } else {
      const latest = await getSections(env.DB, contactId, tag);
      const changes = await bootstrapStateFromDocument(env, { tag, document: renderSections(latest.sections), authorName: contactId });
      const applied = await applyStateChanges(env.DB, { contactId, tag, changes, author: 'bootstrap' });
      superseded = applied.superseded;
      report.steps.state = { seeded: applied.set.length + applied.superseded.length, superseded: applied.superseded.length, keys: changes.map(c => c.key).slice(0, 60) };
    }
  }

  // 3b. replay the conversation history so decisions made in messages (and
  //     never fully propagated into the text) supersede doc-derived facts
  if (history) {
    const h = await replayHistory(env, { contactId, tag, limit: historyLimit, from: historyFrom });
    superseded.push(...h.superseded);
    report.steps.history = { exchanges: h.exchanges, total: h.total, nextFrom: h.nextFrom, applied: h.applied, superseded: h.superseded.map(s => `${s.key}: ${JSON.stringify(s.from)} → ${JSON.stringify(s.to)}`).slice(0, 40) };
  }

  if (registrySweep) {
    const fromRegistry = await supersededFromRegistry(env, contactId, tag);
    const seen = new Set(superseded.map(s => s.key));
    for (const s of fromRegistry) if (!seen.has(s.key)) superseded.push(s);
    report.steps.registrySweep = { supersededKeys: fromRegistry.map(s => s.key) };
  }

  // 4. consistency sweep: sections still citing values found to be superseded
  //    (the doc contradicted itself, or history moved past the text)
  if (sweep && superseded.length) {
    const latest = await getSections(env.DB, contactId, tag);
    const stale = sectionsCitingStale(latest.sections, superseded);
    if (stale.length) {
      const instruction = consistencySweepInstruction(superseded, stale);
      const { patch, changelog } = await buildDocumentPatch(env, {
        tag, title: latest.title, sections: latest.sections,
        newMaterial: `${instruction}\n\nNo new material — this is a consistency pass only. Touch ONLY the sections named above.`,
        command: 'makeupdate', authorName: contactId, entryDate: today,
      });
      const next = applyPatch(latest.sections, patch);
      const version = await saveSections(env.DB, {
        contactId, tag, title: latest.title, sections: next,
        changelogEntry: `Consistency sweep: ${changelog || superseded.map(s => s.key).join(', ')}`,
        changeNote: 'v2 migration: consistency sweep', date: today,
      });
      await appendEntry(env.DB, { contactId, tag, author: 'ai', entryDate: today, summary: 'v2 migration consistency sweep', content: `Superseded facts corrected in: ${stale.join('; ')}\n\n${superseded.map(s => `${s.key}: ${JSON.stringify(s.from)} → ${JSON.stringify(s.to)}`).join('\n')}` });
      report.steps.sweep = { sections: stale, version };
    } else {
      report.steps.sweep = { sections: [], note: 'no stale citations found' };
    }
  } else if (sweep) {
    report.steps.sweep = { sections: [], note: superseded.length ? 'skipped' : 'nothing superseded during bootstrap' };
  }

  return report;
}

// All live projects for a contact, one after another (each is several LLM
// calls on a 130K-char doc — run from an admin endpoint, never from cron).
export async function upgradeAllProjects(env, contactId, options = {}) {
  const docs = await listDocumentsForContact(env.DB, contactId);
  const tags = upgradeableTags(docs);
  const reports = [];
  for (const tag of tags) {
    try { reports.push(await upgradeProject(env, { contactId, tag, ...options })); }
    catch (e) { reports.push({ contactId, tag, error: e.message }); }
  }
  return { contactId, tags, reports };
}

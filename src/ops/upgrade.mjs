// Project upgrade to v2 (V2_ARCHITECTURE §6, §13): carry an existing
// document into the sectioned/attributed model, seed its state registry from
// the current text, back-fill the entries ledger from message history, and
// sweep sections that contradict the seeded facts. Idempotent per step.

import { getSections, saveSections, appendEntry, getEntries, applyPatch, renderSections, listDocumentsForContact } from '../db/documents.mjs';
import { getMessagesByDocTag } from '../db/messages.mjs';
import { getCurrentState, applyStateChanges, sectionsCitingStale } from '../db/project_state.mjs';
import { bootstrapStateFromDocument, consistencySweepInstruction } from '../ai/state.mjs';
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

// Steps: sections → entries → state → sweep. `options` can switch steps off
// (e.g. { sweep: false } for a dry pass). Returns a per-step report.
export async function upgradeProject(env, { contactId, tag, sections = true, entries = true, state = true, sweep = true } = {}) {
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

  // 4. consistency sweep: sections still citing values the bootstrap found to
  //    be superseded (the doc contradicted itself — later statement won)
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

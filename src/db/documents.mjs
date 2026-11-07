// Governing documents: the single living body per (contact, topic) that the AI
// edits in place. The `messages` stream holds the edits; `documents` holds the
// result. Every function is scoped by contact_id so contacts never mix.

import { DEFAULT_CONTACT } from './contacts.mjs';

export function docTitle(tag) {
  const name = (tag || '').charAt(0).toUpperCase() + (tag || '').slice(1);
  return `${name} — working document`;
}

export async function getDocument(db, contactId, tag) {
  return db.prepare("SELECT * FROM documents WHERE contact_id = ? AND tag = ?")
    .bind(contactId || DEFAULT_CONTACT, tag).first();
}

export async function listDocuments(db, contactId = null) {
  if (contactId) {
    return (await db.prepare(
      "SELECT contact_id, tag, title, version, source_count, length(content) as body_len, updated_at FROM documents WHERE contact_id = ? ORDER BY updated_at DESC"
    ).bind(contactId).all()).results;
  }
  return (await db.prepare(
    "SELECT contact_id, tag, title, version, source_count, length(content) as body_len, updated_at FROM documents ORDER BY updated_at DESC"
  ).all()).results;
}

export async function getDocumentVersions(db, contactId, tag) {
  return (await db.prepare(
    "SELECT version, change_note, message_id, length(content) as body_len, created_at FROM document_versions WHERE contact_id = ? AND tag = ? ORDER BY version DESC"
  ).bind(contactId || DEFAULT_CONTACT, tag).all()).results;
}

// Upsert the document body and snapshot the new version. Returns the new version.
// A `protected` document (archive, imported reference such as qualia-bible)
// refuses writes unless `force` is passed — admin imports only, never a
// command path.
export async function saveDocument(db, { contactId, tag, title, content, changeNote, messageId, force = false }) {
  const cid = contactId || DEFAULT_CONTACT;
  const existing = await getDocument(db, cid, tag);
  if (existing?.protected && !force) throw new Error(`document "${cid}/${tag}" is protected (read-only)`);
  const version = existing ? existing.version + 1 : 1;
  const sourceCount = (existing?.source_count || 0) + 1;
  const finalTitle = title || existing?.title || docTitle(tag);

  if (existing) {
    await db.prepare(
      `UPDATE documents SET title = ?, content = ?, version = ?, source_count = ?,
       last_message_id = ?, updated_at = datetime('now') WHERE contact_id = ? AND tag = ?`
    ).bind(finalTitle, content, version, sourceCount, messageId || null, cid, tag).run();
  } else {
    await db.prepare(
      `INSERT INTO documents (contact_id, tag, title, content, version, source_count, last_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(cid, tag, finalTitle, content, version, sourceCount, messageId || null).run();
  }

  await db.prepare(
    `INSERT OR REPLACE INTO document_versions (contact_id, tag, version, content, change_note, message_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(cid, tag, version, content, changeNote || null, messageId || null).run();

  return version;
}

// A short human-readable change note from the size delta and command.
export function changeNoteFor(command, prevLen, newLen) {
  const delta = newLen - prevLen;
  const sign = delta >= 0 ? '+' : '';
  if (command === 'makenew') return `created (${newLen.toLocaleString()} chars)`;
  return `updated · ${sign}${delta.toLocaleString()} chars → ${newLen.toLocaleString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents v2 — sections + provenance ledger (docs/V2_ARCHITECTURE.md §6).
//
// A document is an ordered list of sections [{ heading, body }] rendered to
// `content` for every existing reader, a dated `changelog` (newest first), and
// a `document_entries` ledger that records who contributed what and when. The
// AI never rewrites the whole body any more: it returns a patch touching only
// the sections that change (responder.mjs::buildDocumentPatch), applied here.
// ─────────────────────────────────────────────────────────────────────────────

const OVERVIEW_HEADING = 'Overview';
const SINGLE_HEADING = 'Document';

// Markdown headings are only headings outside fenced code blocks — a "## x"
// line inside ``` … ``` is body text.
function headingLines(lines) {
  const found = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = line.match(/^(#{1,2})\s+(.+?)\s*$/);
    if (h) found.push({ idx: i, level: h[1].length, heading: h[2].replace(/\s+#+$/, '').trim() });
  }
  return found;
}

// Split markdown into ordered sections on "## " lines (or "# " when the doc has
// no level-2 headings). Text before the first heading → "Overview"; a doc with
// no headings at all → one "Document" section. Pure.
export function splitIntoSections(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const all = headingLines(lines);
  const level = all.some(h => h.level === 2) ? 2 : all.some(h => h.level === 1) ? 1 : 0;
  if (!level) return [{ heading: SINGLE_HEADING, body: text.trim() }];

  const heads = all.filter(h => h.level === level);
  const sections = [];
  const pre = lines.slice(0, heads[0].idx).join('\n').trim();
  if (pre) sections.push({ heading: OVERVIEW_HEADING, body: pre });
  for (let k = 0; k < heads.length; k++) {
    const end = k + 1 < heads.length ? heads[k + 1].idx : lines.length;
    sections.push({ heading: heads[k].heading, body: lines.slice(heads[k].idx + 1, end).join('\n').trim() });
  }
  return sections;
}

// Join sections back to markdown: "## heading\n\nbody" blocks. Pure.
export function renderSections(sections) {
  return (sections || [])
    .filter(s => s && s.heading)
    .map(s => [`## ${cleanHeading(s.heading)}`, String(s.body || '').trim()].filter(Boolean).join('\n\n'))
    .join('\n\n');
}

// Heading identity for patching: case- and whitespace-insensitive, tolerant of
// a model echoing the markdown marker ("## Characters").
export function normalizeHeading(heading) {
  return cleanHeading(heading).toLowerCase();
}

function cleanHeading(heading) {
  return String(heading || '').replace(/^\s*#+\s*/, '').replace(/\s+/g, ' ').trim();
}

// Apply a patch { section_updates, new_sections, remove_sections } to a
// sections array and return the NEW array (input untouched). Updates replace
// the body of the named section; an update naming an unknown heading is
// appended as a new section (material is never lost); new sections append or
// insert after `after`; a new section whose heading already exists replaces
// that body instead of duplicating the heading. Only remove_sections drops
// anything. Pure.
export function applyPatch(sections, patch) {
  const out = (sections || []).filter(s => s && s.heading).map(s => ({ heading: s.heading, body: String(s.body || '') }));
  const p = patch || {};
  const find = (h) => { const n = normalizeHeading(h); return n ? out.findIndex(s => normalizeHeading(s.heading) === n) : -1; };

  for (const u of p.section_updates || []) {
    if (!u || !cleanHeading(u.heading)) continue;
    const i = find(u.heading);
    if (i >= 0) out[i].body = String(u.body ?? '');
    else out.push({ heading: cleanHeading(u.heading), body: String(u.body ?? '') });
  }
  for (const n of p.new_sections || []) {
    if (!n || !cleanHeading(n.heading)) continue;
    const existing = find(n.heading);
    if (existing >= 0) { out[existing].body = String(n.body ?? ''); continue; }
    const sec = { heading: cleanHeading(n.heading), body: String(n.body ?? '') };
    const at = n.after ? find(n.after) : -1;
    if (at >= 0) out.splice(at + 1, 0, sec); else out.push(sec);
  }
  for (const r of p.remove_sections || []) {
    const i = find(typeof r === 'string' ? r : r?.heading);
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

export function isoDate(date) {
  const d = date instanceof Date ? date : date ? new Date(date) : new Date();
  return (isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10);
}

// Changelog is plain text, newest entry first, one "- YYYY-MM-DD (vN): …" line
// per edit (continuation lines indented). Pure.
export function prependChangelog(changelog, entry, { date, version } = {}) {
  const text = String(entry || '').trim();
  if (!text) return changelog || '';
  const line = `- ${isoDate(date)}${version ? ` (v${version})` : ''}: ${text.replace(/\n+/g, '\n  ')}`;
  return changelog ? `${line}\n${changelog}` : line;
}

// Current sections for a (contact, tag) — parsed from the `sections` column, or
// derived from `content` when the column is still null (lazy migration: the
// first saveSections persists them). Returns null when the doc does not exist.
export async function getSections(db, contactId, tag) {
  const doc = await getDocument(db, contactId, tag);
  if (!doc) return null;
  let sections = null;
  if (doc.sections) {
    try { sections = JSON.parse(doc.sections); } catch { sections = null; }
  }
  const derived = !Array.isArray(sections) || !sections.length;
  if (derived) sections = splitIntoSections(doc.content || '');
  return {
    sections, derived,
    changelog: doc.changelog || '',
    protected: !!doc.protected,
    title: doc.title, version: doc.version, doc,
  };
}

// Persist sections: renders `content`, bumps the version + snapshot exactly like
// saveDocument (it IS saveDocument), then stores the sections JSON and the
// changelog with the new dated entry prepended. Throws on a protected doc.
export async function saveSections(db, { contactId, tag, title, sections, changelogEntry, changeNote, messageId, date }) {
  const cid = contactId || DEFAULT_CONTACT;
  const existing = await getDocument(db, cid, tag);
  if (existing?.protected) throw new Error(`document "${cid}/${tag}" is protected (read-only)`);
  const clean = (sections || []).filter(s => s && cleanHeading(s.heading)).map(s => ({ heading: cleanHeading(s.heading), body: String(s.body || '') }));
  const content = renderSections(clean);
  const version = await saveDocument(db, {
    contactId: cid, tag, title, content, messageId,
    changeNote: changeNote || (changelogEntry ? String(changelogEntry).split('\n')[0].substring(0, 200) : null),
  });
  const changelog = prependChangelog(existing?.changelog, changelogEntry, { date, version });
  await db.prepare("UPDATE documents SET sections = ?, changelog = ? WHERE contact_id = ? AND tag = ?")
    .bind(JSON.stringify(clean), changelog, cid, tag).run();
  return version;
}

// ── provenance ledger ──
// author: 'ai' for the assistant, otherwise the contact id ('sam', 'ricardo').

export async function appendEntry(db, { contactId, tag, author, entryDate, inboundId, outboundId, summary, content }) {
  const cid = contactId || DEFAULT_CONTACT;
  if (!tag || !author) throw new Error('appendEntry: tag and author are required');
  const r = await db.prepare(
    `INSERT INTO document_entries (contact_id, tag, entry_date, author, inbound_id, outbound_id, summary, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(cid, tag, isoDate(entryDate), author, inboundId ?? null, outboundId ?? null, summary ?? null, content ?? null).run();
  return r.meta?.last_row_id ?? null;
}

export async function getEntries(db, contactId, tag, { limit = 50 } = {}) {
  return (await db.prepare(
    `SELECT id, entry_date, author, inbound_id, outbound_id, summary, content, length(content) as content_len, created_at
     FROM document_entries WHERE contact_id = ? AND tag = ? ORDER BY id DESC LIMIT ?`
  ).bind(contactId || DEFAULT_CONTACT, tag, limit).all()).results;
}

// ── protection + archive ──

export async function isProtected(db, contactId, tag) {
  const row = await db.prepare("SELECT protected FROM documents WHERE contact_id = ? AND tag = ?")
    .bind(contactId || DEFAULT_CONTACT, tag).first();
  return !!row?.protected;
}

export async function setProtected(db, contactId, tag, flag) {
  await db.prepare("UPDATE documents SET protected = ? WHERE contact_id = ? AND tag = ?")
    .bind(flag ? 1 : 0, contactId || DEFAULT_CONTACT, tag).run();
}

// Archive tag naming: `${tag}-archived-YYYYMMDD`, then `-2`, `-3`… when taken. Pure.
export function archiveTagFor(tag, date, n = 1) {
  const base = `${tag}-archived-${isoDate(date).replace(/-/g, '')}`;
  return n > 1 ? `${base}-${n}` : base;
}

// MakeNew on an existing tag never overwrites: the current doc, its version
// snapshots and its ledger entries are renamed to the archive tag, which is
// marked protected. Returns the archive tag (null when there is nothing to archive).
export async function archiveDocument(db, contactId, tag, { date } = {}) {
  const cid = contactId || DEFAULT_CONTACT;
  const doc = await getDocument(db, cid, tag);
  if (!doc) return null;
  let n = 1, archiveTag = archiveTagFor(tag, date, n);
  while (await getDocument(db, cid, archiveTag)) archiveTag = archiveTagFor(tag, date, ++n);
  const title = `${doc.title || docTitle(tag)} (archived ${isoDate(date)})`;
  await db.batch([
    db.prepare("UPDATE documents SET tag = ?, title = ?, protected = 1, updated_at = datetime('now') WHERE contact_id = ? AND tag = ?")
      .bind(archiveTag, title, cid, tag),
    db.prepare("UPDATE document_versions SET tag = ? WHERE contact_id = ? AND tag = ?").bind(archiveTag, cid, tag),
    db.prepare("UPDATE document_entries SET tag = ? WHERE contact_id = ? AND tag = ?").bind(archiveTag, cid, tag),
  ]);
  return archiveTag;
}

export async function listDocumentsForContact(db, contactId) {
  const rows = (await db.prepare(
    "SELECT tag, title, protected, version, length(content) as length FROM documents WHERE contact_id = ? ORDER BY tag"
  ).bind(contactId || DEFAULT_CONTACT).all()).results;
  return rows.map(r => ({ tag: r.tag, title: r.title, protected: !!r.protected, version: r.version, length: r.length }));
}

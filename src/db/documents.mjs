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
export async function saveDocument(db, { contactId, tag, title, content, changeNote, messageId }) {
  const cid = contactId || DEFAULT_CONTACT;
  const existing = await getDocument(db, cid, tag);
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

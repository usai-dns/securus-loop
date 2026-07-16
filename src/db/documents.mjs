// Governing documents: the single living body per topic that the AI edits in
// place. The `messages` stream holds the edits; `documents` holds the result.

export function docTitle(tag) {
  const name = (tag || '').charAt(0).toUpperCase() + (tag || '').slice(1);
  return `${name} — working document`;
}

export async function getDocument(db, tag) {
  return db.prepare("SELECT * FROM documents WHERE tag = ?").bind(tag).first();
}

export async function listDocuments(db) {
  return (await db.prepare(
    "SELECT tag, title, version, source_count, length(content) as body_len, updated_at FROM documents ORDER BY updated_at DESC"
  ).all()).results;
}

export async function getDocumentVersions(db, tag) {
  return (await db.prepare(
    "SELECT version, change_note, message_id, length(content) as body_len, created_at FROM document_versions WHERE tag = ? ORDER BY version DESC"
  ).bind(tag).all()).results;
}

// Upsert the document body and snapshot the new version. Returns the new version.
export async function saveDocument(db, { tag, title, content, changeNote, messageId }) {
  const existing = await getDocument(db, tag);
  const version = existing ? existing.version + 1 : 1;
  const sourceCount = (existing?.source_count || 0) + 1;
  const finalTitle = title || existing?.title || docTitle(tag);

  if (existing) {
    await db.prepare(
      `UPDATE documents SET title = ?, content = ?, version = ?, source_count = ?,
       last_message_id = ?, updated_at = datetime('now') WHERE tag = ?`
    ).bind(finalTitle, content, version, sourceCount, messageId || null, tag).run();
  } else {
    await db.prepare(
      `INSERT INTO documents (tag, title, content, version, source_count, last_message_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(tag, finalTitle, content, version, sourceCount, messageId || null).run();
  }

  await db.prepare(
    `INSERT OR REPLACE INTO document_versions (tag, version, content, change_note, message_id)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(tag, version, content, changeNote || null, messageId || null).run();

  return version;
}

// A short human-readable change note from the size delta and command.
export function changeNoteFor(command, prevLen, newLen) {
  const delta = newLen - prevLen;
  const sign = delta >= 0 ? '+' : '';
  if (command === 'makenew') return `created (${newLen.toLocaleString()} chars)`;
  return `updated · ${sign}${delta.toLocaleString()} chars → ${newLen.toLocaleString()}`;
}

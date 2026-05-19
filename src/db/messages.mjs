// D1 message operations

export async function messageExists(db, externalId) {
  if (!externalId) return false;
  const result = await db.prepare(
    'SELECT id FROM messages WHERE external_id = ?'
  ).bind(externalId).first();
  return !!result;
}

export async function getMessageByExternalId(db, externalId) {
  if (!externalId) return null;
  return await db.prepare(
    'SELECT * FROM messages WHERE external_id = ?'
  ).bind(externalId).first();
}

export async function saveMessage(db, { externalId, direction, sender, subject, body, timestamp, docTag }) {
  const result = await db.prepare(
    `INSERT INTO messages (external_id, direction, sender, subject, body, timestamp, doc_tag)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    externalId || null,
    direction,
    sender,
    subject || '',
    body,
    timestamp || new Date().toISOString(),
    docTag || null
  ).run();
  return result.meta.last_row_id;
}

export async function getMessagesByDocTag(db, docTag) {
  if (!docTag) {
    // general conversation — no doc_tag
    const results = await db.prepare(
      'SELECT * FROM messages WHERE doc_tag IS NULL ORDER BY id ASC'
    ).all();
    return results.results;
  }
  const results = await db.prepare(
    'SELECT * FROM messages WHERE doc_tag = ? ORDER BY id ASC'
  ).bind(docTag).all();
  return results.results;
}

export async function getAllDocTags(db) {
  const results = await db.prepare(
    "SELECT DISTINCT doc_tag FROM messages WHERE doc_tag IS NOT NULL ORDER BY doc_tag ASC"
  ).all();
  return results.results.map(r => r.doc_tag);
}

export async function getAllMessages(db) {
  const results = await db.prepare(
    'SELECT * FROM messages ORDER BY id ASC'
  ).all();
  return results.results;
}

export async function markResponded(db, messageId, responseId) {
  await db.prepare(
    'UPDATE messages SET responded_at = datetime(\'now\'), response_id = ? WHERE id = ?'
  ).bind(responseId, messageId).run();
}

export async function getRecentMessages(db, limit = 20) {
  const results = await db.prepare(
    'SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?'
  ).bind(limit).all();
  return results.results;
}

export async function getUnrespondedInbound(db) {
  const results = await db.prepare(
    `SELECT * FROM messages
     WHERE direction = 'inbound' AND response_id IS NULL AND responded_at IS NULL
     ORDER BY timestamp ASC`
  ).all();
  return results.results;
}

export async function resetResponse(db, messageId) {
  await db.prepare(
    'UPDATE messages SET responded_at = NULL, response_id = NULL WHERE id = ?'
  ).bind(messageId).run();
}

export async function markConfirmedSent(db, outboundId) {
  await db.prepare(
    "UPDATE messages SET confirmed_sent = datetime('now') WHERE id = ?"
  ).bind(outboundId).run();
}

export async function getUnconfirmedOutbound(db) {
  const results = await db.prepare(
    `SELECT * FROM messages
     WHERE direction = 'outbound' AND confirmed_sent IS NULL
     ORDER BY id ASC`
  ).all();
  return results.results;
}

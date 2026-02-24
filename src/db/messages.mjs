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

export async function saveMessage(db, { externalId, direction, sender, subject, body, timestamp }) {
  const result = await db.prepare(
    `INSERT INTO messages (external_id, direction, sender, subject, body, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    externalId || null,
    direction,
    sender,
    subject || '',
    body,
    timestamp || new Date().toISOString()
  ).run();
  return result.meta.last_row_id;
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
     WHERE direction = 'inbound' AND responded_at IS NULL
     ORDER BY timestamp ASC`
  ).all();
  return results.results;
}

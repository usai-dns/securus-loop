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

export async function saveMessage(db, { externalId, contactId, direction, sender, subject, body, timestamp, docTag }) {
  const result = await db.prepare(
    `INSERT INTO messages (external_id, contact_id, direction, sender, subject, body, timestamp, doc_tag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    externalId || null,
    contactId || 'sam',
    direction,
    sender,
    subject || '',
    body,
    timestamp || new Date().toISOString(),
    docTag || null
  ).run();
  return result.meta.last_row_id;
}

// Scoped to one contact. docTag null → the contact's general (untagged) messages.
export async function getMessagesByDocTag(db, contactId, docTag) {
  if (!docTag) {
    const results = await db.prepare(
      'SELECT * FROM messages WHERE contact_id = ? AND doc_tag IS NULL ORDER BY id ASC'
    ).bind(contactId).all();
    return results.results;
  }
  const results = await db.prepare(
    'SELECT * FROM messages WHERE contact_id = ? AND doc_tag = ? ORDER BY id ASC'
  ).bind(contactId, docTag).all();
  return results.results;
}

export async function getAllDocTags(db, contactId = null) {
  const results = contactId
    ? await db.prepare("SELECT DISTINCT doc_tag FROM messages WHERE contact_id = ? AND doc_tag IS NOT NULL ORDER BY doc_tag ASC").bind(contactId).all()
    : await db.prepare("SELECT DISTINCT doc_tag FROM messages WHERE doc_tag IS NOT NULL ORDER BY doc_tag ASC").all();
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

// contactId null → global recent (dashboard); a contact id → that contact only
// (used for AI context so one contact's conversation never leaks into another's).
export async function getRecentMessages(db, limit = 20, contactId = null) {
  const results = contactId
    ? await db.prepare('SELECT * FROM messages WHERE contact_id = ? ORDER BY timestamp DESC LIMIT ?').bind(contactId, limit).all()
    : await db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?').bind(limit).all();
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

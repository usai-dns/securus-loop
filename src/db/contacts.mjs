// Contact registry — the multi-tenant boundary. Every inbound message,
// governing document, queue part, and send is scoped to exactly one contact_id
// so different inmates' data (messages, documents) can NEVER be mixed.

// Default contact for all pre-existing (single-tenant) data.
export const DEFAULT_CONTACT = 'sam';

export async function getContacts(db, { activeOnly = false } = {}) {
  const rows = (await db.prepare(
    `SELECT id, securus_id, name, doc_number, language, match_names, active, persona, created_at
     FROM contacts ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`
  ).all().catch(() => ({ results: [] }))).results;
  return rows;
}

export async function getContact(db, contactId) {
  return db.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first();
}

export async function getContactBySecurusId(db, securusId) {
  return db.prepare("SELECT * FROM contacts WHERE securus_id = ?").bind(securusId).first();
}

// Attribute an inbox sender name to a contact_id using each contact's
// comma-separated match_names (e.g. "SAMUEL,MULLIKIN"). Returns null if the
// sender doesn't match any registered contact — such messages are NOT processed.
export function contactIdForSender(senderName, contacts) {
  if (!senderName) return null;
  const upper = senderName.toUpperCase();
  for (const c of contacts) {
    const needles = (c.match_names || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (needles.length && needles.some(n => upper.includes(n))) return c.id;
  }
  return null;
}

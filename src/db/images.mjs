// Image records (GH#6/#7): every generated image, its prompts, its project,
// and its iteration chain. Bytes live in D1 (data_b64) until R2 permissions
// exist; everything else is storage-agnostic.

export async function saveImage(db, { contactId, docTag, intent, prompt, parentImageId, hfRequestId, mime, dataB64, cost }) {
  const r = await db.prepare(
    `INSERT INTO images (contact_id, doc_tag, intent, prompt, parent_image_id, hf_request_id, mime, data_b64, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(contactId, docTag, intent || null, prompt, parentImageId || null,
         hfRequestId || null, mime || 'image/jpeg', dataB64, cost || null).run();
  return r.meta.last_row_id;
}

export async function getImage(db, id) {
  return db.prepare("SELECT * FROM images WHERE id = ?").bind(id).first();
}

// newest image for a (contact, project) — the iteration parent for "again"
export async function latestImageForProject(db, contactId, docTag) {
  return db.prepare(
    "SELECT * FROM images WHERE contact_id = ? AND doc_tag = ? ORDER BY id DESC LIMIT 1"
  ).bind(contactId, docTag).first();
}

// gallery listing — no bytes, keep it light
export async function listImages(db, contactId, docTag = null) {
  const q = docTag
    ? db.prepare("SELECT id, doc_tag, intent, prompt, parent_image_id, mime, cost, created_at, length(data_b64) b64len FROM images WHERE contact_id = ? AND doc_tag = ? ORDER BY id DESC").bind(contactId, docTag)
    : db.prepare("SELECT id, doc_tag, intent, prompt, parent_image_id, mime, cost, created_at, length(data_b64) b64len FROM images WHERE contact_id = ? ORDER BY id DESC").bind(contactId);
  return (await q.all()).results;
}

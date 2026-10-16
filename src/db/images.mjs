// Image records (GH#6/#7): every generated image, its prompts, its project,
// and its iteration chain. Bytes live in D1 (data_b64) until R2 permissions
// exist; everything else is storage-agnostic.

// D1 caps a row/string around 2MB; base64 of a big render can exceed it.
// The first piece lives on the images row, the rest in image_chunks.
const B64_PIECE = 900000;

export async function saveImage(db, { contactId, docTag, intent, prompt, parentImageId, hfRequestId, mime, dataB64, cost }) {
  const first = dataB64.substring(0, B64_PIECE);
  const r = await db.prepare(
    `INSERT INTO images (contact_id, doc_tag, intent, prompt, parent_image_id, hf_request_id, mime, data_b64, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(contactId, docTag, intent || null, prompt, parentImageId || null,
         hfRequestId || null, mime || 'image/jpeg', first, cost || null).run();
  const imageId = r.meta.last_row_id;
  for (let seq = 1, off = B64_PIECE; off < dataB64.length; seq++, off += B64_PIECE) {
    await db.prepare("INSERT INTO image_chunks (image_id, seq, data_b64) VALUES (?, ?, ?)")
      .bind(imageId, seq, dataB64.substring(off, off + B64_PIECE)).run();
  }
  return imageId;
}

export async function getImage(db, id) {
  const row = await db.prepare("SELECT * FROM images WHERE id = ?").bind(id).first();
  if (!row) return row;
  const chunks = await db.prepare(
    "SELECT data_b64 FROM image_chunks WHERE image_id = ? ORDER BY seq"
  ).bind(id).all();
  if (chunks.results?.length) {
    row.data_b64 = (row.data_b64 || '') + chunks.results.map(c => c.data_b64).join('');
  }
  return row;
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

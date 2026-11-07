// Image records (GH#6/#7): every generated image, its prompts, its project,
// and its iteration chain. Bytes live in D1 (data_b64) until R2 permissions
// exist; everything else is storage-agnostic.
//
// v2 columns (migrations in docs/v2/NOTES-images.md): label (Sam's "Saga2"),
// model (registry id, e.g. soul / gpt-image), request_id (ledger FK).

// D1 caps a row/string around 2MB; base64 of a big render can exceed it.
// The first piece lives on the images row, the rest in image_chunks.
const B64_PIECE = 900000;

const LIST_COLS = 'id, doc_tag, intent, prompt, label, model, request_id, parent_image_id, hf_request_id, mime, cost, created_at, length(data_b64) b64len';

export async function saveImage(db, { contactId, docTag, intent, prompt, label, model, requestId, parentImageId, hfRequestId, mime, dataB64, cost }) {
  const first = dataB64.substring(0, B64_PIECE);
  const r = await db.prepare(
    `INSERT INTO images (contact_id, doc_tag, intent, prompt, label, model, request_id, parent_image_id, hf_request_id, mime, data_b64, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(contactId, docTag, intent || null, prompt, label || null, model || null, requestId || null,
         parentImageId || null, hfRequestId || null, mime || 'image/jpeg', first, cost || null).run();
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

// several images in one call (multi-attach) — preserves the requested order,
// drops ids that don't exist
export async function getImages(db, ids) {
  const out = [];
  for (const id of ids || []) {
    const img = await getImage(db, id);
    if (img) out.push(img);
  }
  return out;
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
    ? db.prepare(`SELECT ${LIST_COLS} FROM images WHERE contact_id = ? AND doc_tag = ? ORDER BY id DESC`).bind(contactId, docTag)
    : db.prepare(`SELECT ${LIST_COLS} FROM images WHERE contact_id = ? ORDER BY id DESC`).bind(contactId);
  return (await q.all()).results;
}

// attachment filename for an image row: "<label-or-tag>-<id>.jpg", ASCII-safe
export function imageFilename(img) {
  const base = (img.label || img.doc_tag || 'image').toString().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 30) || 'image';
  return `${base}-${img.id}.jpg`;
}

// Securus's compose silently refuses (Send stays disabled) when the subject
// is too long — the longest subject ever accepted is 44 chars; q#98 at 58
// chars never enabled Send (2026-10-17). Cap at 40 and keep subjects ASCII-safe.
export function safeSubject(s) {
  return (s || 'Message')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 40);
}

export async function queueOutboundParts(db, { inboundId, seriesId, parts, docTag, contactId, securusId }) {
  for (let i = 0; i < parts.length; i++) {
    await db.prepare(
      `INSERT INTO send_queue (inbound_id, series_id, part_num, total_parts, subject, body, doc_tag, contact_id, securus_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      inboundId || null,
      seriesId || null,
      i + 1,
      parts.length,
      safeSubject(parts[i].subject),
      parts[i].body,
      docTag || null,
      contactId || 'sam',
      securusId || null
    ).run();
  }
  console.log(`queued ${parts.length} parts for inbound ${inboundId} (contact ${contactId || 'sam'})`);
}

// failed parts are retried automatically on later cron cycles, spaced by
// RETRY_BACKOFF_HOURS, up to MAX_SEND_RETRIES attempts. After that they stay
// failed until a human runs /retry-failed.
export const MAX_SEND_RETRIES = 4;
export const RETRY_BACKOFF_HOURS = 2;

export async function getPendingParts(db, limit = 4) {
  const results = await db.prepare(
    `SELECT * FROM send_queue
     WHERE status = 'pending'
        OR (status = 'failed'
            AND COALESCE(retry_count, 0) < ?
            AND (last_attempt_at IS NULL OR last_attempt_at < datetime('now', ?)))
     ORDER BY id ASC LIMIT ?`
  ).bind(MAX_SEND_RETRIES, `-${RETRY_BACKOFF_HOURS} hours`, limit).all();
  return results.results;
}

export async function markPartSent(db, queueId, outboundMsgId) {
  await db.prepare(
    "UPDATE send_queue SET status = 'sent', sent_at = datetime('now'), outbound_msg_id = ? WHERE id = ?"
  ).bind(outboundMsgId, queueId).run();
}

// increments retry_count; returns true when the part just exhausted its retries
export async function markPartFailed(db, queueId, error) {
  await db.prepare(
    `UPDATE send_queue
     SET status = 'failed', error = ?,
         retry_count = COALESCE(retry_count, 0) + 1,
         last_attempt_at = datetime('now')
     WHERE id = ?`
  ).bind(error, queueId).run();
  const row = await db.prepare(
    "SELECT retry_count FROM send_queue WHERE id = ?"
  ).bind(queueId).first();
  return (row?.retry_count || 0) >= MAX_SEND_RETRIES;
}

export async function getQueueStatus(db) {
  const results = await db.prepare(
    "SELECT status, COUNT(*) as cnt FROM send_queue GROUP BY status"
  ).all();
  const status = { pending: 0, sent: 0, failed: 0 };
  for (const row of results.results) {
    status[row.status] = row.cnt;
  }
  return status;
}

// must mirror getPendingParts' eligibility: counting only status='pending'
// made the orchestrator skip the SEND phase once every part was 'failed',
// so retry-eligible parts never retried (bit us 2026-10-17)
export async function hasPendingParts(db) {
  const row = await db.prepare(
    `SELECT id FROM send_queue
     WHERE status = 'pending'
        OR (status = 'failed'
            AND COALESCE(retry_count, 0) < ?
            AND (last_attempt_at IS NULL OR last_attempt_at < datetime('now', ?)))
     LIMIT 1`
  ).bind(MAX_SEND_RETRIES, `-${RETRY_BACKOFF_HOURS} hours`).first();
  return !!row;
}

export async function hasQueuedForInbound(db, inboundId) {
  const row = await db.prepare(
    "SELECT id FROM send_queue WHERE inbound_id = ? LIMIT 1"
  ).bind(inboundId).first();
  return !!row;
}

// ── multi-image parts (v2) ───────────────────────────────────────────────────
// Securus accepts at most 5 attachments per message (compose recon, Nov 2026)
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

// image ids attached to a queue row: `image_ids` JSON wins, else the legacy
// single `image_id`, else none. Tolerates a missing column / bad JSON.
export function getPartImageIds(row) {
  if (!row) return [];
  const clean = (arr) => [...new Set(arr.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (row.image_ids) {
    try {
      const parsed = typeof row.image_ids === 'string' ? JSON.parse(row.image_ids) : row.image_ids;
      if (Array.isArray(parsed)) {
        const ids = clean(parsed);
        if (ids.length) return ids;
      }
    } catch { /* fall through to image_id */ }
  }
  if (row.image_id) return clean([row.image_id]);
  return [];
}

// writes image_ids JSON AND keeps image_id = first id so pre-v2 readers
// (dashboard, /queue, standalone send) still see the primary attachment
export async function setPartImageIds(db, queueId, ids) {
  const clean = getPartImageIds({ image_ids: JSON.stringify(ids || []) });
  await db.prepare("UPDATE send_queue SET image_ids = ?, image_id = ? WHERE id = ?")
    .bind(clean.length ? JSON.stringify(clean) : null, clean[0] ?? null, queueId).run();
  return clean;
}

// split a list of image ids into per-message batches of ≤ max — the caller
// queues one part per batch (overflow onto part 2+, V2_ARCHITECTURE §4)
export function chunkImageIds(ids, max = MAX_ATTACHMENTS_PER_MESSAGE) {
  const clean = getPartImageIds({ image_ids: JSON.stringify(ids || []) });
  const out = [];
  for (let i = 0; i < clean.length; i += max) out.push(clean.slice(i, i + max));
  return out;
}

export async function resetFailedParts(db) {
  const result = await db.prepare(
    "UPDATE send_queue SET status = 'pending', error = NULL, retry_count = 0, last_attempt_at = NULL WHERE status = 'failed'"
  ).run();
  return result.meta.changes;
}

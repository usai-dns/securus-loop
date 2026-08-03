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
      parts[i].subject,
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

export async function hasPendingParts(db) {
  const row = await db.prepare(
    "SELECT id FROM send_queue WHERE status = 'pending' LIMIT 1"
  ).first();
  return !!row;
}

export async function hasQueuedForInbound(db, inboundId) {
  const row = await db.prepare(
    "SELECT id FROM send_queue WHERE inbound_id = ? LIMIT 1"
  ).bind(inboundId).first();
  return !!row;
}

export async function resetFailedParts(db) {
  const result = await db.prepare(
    "UPDATE send_queue SET status = 'pending', error = NULL, retry_count = 0, last_attempt_at = NULL WHERE status = 'failed'"
  ).run();
  return result.meta.changes;
}

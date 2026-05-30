export async function queueOutboundParts(db, { inboundId, seriesId, parts, docTag }) {
  for (let i = 0; i < parts.length; i++) {
    await db.prepare(
      `INSERT INTO send_queue (inbound_id, series_id, part_num, total_parts, subject, body, doc_tag)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      inboundId || null,
      seriesId || null,
      i + 1,
      parts.length,
      parts[i].subject,
      parts[i].body,
      docTag || null
    ).run();
  }
  console.log(`queued ${parts.length} parts for inbound ${inboundId}`);
}

export async function getPendingParts(db, limit = 4) {
  const results = await db.prepare(
    "SELECT * FROM send_queue WHERE status = 'pending' ORDER BY id ASC LIMIT ?"
  ).bind(limit).all();
  return results.results;
}

export async function markPartSent(db, queueId, outboundMsgId) {
  await db.prepare(
    "UPDATE send_queue SET status = 'sent', sent_at = datetime('now'), outbound_msg_id = ? WHERE id = ?"
  ).bind(outboundMsgId, queueId).run();
}

export async function markPartFailed(db, queueId, error) {
  await db.prepare(
    "UPDATE send_queue SET status = 'failed', error = ? WHERE id = ?"
  ).bind(error, queueId).run();
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
    "UPDATE send_queue SET status = 'pending', error = NULL WHERE status = 'failed'"
  ).run();
  return result.meta.changes;
}

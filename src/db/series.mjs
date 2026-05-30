// pattern: "message N/M" anywhere in the text (case insensitive)
const SERIES_PATTERN = /message\s+(\d+)\s*\/\s*(\d+)/i;

export function detectSeriesIndicator(body) {
  if (!body) return null;
  const match = body.match(SERIES_PATTERN);
  if (!match) return null;

  const partNum = parseInt(match[1], 10);
  const totalParts = parseInt(match[2], 10);
  if (partNum < 1 || partNum > totalParts || totalParts < 2 || totalParts > 30) return null;

  const stripped = body.replace(SERIES_PATTERN, '').trim();
  const baseKey = stripped.substring(0, 80).toLowerCase().replace(/\s+/g, '_') || 'series';
  return { partNum, totalParts, seriesKey: `series:${totalParts}:${baseKey}` };
}

export function stripSeriesIndicator(body) {
  if (!body) return body;
  return body.replace(SERIES_PATTERN, '').trim();
}

export async function getOrCreateSeries(db, { seriesKey, totalParts, docTag, docCommand }) {
  const existing = await db.prepare(
    "SELECT * FROM inbound_series WHERE series_key = ?"
  ).bind(seriesKey).first();

  if (existing) {
    if (totalParts !== existing.total_parts) {
      await db.prepare(
        "UPDATE inbound_series SET total_parts = ? WHERE id = ?"
      ).bind(totalParts, existing.id).run();
      existing.total_parts = totalParts;
    }
    return existing;
  }

  const result = await db.prepare(
    `INSERT INTO inbound_series (series_key, total_parts, doc_tag, doc_command)
     VALUES (?, ?, ?, ?)`
  ).bind(seriesKey, totalParts, docTag || null, docCommand || null).run();

  return {
    id: result.meta.last_row_id,
    series_key: seriesKey,
    total_parts: totalParts,
    received_parts: 0,
    status: 'collecting',
    doc_tag: docTag || null,
    doc_command: docCommand || null,
  };
}

export async function addSeriesPart(db, { seriesId, partNum, messageId }) {
  try {
    await db.prepare(
      "INSERT INTO inbound_series_parts (series_id, part_num, message_id) VALUES (?, ?, ?)"
    ).bind(seriesId, partNum, messageId).run();
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      console.log(`series part ${partNum} already exists for series ${seriesId}, skipping`);
      return false;
    }
    throw err;
  }

  const countResult = await db.prepare(
    "SELECT COUNT(*) as cnt FROM inbound_series_parts WHERE series_id = ?"
  ).bind(seriesId).first();
  const received = countResult.cnt;

  await db.prepare(
    "UPDATE inbound_series SET received_parts = ? WHERE id = ?"
  ).bind(received, seriesId).run();

  return true;
}

export async function checkSeriesComplete(db, seriesId) {
  const series = await db.prepare(
    "SELECT total_parts, received_parts FROM inbound_series WHERE id = ?"
  ).bind(seriesId).first();
  if (!series) return false;

  if (series.received_parts >= series.total_parts) {
    await db.prepare(
      "UPDATE inbound_series SET status = 'complete', completed_at = datetime('now') WHERE id = ? AND status = 'collecting'"
    ).bind(seriesId).run();
    return true;
  }
  return false;
}

export async function getCompleteSeries(db) {
  const results = await db.prepare(
    "SELECT * FROM inbound_series WHERE status = 'complete'"
  ).all();
  return results.results;
}

export async function getSeriesParts(db, seriesId) {
  const results = await db.prepare(
    `SELECT isp.part_num, isp.message_id, m.body, m.subject, m.doc_tag
     FROM inbound_series_parts isp
     JOIN messages m ON isp.message_id = m.id
     WHERE isp.series_id = ?
     ORDER BY isp.part_num ASC`
  ).bind(seriesId).all();
  return results.results;
}

export async function markSeriesProcessed(db, seriesId) {
  await db.prepare(
    "UPDATE inbound_series SET status = 'processed', processed_at = datetime('now') WHERE id = ?"
  ).bind(seriesId).run();
}

export async function getSeriesStatus(db) {
  const results = await db.prepare(
    "SELECT id, series_key, total_parts, received_parts, status, created_at, completed_at FROM inbound_series ORDER BY id DESC LIMIT 20"
  ).all();
  return results.results;
}

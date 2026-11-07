// Request ledger (v2 §3): every discrete thing a contact asks for becomes a
// tracked row, so replies report what was delivered and what is still open
// instead of promising follow-ups that never come.

export const REQUEST_KINDS = ['answer', 'image', 'doc_update', 'research', 'followup'];
export const OPEN_STATUSES = ['open', 'in_progress'];

export const REQUESTS_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id TEXT NOT NULL,
    inbound_id INTEGER,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    spec TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority INTEGER NOT NULL DEFAULT 5,
    fulfilled_by_outbound_id INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_requests_contact_status ON requests(contact_id, status, id)",
  "CREATE INDEX IF NOT EXISTS idx_requests_inbound ON requests(inbound_id)",
];

export async function createRequests(db, contactId, inboundId, requests) {
  const ids = [];
  for (const r of requests) {
    const res = await db.prepare(
      `INSERT INTO requests (contact_id, inbound_id, kind, label, spec, priority)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(contactId, inboundId || null, r.kind, r.label, r.spec ? JSON.stringify(r.spec) : null, r.priority ?? 5).run();
    ids.push(res.meta.last_row_id);
  }
  return ids;
}

function parseRow(row) {
  if (!row) return row;
  let spec = null;
  try { spec = row.spec ? JSON.parse(row.spec) : null; } catch { spec = null; }
  return { ...row, spec };
}

export async function getOpenRequests(db, contactId, { limit = 40 } = {}) {
  const res = await db.prepare(
    `SELECT * FROM requests WHERE contact_id = ? AND status IN ('open','in_progress')
     ORDER BY priority DESC, id ASC LIMIT ?`
  ).bind(contactId, limit).all();
  return (res.results || []).map(parseRow);
}

export async function getRequestsForInbound(db, inboundId) {
  const res = await db.prepare("SELECT * FROM requests WHERE inbound_id = ? ORDER BY id").bind(inboundId).all();
  return (res.results || []).map(parseRow);
}

// open requests from EARLIER inbound messages — the carry-over set
export async function getCarryoverRequests(db, contactId, currentInboundId, { limit = 10 } = {}) {
  const res = await db.prepare(
    `SELECT * FROM requests WHERE contact_id = ? AND status IN ('open','in_progress')
     AND (inbound_id IS NULL OR inbound_id < ?) ORDER BY priority DESC, id ASC LIMIT ?`
  ).bind(contactId, currentInboundId, limit).all();
  return (res.results || []).map(parseRow);
}

export async function markRequests(db, ids, status, { fulfilledBy = null, note = null, bumpAttempts = false } = {}) {
  for (const id of ids) {
    await db.prepare(
      `UPDATE requests SET status = ?, fulfilled_by_outbound_id = COALESCE(?, fulfilled_by_outbound_id),
         note = COALESCE(?, note), attempts = attempts + ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(status, fulfilledBy, note, bumpAttempts ? 1 : 0, id).run();
  }
}

export async function listRequests(db, contactId, { status = null, limit = 100 } = {}) {
  const q = status
    ? db.prepare("SELECT * FROM requests WHERE contact_id = ? AND status = ? ORDER BY id DESC LIMIT ?").bind(contactId, status, limit)
    : db.prepare("SELECT * FROM requests WHERE contact_id = ? ORDER BY id DESC LIMIT ?").bind(contactId, limit);
  return ((await q.all()).results || []).map(parseRow);
}

export async function requestCounts(db, contactId) {
  const res = await db.prepare(
    "SELECT status, COUNT(*) n FROM requests WHERE contact_id = ? GROUP BY status"
  ).bind(contactId).all();
  const out = { open: 0, in_progress: 0, done: 0, deferred: 0, failed: 0, cancelled: 0 };
  for (const r of res.results || []) out[r.status] = r.n;
  return out;
}

// ── pure helpers (tested) ─────────────────────────────────────────────

// Short human label for a request row — used in manifests and footers.
export function requestLabel(r) {
  if (r.label) return r.label;
  const spec = r.spec || {};
  if (r.kind === 'image' && spec.prompt) return spec.prompt.substring(0, 40).trim() + (spec.prompt.length > 40 ? '…' : '');
  return `${r.kind} #${r.id ?? '?'}`;
}

// Normalise raw extractor output into ledger rows: drop unknown kinds,
// clamp priority 1..9, guarantee a label, keep spec as an object.
export function normalizeRequests(raw) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || !REQUEST_KINDS.includes(r.kind)) continue;
    const spec = (r.spec && typeof r.spec === 'object') ? r.spec : {};
    const label = String(r.label || spec.label || spec.prompt || r.kind).replace(/\s+/g, ' ').trim().substring(0, 60);
    if (!label) continue;
    let priority = parseInt(r.priority, 10);
    if (!Number.isFinite(priority)) priority = 5;
    priority = Math.max(1, Math.min(9, priority));
    const row = { kind: r.kind, label, spec, priority };
    if (r.replaces) row.replaces = String(r.replaces).trim().substring(0, 60);
    out.push(row);
  }
  return out;
}

// Extracted image rows that carry `replaces` supersede the parsed umbrella
// directive they split (one "four pictures…" directive → four requests).
export function mergeExtractedImages(parsedRows, extracted) {
  const replaced = new Set((extracted || []).filter(r => r.kind === 'image' && r.replaces).map(r => r.replaces.toLowerCase()));
  const kept = (parsedRows || []).filter(r => !replaced.has(String(r.label || '').toLowerCase()));
  const cleaned = (extracted || []).map(({ replaces, ...r }) => r);
  return [...kept, ...cleaned];
}

// Image requests become ledger rows with a stable spec shape.
export function imageDirectivesToRequests(images, { group = null } = {}) {
  return (images || []).filter(i => i && i.prompt).map((i, idx) => ({
    kind: 'image',
    label: i.label || `Image ${idx + 1}`,
    spec: { prompt: i.prompt, model: i.modelHint || null, label: i.label || null, group },
    priority: 6,
  }));
}

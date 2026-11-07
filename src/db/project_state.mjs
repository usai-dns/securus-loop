// Project State registry (v2 §13): the CURRENT truth of a project as typed
// facts with provenance — hardware.rangefinder, rules.battery_reposition_pct,
// decisions.first_test.relay_drones — distinct from the document (prose) and
// the request ledger (events). Superseded values stay as history.

export const PROJECT_STATE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS project_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'current',
    set_by_inbound_id INTEGER,
    set_by_author TEXT,
    supersedes_id INTEGER,
    note TEXT,
    set_at TEXT DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_project_state_current ON project_state(contact_id, tag, status, key)",
];

function parseValue(v) {
  try { return JSON.parse(v); } catch { return v; }
}

export async function getCurrentState(db, contactId, tag) {
  const res = await db.prepare(
    "SELECT * FROM project_state WHERE contact_id = ? AND tag = ? AND status = 'current' ORDER BY key"
  ).bind(contactId, tag).all();
  return (res.results || []).map(r => ({ ...r, value: parseValue(r.value) }));
}

export async function getStateHistory(db, contactId, tag, key, { limit = 20 } = {}) {
  const res = await db.prepare(
    "SELECT * FROM project_state WHERE contact_id = ? AND tag = ? AND key = ? ORDER BY id DESC LIMIT ?"
  ).bind(contactId, tag, key, limit).all();
  return (res.results || []).map(r => ({ ...r, value: parseValue(r.value) }));
}

// Apply a list of changes {key, value, action: 'set'|'retract', note}. A set
// whose value equals the current one is a confirmation (no new row, note kept
// in history via touch); a different value supersedes the current row.
// Returns { set: [key], superseded: [{key, from, to}], retracted: [key], unchanged: [key] }.
export async function applyStateChanges(db, { contactId, tag, changes, inboundId = null, author = null }) {
  const out = { set: [], superseded: [], retracted: [], unchanged: [] };
  for (const c of changes || []) {
    if (!c || !c.key) continue;
    const key = normalizeKey(c.key);
    const cur = await db.prepare(
      "SELECT * FROM project_state WHERE contact_id = ? AND tag = ? AND key = ? AND status = 'current' LIMIT 1"
    ).bind(contactId, tag, key).first();
    if (c.action === 'retract') {
      if (cur) {
        await db.prepare("UPDATE project_state SET status = 'retracted', note = COALESCE(?, note) WHERE id = ?").bind(c.note || null, cur.id).run();
        out.retracted.push(key);
      }
      continue;
    }
    const newVal = JSON.stringify(c.value ?? null);
    if (cur && cur.value === newVal) { out.unchanged.push(key); continue; }
    if (cur) {
      await db.prepare("UPDATE project_state SET status = 'superseded' WHERE id = ?").bind(cur.id).run();
    }
    await db.prepare(
      `INSERT INTO project_state (contact_id, tag, key, value, status, set_by_inbound_id, set_by_author, supersedes_id, note)
       VALUES (?, ?, ?, ?, 'current', ?, ?, ?, ?)`
    ).bind(contactId, tag, key, newVal, inboundId, author, cur?.id || null, c.note || null).run();
    if (cur) out.superseded.push({ key, from: parseValue(cur.value), to: c.value ?? null });
    else out.set.push(key);
  }
  return out;
}

// ── pure helpers (tested) ─────────────────────────────────────────────

// dotted lowercase keys: "Hardware / Rangefinder" -> "hardware.rangefinder"
export function normalizeKey(key) {
  return String(key || '')
    .trim().toLowerCase()
    .replace(/[\/\\>|:]+/g, '.')
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_*\._*/g, '.')
    .replace(/^[._]+|[._]+$/g, '')
    .replace(/\.{2,}/g, '.')
    .substring(0, 120);
}

function fmtValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(fmtValue).join(', ');
  return Object.entries(v).map(([k, x]) => `${k}=${fmtValue(x)}`).join(', ');
}

// Compact prompt block: grouped by top-level namespace, current facts only,
// with the date each was set. `assets` = [{ id, label, created_at, prompt }].
export function renderStateBlock(rows, { assets = [], cap = 6000 } = {}) {
  if (!(rows || []).length && !(assets || []).length) return '';
  const groups = new Map();
  for (const r of rows || []) {
    const ns = r.key.includes('.') ? r.key.split('.')[0] : 'general';
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns).push(r);
  }
  const lines = [];
  for (const [ns, items] of [...groups.entries()].sort()) {
    lines.push(`[${ns}]`);
    for (const r of items) {
      const when = (r.set_at || '').substring(0, 10);
      lines.push(`- ${r.key} = ${fmtValue(r.value)}${when ? ` (set ${when})` : ''}${r.note ? ` — ${r.note}` : ''}`);
    }
  }
  if ((assets || []).length) {
    lines.push('[assets.images]');
    for (const a of assets) {
      lines.push(`- #${a.id} ${a.label || 'untitled'} (${(a.created_at || '').substring(0, 10)})${a.prompt ? `: ${String(a.prompt).substring(0, 90)}` : ''}`);
    }
  }
  let text = lines.join('\n');
  if (text.length > cap) text = text.substring(0, cap) + '\n…(state truncated)';
  return text;
}

// Which current facts changed between two snapshots? Used to drive the
// document consistency sweep: sections citing `from` values are stale.
export function diffState(before, after) {
  const b = new Map((before || []).map(r => [r.key, JSON.stringify(r.value ?? null)]));
  const a = new Map((after || []).map(r => [r.key, JSON.stringify(r.value ?? null)]));
  const changed = [];
  for (const [k, v] of a) if (!b.has(k)) changed.push({ key: k, from: null, to: parseValue(v) });
    else if (b.get(k) !== v) changed.push({ key: k, from: parseValue(b.get(k)), to: parseValue(v) });
  for (const [k, v] of b) if (!a.has(k)) changed.push({ key: k, from: parseValue(v), to: null });
  return changed;
}

// Stale-value scan: does a section body still mention a superseded value?
// Cheap deterministic filter before asking the model to patch.
export function sectionsCitingStale(sections, superseded) {
  const needles = [];
  for (const s of superseded || []) {
    const v = s.from;
    const parts = typeof v === 'object' && v !== null ? Object.values(v) : [v];
    for (const p of parts) {
      const str = String(p ?? '').trim();
      if (str.length >= 3 && !/^(true|false|null|\d{1,2})$/i.test(str)) needles.push(str.toLowerCase());
    }
  }
  if (!needles.length) return [];
  return (sections || []).filter(sec => {
    const body = `${sec.heading}\n${sec.body}`.toLowerCase();
    return needles.some(n => body.includes(n));
  }).map(sec => sec.heading);
}

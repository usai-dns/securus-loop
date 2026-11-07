// Dashboard data + HTML for the securus-agent monitoring page.
// Served by the worker at /dashboard (HTML) and /api/dashboard (JSON).
// Read-only. Token-gated via env.DASH_TOKEN.

import { getState } from './db/state.mjs';
import { getDocument, getDocumentVersions, listDocumentsForContact } from './db/documents.mjs';
import { getUsageSnapshot } from './db/usage.mjs';
import { getContacts, DEFAULT_CONTACT } from './db/contacts.mjs';
import { requestCounts } from './db/requests.mjs';

// contactId scopes all message/document views so contacts never mix on screen.
export async function getDashboardData(env, contactId = DEFAULT_CONTACT) {
  const db = env.DB;
  const cid = contactId || DEFAULT_CONTACT;

  const contacts = (await getContacts(db).catch(() => []))
    .map(c => ({ id: c.id, name: c.name, language: c.language, active: c.active }));

  const [lastCheck, totalChecks, totalSent, lastError, stampBalance] = await Promise.all([
    getState(db, 'last_check'),
    getState(db, 'total_checks'),
    getState(db, 'total_messages_sent'),
    getState(db, 'last_error'),
    getState(db, 'stamp_balance'),
  ]);

  // queue counts are system-wide (stamps are shared across contacts)
  const queueRows = (await db.prepare(
    "SELECT status, COUNT(*) as cnt FROM send_queue GROUP BY status"
  ).all()).results;
  const queue = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of queueRows) queue[r.status] = r.cnt;

  const failed = (await db.prepare(
    `SELECT id, inbound_id, part_num, total_parts, subject, error, retry_count, created_at, last_attempt_at, contact_id
     FROM send_queue WHERE status = 'failed' ORDER BY id DESC LIMIT 20`
  ).all()).results;

  // unresponded across ALL contacts — health/alerts must never hide one
  // contact's waiting messages because another contact is selected on screen.
  const unrespondedByContact = (await db.prepare(
    `SELECT contact_id, COUNT(*) as c FROM messages
     WHERE direction='inbound' AND responded_at IS NULL AND response_id IS NULL
     GROUP BY contact_id`
  ).all()).results;

  // ── everything below is scoped to the selected contact ──
  const unresponded = (await db.prepare(
    `SELECT id, subject, substr(timestamp,1,16) as ts
     FROM messages WHERE contact_id = ? AND direction='inbound' AND responded_at IS NULL AND response_id IS NULL
     ORDER BY id DESC`
  ).bind(cid).all()).results;

  const msgDocs = (await db.prepare(
    `SELECT m.doc_tag,
            COUNT(*) as total,
            SUM(CASE WHEN m.direction='inbound' THEN 1 ELSE 0 END) as inbound,
            SUM(CASE WHEN m.direction='outbound' THEN 1 ELSE 0 END) as outbound,
            MIN(substr(m.timestamp,1,10)) as first_date,
            MAX(substr(m.timestamp,1,10)) as last_date,
            d.version as doc_version,
            length(d.content) as doc_len,
            d.updated_at as doc_updated
     FROM messages m
     LEFT JOIN documents d ON d.tag = m.doc_tag AND d.contact_id = m.contact_id
     WHERE m.contact_id = ? AND m.doc_tag IS NOT NULL
     GROUP BY m.doc_tag ORDER BY last_date DESC`
  ).bind(cid).all()).results;

  // v2: protected/version/length come from the documents table itself, which
  // also surfaces docs with no message traffic (archives, profile). Tolerates a
  // DB that predates the `protected` column.
  const documentRows = await listDocumentsForContact(db, cid).catch(() => []);
  const docs = mergeDocSummaries(msgDocs, documentRows);

  const historyRows = (await db.prepare(
    `SELECT doc_tag, id, direction, subject, substr(timestamp,1,16) as ts,
            substr(body,1,240) as snippet, length(body) as body_len
     FROM messages WHERE contact_id = ? AND doc_tag IS NOT NULL
     ORDER BY doc_tag ASC, timestamp ASC`
  ).bind(cid).all()).results;
  const history = {};
  for (const r of historyRows) {
    (history[r.doc_tag] ||= []).push(r);
  }

  const recent = (await db.prepare(
    `SELECT id, direction, sender, subject, substr(timestamp,1,16) as ts, doc_tag,
            responded_at, response_id, confirmed_sent
     FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 20`
  ).bind(cid).all()).results;

  const daily = (await db.prepare(
    `SELECT substr(timestamp,1,10) as day,
            SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) as inbound,
            SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) as outbound
     FROM messages WHERE contact_id = ? AND timestamp > datetime('now','-14 days')
     GROUP BY day ORDER BY day ASC`
  ).bind(cid).all()).results;

  const series = (await db.prepare(
    "SELECT id, series_key, total_parts, received_parts, status FROM inbound_series WHERE contact_id = ? AND status IN ('collecting','complete') ORDER BY id DESC LIMIT 10"
  ).bind(cid).all().catch(() => ({ results: [] }))).results;

  const usage = await getUsageSnapshot(db).catch(() => null);

  // v2 request ledger — null when the `requests` table has not been migrated yet
  const reqCounts = await requestCounts(db, cid).catch(() => null);

  // Health: derive a status from the signals.
  const now = Date.now();
  const lastCheckMs = lastCheck ? new Date(lastCheck).getTime() : 0;
  const staleHours = lastCheckMs ? (now - lastCheckMs) / 3.6e6 : 999;
  const stamps = stampBalance ? parseInt(stampBalance, 10) : null;
  let health = 'good';
  const alerts = [];
  if (staleHours > 3) { health = 'serious'; alerts.push(`No successful cron check in ${staleHours.toFixed(1)}h`); }
  const unrespTotal = unrespondedByContact.reduce((s, r) => s + r.c, 0);
  if (unrespTotal > 0) {
    if (health === 'good') health = 'warning';
    alerts.push(`${unrespTotal} unresponded message(s): ${unrespondedByContact.map(r => `${r.contact_id} ${r.c}`).join(', ')}`);
  }
  if (queue.failed > 0) { if (health === 'good') health = 'warning'; alerts.push(`${queue.failed} failed queue part(s)`); }
  if (stamps !== null && stamps <= 10) { health = stamps === 0 ? 'critical' : 'serious'; alerts.push(`Low stamps: ${stamps}`); }
  if (!env.TWILIO_ACCOUNT_SID) alerts.push('SMS notifications not configured (Twilio secrets unset)');

  return {
    generatedAt: new Date().toISOString(),
    state: {
      lastCheck, lastError,
      totalChecks: totalChecks ? parseInt(totalChecks, 10) : 0,
      totalMessagesSent: totalSent ? parseInt(totalSent, 10) : 0,
      stampBalance: stamps,
      staleHours: Number(staleHours.toFixed(1)),
    },
    health, alerts, usage,
    contacts, activeContact: cid,
    queue, failed, unresponded, docs, history, recent, daily, series,
    requestCounts: reqCounts,
  };
}

// ── pure helpers (server side; tested) ──────────────────────────────────

// Merge the per-topic message summary with the documents table so every list
// item carries `protected`, `version`, `length` (and documents that have no
// message traffic — archives, the profile doc — still appear, with total 0).
// Message-backed docs keep their order (last_date DESC); doc-only rows follow.
export function mergeDocSummaries(msgDocs, documentRows) {
  const byTag = new Map();
  for (const d of documentRows || []) byTag.set(d.tag, d);
  const out = [];
  for (const m of msgDocs || []) {
    const d = byTag.get(m.doc_tag);
    byTag.delete(m.doc_tag);
    out.push({
      ...m,
      protected: d ? (d.protected ? 1 : 0) : 0,
      version: d ? (d.version ?? null) : (m.doc_version ?? null),
      length: d ? (d.length ?? null) : (m.doc_len ?? null),
      title: d ? (d.title ?? null) : null,
    });
  }
  for (const d of byTag.values()) {
    out.push({
      doc_tag: d.tag, total: 0, inbound: 0, outbound: 0,
      first_date: null, last_date: null,
      doc_version: d.version ?? null, doc_len: d.length ?? null, doc_updated: null,
      protected: d.protected ? 1 : 0, version: d.version ?? null, length: d.length ?? null,
      title: d.title ?? null,
    });
  }
  return out;
}

// ── pure helpers shared with the browser ────────────────────────────────
// These are injected verbatim into the inline <script> (Function#toString),
// so they must be self-contained: no module-scope references, no template
// literals (the page itself is a template literal), ES2019 syntax only.

// Relative age like "4m", "3h", "6d" from a D1 `datetime('now')` string
// ("YYYY-MM-DD HH:MM:SS", UTC) or an ISO string. "—" when unparseable.
export function relativeAge(ts, nowMs) {
  if (!ts) return '—';
  var s = String(ts).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) s += 'Z';
  var t = Date.parse(s);
  if (isNaN(t)) return '—';
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return sec + 's';
  var min = Math.round(sec / 60);
  if (min < 60) return min + 'm';
  var hr = Math.round(min / 60);
  if (hr < 48) return hr + 'h';
  var day = Math.round(hr / 24);
  if (day < 60) return day + 'd';
  var mo = Math.round(day / 30);
  if (mo < 24) return mo + 'mo';
  return Math.round(day / 365) + 'y';
}

// "850", "12K", "1.2M" — character counts for list rows.
export function fmtK(n) {
  if (n == null || isNaN(Number(n))) return '—';
  n = Number(n);
  if (n < 1000) return String(n);
  if (n < 10000) return (Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n < 1000000) return Math.round(n / 1000) + 'K';
  return (Math.round(n / 100000) / 10).toFixed(1).replace(/\.0$/, '') + 'M';
}

// "v3 · 12K" for a document list row; null when no doc has been built.
export function docListLabel(doc) {
  if (!doc) return null;
  var v = doc.version != null ? doc.version : doc.doc_version;
  var len = doc.length != null ? doc.length : doc.doc_len;
  if (v == null && len == null) return null;
  return 'v' + (v == null ? '?' : v) + ' · ' + fmtK(len);
}

// Live docs first (in the order given), protected/archived docs after.
export function sortDocsForList(docs) {
  var live = [], prot = [];
  for (var i = 0; i < (docs || []).length; i++) {
    (docs[i].protected ? prot : live).push(docs[i]);
  }
  return live.concat(prot);
}

// doc.sections is a JSON string of [{heading, body}] (or already an array).
// Returns the array, or null when absent/unparseable/empty.
export function parseSectionsJson(s) {
  if (s == null || s === '') return null;
  var arr = s;
  if (typeof s === 'string') {
    try { arr = JSON.parse(s); } catch (e) { return null; }
  }
  if (!Array.isArray(arr) || !arr.length) return null;
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var x = arr[i];
    if (!x || typeof x !== 'object') continue;
    out.push({ heading: String(x.heading || 'Section'), body: String(x.body || '') });
  }
  return out.length ? out : null;
}

// Change log is plain text, newest first, one "- YYYY-MM-DD (vN): …" per line.
// Returns the lines without the leading bullet; [] when empty.
export function changelogLines(text) {
  if (!text) return [];
  return String(text).split(/\r?\n/)
    .map(function (l) { return l.replace(/^\s*[-*•]\s*/, '').trim(); })
    .filter(function (l) { return l.length > 0; });
}

// Requests tab filter: 'open' means open + in_progress (the working set).
export function requestMatchesFilter(status, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'open') return status === 'open' || status === 'in_progress';
  return status === filter;
}

// Entries ledger author badge: 'ai' → Assistant, otherwise the contact's name.
export function entryAuthorName(author, contactName) {
  if (author === 'ai') return 'Assistant';
  if (contactName) return contactName;
  if (!author) return '—';
  return author.charAt(0).toUpperCase() + author.slice(1);
}

// Gallery card line: "Saga2 · Soul v2 · req #12" from whichever fields exist.
export function imageCardMeta(im) {
  if (!im) return '';
  var parts = [];
  if (im.label) parts.push(String(im.label));
  if (im.model) parts.push(String(im.model));
  if (im.request_id != null && im.request_id !== '') parts.push('req #' + im.request_id);
  return parts.join(' · ');
}

// Request spec may arrive as an object or a JSON string; always return an object.
export function requestSpec(r) {
  var s = r && r.spec;
  if (!s) return {};
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { return {}; } }
  return (s && typeof s === 'object') ? s : {};
}

const CLIENT_HELPERS = [
  relativeAge, fmtK, docListLabel, sortDocsForList, parseSectionsJson,
  changelogLines, requestMatchesFilter, entryAuthorName, imageCardMeta, requestSpec,
].map(f => f.toString()).join('\n');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function renderDashboardHTML(token) {
  const t = esc(token || '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>securus-agent · status</title>
<style>
:root {
  --plane:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --baseline:#c3c2b7; --border:rgba(11,11,11,0.10);
  --s1:#2a78d6; --s2:#1baf7a;
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
  --radius:10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --plane:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --baseline:#383835; --border:rgba(255,255,255,0.10);
    --s1:#3987e5; --s2:#199e70;
    --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
  }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--plane); color:var(--ink);
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif; font-size:14px; line-height:1.45; }
a { color:var(--s1); }
.wrap { max-width:1180px; margin:0 auto; padding:20px 18px 60px; }
header { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:4px; }
h1 { font-size:19px; margin:0; font-weight:650; letter-spacing:-0.01em; }
.sub { color:var(--muted); font-size:12.5px; }
.dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; vertical-align:middle; }
.pill { font-size:12px; padding:3px 9px; border-radius:999px; border:1px solid var(--border); color:var(--ink2); }
.pill.link { cursor:pointer; }
.pill b { color:var(--ink); font-variant-numeric:tabular-nums; }
.switch { display:inline-flex; gap:4px; }
.switch button { font-size:12.5px; font-weight:600; padding:4px 12px; border-radius:999px; cursor:pointer;
  background:transparent; color:var(--ink2); border:1px solid var(--border); }
.switch button.on { background:var(--s1); color:#fff; border-color:var(--s1); }
.alerts { margin:12px 0 4px; display:flex; flex-direction:column; gap:6px; }
.alert { display:flex; align-items:center; gap:8px; padding:8px 11px; border-radius:8px;
  border:1px solid var(--border); background:var(--surface); font-size:13px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:16px 0; }
.tile { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:13px 15px; }
.tile.link { cursor:pointer; }
.tile.link:hover { background:var(--plane); }
.tile .k { font-size:12px; color:var(--muted); font-weight:500; }
.tile .v { font-size:27px; font-weight:660; letter-spacing:-0.02em; margin-top:3px; }
.tile .v small { font-size:13px; font-weight:500; color:var(--ink2); }
.grid2 { display:grid; grid-template-columns:340px 1fr; gap:16px; margin-top:8px; align-items:start; }
@media (max-width:820px){ .grid2 { grid-template-columns:1fr; } }
.card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; }
.card h2 { font-size:13px; font-weight:600; margin:0; padding:12px 15px; border-bottom:1px solid var(--border);
  color:var(--ink2); text-transform:uppercase; letter-spacing:0.04em; }
.doclist { max-height:520px; overflow:auto; }
.docitem { padding:11px 15px; border-bottom:1px solid var(--border); cursor:pointer; display:flex; justify-content:space-between; gap:10px; align-items:center; }
.docitem:hover { background:var(--plane); }
.docitem.active { background:var(--plane); box-shadow:inset 3px 0 0 var(--s1); }
.docitem .nm { font-weight:600; text-transform:capitalize; }
.docitem .meta { font-size:11.5px; color:var(--muted); margin-top:2px; }
.docitem .cnt { font-size:12px; color:var(--ink2); font-variant-numeric:tabular-nums; white-space:nowrap; text-align:right; }
.docitem.prot { color:var(--muted); }
.docitem.prot .nm { color:var(--muted); font-weight:550; }
.docitem.prot .cnt { color:var(--muted); }
.lock { font-size:11px; margin-left:5px; opacity:0.8; }
.panelhead { display:flex; align-items:center; gap:10px; padding:8px 15px; border-bottom:1px solid var(--border); flex-wrap:wrap; }
.panelhead h2 { border:none; padding:0; flex:0 0 auto; }
.tabs { margin-left:auto; display:flex; gap:4px; flex-wrap:wrap; }
.tab { font-size:12px; font-weight:600; padding:5px 12px; border-radius:7px; cursor:pointer;
  background:transparent; color:var(--ink2); border:1px solid var(--border); }
.tab.active { background:var(--s1); color:#fff; border-color:var(--s1); }
.docbody { max-height:640px; overflow:auto; }
.docmeta { padding:11px 16px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.docmeta .vtag { font-size:11.5px; font-weight:650; color:var(--s1); background:color-mix(in srgb,var(--s1) 14%,transparent); padding:2px 9px; border-radius:999px; }
.docmeta .vtag.prot { color:var(--serious); background:color-mix(in srgb,var(--serious) 14%,transparent); }
.docmeta .m { font-size:11.5px; color:var(--muted); }
.doctext { padding:16px; font-size:14.5px; line-height:1.62; white-space:pre-wrap; word-break:break-word; color:var(--ink); max-width:72ch; }
.docnone { padding:20px 16px; color:var(--ink2); font-size:13.5px; }
.docnone code { background:var(--plane); border:1px solid var(--border); padding:1px 6px; border-radius:5px; font-size:12.5px; }
.clog { padding:10px 16px; border-bottom:1px solid var(--border); background:var(--plane); }
.clog h3 { font-size:11.5px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); margin:0 0 6px; font-weight:600; display:flex; gap:10px; align-items:center; }
.clog ul { margin:0; padding-left:16px; font-size:12.5px; color:var(--ink2); }
.clog li { margin:2px 0; }
.clog.collapsed li:nth-child(n+6) { display:none; }
.secbar { display:flex; align-items:center; gap:10px; padding:7px 16px; border-bottom:1px solid var(--border); font-size:11.5px; color:var(--muted); }
.lnk { color:var(--s1); cursor:pointer; font-weight:600; font-size:11.5px; background:none; border:none; padding:0; font-family:inherit; }
.lnk.danger { color:var(--critical); }
.lnk:disabled { opacity:0.5; cursor:default; }
.sec { border-bottom:1px solid var(--border); }
.sec:last-child { border-bottom:none; }
.sec .sech { display:flex; align-items:center; gap:8px; padding:10px 16px; cursor:pointer; font-weight:600; font-size:13.5px; }
.sec .sech:hover { background:var(--plane); }
.sec .sech .car { color:var(--muted); font-size:10px; transition:transform .15s; display:inline-block; }
.sec.open .sech .car { transform:rotate(90deg); }
.sec .sech .sl { margin-left:auto; font-size:11px; color:var(--muted); font-weight:500; font-variant-numeric:tabular-nums; }
.sec .secb { display:none; }
.sec.open .secb { display:block; }
.sec .secb .doctext { padding-top:2px; }
@media (max-width:820px){ .doctext { font-size:15.5px; line-height:1.66; max-width:none; } .docbody { max-height:none; } }
.timeline { max-height:520px; overflow:auto; padding:4px 0; }
.tl { padding:12px 16px; border-bottom:1px solid var(--border); position:relative; cursor:pointer; }
.tl:last-child { border-bottom:none; }
.tl:hover { background:var(--plane); }
.tl.open { cursor:default; }
.tl .row1 { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.badge { font-size:10.5px; font-weight:650; padding:2px 7px; border-radius:5px; letter-spacing:0.02em; white-space:nowrap; }
.badge.in { background:color-mix(in srgb, var(--s2) 16%, transparent); color:var(--s2); }
.badge.out { background:color-mix(in srgb, var(--s1) 16%, transparent); color:var(--s1); }
.badge.k { background:var(--plane); color:var(--ink2); border:1px solid var(--border); }
.badge.s-open { background:color-mix(in srgb, var(--warning) 22%, transparent); color:var(--ink); }
.badge.s-in_progress { background:color-mix(in srgb, var(--s1) 16%, transparent); color:var(--s1); }
.badge.s-done { background:color-mix(in srgb, var(--good) 16%, transparent); color:var(--good); }
.badge.s-failed { background:color-mix(in srgb, var(--critical) 16%, transparent); color:var(--critical); }
.badge.s-deferred { background:var(--plane); color:var(--muted); border:1px solid var(--border); }
.badge.s-cancelled { background:var(--plane); color:var(--muted); border:1px solid var(--border); text-decoration:line-through; }
.tl .subj { font-weight:550; font-size:13px; }
.tl .ts { margin-left:auto; font-size:11.5px; color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
.tl .snip { color:var(--ink2); font-size:12.5px; margin-top:5px; white-space:pre-wrap;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
/* expanded full message — readable long-form on mobile */
.tl .full { margin-top:9px; font-size:14.5px; line-height:1.62; color:var(--ink);
  white-space:pre-wrap; word-break:break-word; max-width:68ch; }
.tl .meta2 { display:flex; align-items:center; gap:10px; margin-top:7px; flex-wrap:wrap; }
.tl .len { font-size:11px; color:var(--muted); }
.tl .toggle { font-size:11.5px; color:var(--s1); font-weight:600; margin-left:auto; }
.tl.loading .toggle::after { content:' …'; }
.msgpeek { margin-top:8px; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--plane);
  font-size:13px; line-height:1.55; white-space:pre-wrap; word-break:break-word; max-height:260px; overflow:auto; }
.msgpeek .ph { font-size:11px; color:var(--muted); margin-bottom:4px; }
@media (max-width:820px){
  .tl .full { font-size:15.5px; line-height:1.66; max-width:none; }
  .tl .ts { margin-left:0; flex-basis:100%; }
  .timeline, .doclist { max-height:none; }
}
table { width:100%; border-collapse:collapse; font-size:12.5px; }
th,td { text-align:left; padding:8px 15px; border-bottom:1px solid var(--border); vertical-align:top; }
th { color:var(--muted); font-weight:500; font-size:11.5px; text-transform:uppercase; letter-spacing:0.03em; }
td.num, th.num { font-variant-numeric:tabular-nums; }
.tag { font-size:11px; color:var(--ink2); background:var(--plane); border:1px solid var(--border); padding:1px 7px; border-radius:5px; text-transform:capitalize; }
.st { display:inline-flex; align-items:center; gap:5px; }
.muted { color:var(--muted); }
.spark { display:block; width:100%; height:54px; }
.usage { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:1px; background:var(--border); }
.usage .u { background:var(--surface); padding:12px 15px; }
.usage .uk { font-size:11.5px; color:var(--muted); }
.usage .uv { font-size:20px; font-weight:640; letter-spacing:-0.01em; margin-top:2px; font-variant-numeric:tabular-nums; }
.usage .uv small { font-size:12px; color:var(--ink2); font-weight:500; }
.two { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px; }
@media (max-width:820px){ .two { grid-template-columns:1fr; } }
.empty { padding:20px 15px; color:var(--muted); font-size:13px; }
.err { font-family:ui-monospace,monospace; font-size:11.5px; color:var(--ink2); word-break:break-word; }
.legend { display:flex; gap:14px; padding:0 15px 12px; font-size:11.5px; color:var(--ink2); }
.legend i { width:9px; height:9px; border-radius:2px; display:inline-block; margin-right:5px; vertical-align:middle; }
.foot { margin-top:26px; color:var(--muted); font-size:11.5px; }
.reload { cursor:pointer; }
/* requests tab */
.chips { display:flex; gap:6px; flex-wrap:wrap; padding:10px 15px; border-bottom:1px solid var(--border); align-items:center; }
.chip { font-size:11.5px; padding:2px 9px; border-radius:999px; border:1px solid var(--border); color:var(--ink2); font-variant-numeric:tabular-nums; white-space:nowrap; }
.chip b { color:var(--ink); }
.filters { margin-left:auto; display:flex; gap:4px; }
.filters button { font-size:11.5px; padding:3px 9px; border-radius:6px; border:1px solid var(--border); background:transparent; color:var(--ink2); cursor:pointer; }
.filters button.on { background:var(--s1); color:#fff; border-color:var(--s1); }
.reqwrap { max-height:640px; overflow:auto; }
.reqwrap td { font-size:12.5px; }
.reqwrap .lbl { font-weight:550; }
.reqwrap .spec { color:var(--muted); font-size:11.5px; margin-top:2px; max-width:36ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.reqwrap .note { color:var(--ink2); font-size:11.5px; max-width:28ch; word-break:break-word; }
.thumb { width:36px; height:36px; object-fit:cover; border-radius:5px; vertical-align:middle; margin-right:6px; border:1px solid var(--border); }
.acts { display:flex; gap:8px; white-space:nowrap; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>securus-agent</h1>
    <span id="healthPill" class="pill"><span class="dot" id="healthDot"></span><span id="healthTxt">loading…</span></span>
    <span id="reqPill" class="pill link" onclick="goRequests()" title="open requests for this contact" style="display:none">open requests <b id="reqPillN">—</b></span>
    <span id="contactSwitch" class="switch"></span>
    <span class="sub" id="genAt"></span>
    <span class="sub reload" onclick="load()" style="margin-left:auto">↻ refresh</span>
  </header>

  <div class="alerts" id="alerts"></div>
  <div class="tiles" id="tiles"></div>

  <div class="two">
    <div class="card">
      <h2>Message volume · last 14 days</h2>
      <div class="legend"><span><i style="background:var(--s2)"></i>from Sam</span><span><i style="background:var(--s1)"></i>from Dennis</span></div>
      <svg class="spark" id="spark" viewBox="0 0 600 54" preserveAspectRatio="none" role="img" aria-label="Daily message volume"></svg>
    </div>
    <div class="card">
      <h2>Failed queue parts</h2>
      <div id="failed"></div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <h2>Claude usage &amp; cost</h2>
    <div class="usage" id="usage"></div>
  </div>

  <div class="grid2" style="margin-top:16px">
    <div class="card">
      <h2 id="docsTitle">Sam's documents</h2>
      <div class="doclist" id="doclist"></div>
    </div>
    <div class="card">
      <div class="panelhead">
        <h2 id="tlTitle">Document</h2>
        <div class="tabs" id="tabs">
          <button class="tab active" data-tab="document" onclick="setTab('document')">Document</button>
          <button class="tab" data-tab="history" onclick="setTab('history')">History</button>
          <button class="tab" data-tab="entries" onclick="setTab('entries')">Entries</button>
          <button class="tab" data-tab="images" onclick="setTab('images')">Images</button>
          <button class="tab" data-tab="requests" onclick="setTab('requests')">Requests</button>
        </div>
      </div>
      <div id="docview" class="docbody"><div class="empty">Select a topic to read its combined document.</div></div>
      <div class="timeline" id="timeline" style="display:none"><div class="empty">Select a document to see its update history.</div></div>
      <div class="timeline" id="entries" style="display:none"><div class="empty">Select a document to see its entries ledger.</div></div>
      <div id="gallery" style="display:none"><div class="empty">No images generated for this project yet.</div></div>
      <div id="requests" style="display:none"><div class="empty">Loading requests…</div></div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <h2>Recent activity</h2>
    <div id="recent"></div>
  </div>

  <div class="foot" id="foot"></div>
</div>

<script>
const TOKEN = ${JSON.stringify(t)};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const HEALTH = { good:'var(--good)', warning:'var(--warning)', serious:'var(--serious)', critical:'var(--critical)' };
let DATA = null, activeDoc = null, activeContact = 'sam';

// ── shared pure helpers (same source as src/dashboard.mjs exports; unit-tested there) ──
${CLIENT_HELPERS}

function qs(extra) {
  const p = new URLSearchParams();
  if (TOKEN) p.set('token', TOKEN);
  if (extra) for (const k in extra) p.set(k, extra[k]);
  const s = p.toString();
  return s ? ('?' + s) : '';
}

async function load() {
  $('healthTxt').textContent = 'loading…';
  try {
    const r = await fetch('/api/dashboard' + qs({ contact: activeContact }));
    if (!r.ok) { $('healthTxt').textContent = 'error ' + r.status; return; }
    DATA = await r.json();
    render();
  } catch (e) { $('healthTxt').textContent = 'fetch failed'; }
}

// display name for inbound badges — the active contact's short name
function inName() {
  const id = (DATA && DATA.activeContact) || activeContact || 'sam';
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// the contact's display name as the switcher shows it (first name) — entries author badge
function contactName() {
  const id = (DATA && DATA.activeContact) || activeContact || 'sam';
  const c = ((DATA && DATA.contacts) || []).find(x => x.id === id);
  const s = ((c && c.name) || id).split(' ')[0].toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function goRequests() {
  setTab('requests');
  const head = $('tlTitle'); if (head && head.scrollIntoView) head.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function switchContact(id) {
  if (id === activeContact) return;
  activeContact = id;
  activeDoc = null;          // don't carry a doc selection across contacts
  docCache && Object.keys(docCache).forEach(k => delete docCache[k]);
  reqCache = null;
  for (const k in imgByReq) delete imgByReq[k];
  load();
}

function render() {
  const d = DATA;
  for (const k in docCache) delete docCache[k]; // re-fetch open doc on refresh (catches version bumps)
  reqCache = null;
  activeContact = d.activeContact || activeContact;

  // contact switcher — keeps each inmate's data on its own screen
  const cs = d.contacts || [];
  const title = (s) => { s = (s||'').split(' ')[0].toLowerCase(); return s.charAt(0).toUpperCase()+s.slice(1); };
  $('contactSwitch').innerHTML = cs.length > 1
    ? cs.map(c => '<button class="'+(c.id===activeContact?'on':'')+'" data-cid="'+esc(c.id)+'" onclick="switchContact(this.dataset.cid)">'+esc(title(c.name||c.id))+(c.language==='es'?' 🇪🇸':'')+'</button>').join('')
    : '';
  $('docsTitle').textContent = inName() + "'s documents";

  $('healthDot').style.background = HEALTH[d.health] || 'var(--muted)';
  $('healthTxt').textContent = d.health;
  $('genAt').textContent = 'updated ' + new Date(d.generatedAt).toLocaleString();

  // open-requests chip (v2 ledger) — hidden when the worker has no ledger yet
  const rc = d.requestCounts || null;
  $('reqPill').style.display = rc ? '' : 'none';
  $('reqPillN').textContent = rc ? String(rc.open || 0) : '—';

  $('alerts').innerHTML = (d.alerts || []).map(a =>
    '<div class="alert"><span class="dot" style="background:var(--serious)"></span>' + esc(a) + '</div>').join('') || '';

  const s = d.state || {};
  const queue = d.queue || {};
  const tiles = [
    ['Stamps', s.stampBalance == null ? '—' : s.stampBalance],
    ['Unresponded', (d.unresponded || []).length],
    ['Open requests', rc ? (rc.open || 0) + (rc.in_progress ? '<small> +' + rc.in_progress + ' working</small>' : '') : '—', 'requests'],
    ['Queue pending', queue.pending ?? '—'],
    ['Queue failed', queue.failed ?? '—'],
    ['Total sent', s.totalMessagesSent ?? '—'],
    ['Last check', s.staleHours == null ? '—' : s.staleHours >= 999 ? 'never' : (s.staleHours < 1 ? Math.round(s.staleHours*60)+'m ago' : s.staleHours.toFixed(1)+'h ago')],
  ];
  $('tiles').innerHTML = tiles.map(([k,v,tab]) =>
    '<div class="tile'+(tab?' link':'')+'"'+(tab?' onclick="goRequests()"':'')+'><div class="k">'+esc(k)+'</div><div class="v">'+(tab?v:esc(v))+'</div></div>').join('');

  // Claude usage & cost
  const u = d.usage;
  if (u) {
    const fmt = (n) => (n||0).toLocaleString();
    const cells = [
      ['Requests', fmt(u.requests)],
      ['Total tokens', fmt(u.totalTokens)],
      ['Avg tokens / req', fmt(u.avgTokensPerRequest)],
      ['Input tokens', fmt(u.inputTokens)],
      ['Output tokens', fmt(u.outputTokens)],
      ['Avg cost / req', '<small>$</small>' + (u.avgCostPerRequest||0).toFixed(4)],
      ['Total cost', '<small>$</small>' + (u.totalCostUsd||0).toFixed(2)],
    ];
    $('usage').innerHTML = cells.map(([k,v]) =>
      '<div class="u"><div class="uk">'+esc(k)+'</div><div class="uv">'+v+'</div></div>').join('');
  } else {
    $('usage').innerHTML = '<div class="u"><div class="uk">No usage recorded yet.</div></div>';
  }

  // sparkline
  drawSpark(d.daily || []);

  // failed
  const failedRows = d.failed || [];
  $('failed').innerHTML = failedRows.length ? (
    '<table><thead><tr><th>Q#</th><th>Inbound</th><th>Part</th><th>Retries</th><th>Error</th></tr></thead><tbody>' +
    failedRows.map(f => '<tr><td class="num">'+f.id+'</td><td class="num">'+esc(f.inbound_id)+'</td><td class="num">'+f.part_num+'/'+f.total_parts+'</td><td class="num">'+(f.retry_count||0)+'</td><td class="err">'+esc(f.error||'')+'</td></tr>').join('') +
    '</tbody></table>'
  ) : '<div class="empty">None — queue clean.</div>';

  // documents — live first, protected/archived after (grey + lock)
  const docs = sortDocsForList(d.docs || []);
  $('doclist').innerHTML = docs.map(doc => {
    const lbl = docListLabel(doc);
    const docState = lbl
      ? '<span class="muted">'+esc(lbl)+'</span>'
      : '<span style="color:var(--serious)">no doc built</span>';
    const range = doc.first_date ? esc(doc.first_date)+' → '+esc(doc.last_date) : (doc.protected ? 'read-only' : 'no messages');
    const msgs = doc.total ? doc.total+' msgs' : '<span class="muted">—</span>';
    return '<div class="docitem'+(doc.protected?' prot':'')+'" data-doc="'+esc(doc.doc_tag)+'" onclick="selectDoc(this.dataset.doc)" title="'+esc(doc.title||doc.doc_tag)+'">' +
      '<div><div class="nm">'+esc(doc.doc_tag)+(doc.protected?'<span class="lock" title="protected — read-only">🔒</span>':'')+'</div>' +
      '<div class="meta">'+range+'</div></div>' +
      '<div class="cnt">'+msgs+'<br>'+docState+'</div>' +
    '</div>';
  }).join('') || '<div class="empty">No documents yet.</div>';
  if (!activeDoc && docs.length) selectDoc(docs[0].doc_tag);
  else if (activeDoc) selectDoc(activeDoc);
  if (activeTab === 'requests') loadRequests(true);

  // recent
  const recentRows = d.recent || [];
  $('recent').innerHTML =
    '<table><thead><tr><th>#</th><th>Dir</th><th>Subject</th><th>Topic</th><th>When</th><th>State</th></tr></thead><tbody>' +
    recentRows.map(m => {
      const dir = m.direction === 'inbound' ? '<span class="badge in">'+inName()+'</span>' : '<span class="badge out">Dennis</span>';
      let state = '';
      if (m.direction === 'inbound') {
        if (!m.responded_at) state = '<span class="st" style="color:var(--serious)">● unresponded</span>';
        else if (String(m.responded_at).startsWith('duplicate')) state = '<span class="muted">duplicate</span>';
        else if (m.responded_at === 'escalated') state = '<span style="color:var(--warning)">escalated</span>';
        else state = '<span class="st" style="color:var(--good)">✓ replied</span>';
      } else {
        state = m.confirmed_sent ? '<span class="st" style="color:var(--good)">✓ sent</span>' : '<span class="muted">sent</span>';
      }
      return '<tr id="msg-'+m.id+'"><td class="num">'+m.id+'</td><td>'+dir+'</td><td>'+esc((m.subject||'').slice(0,52))+'</td><td>'+(m.doc_tag?'<span class="tag">'+esc(m.doc_tag)+'</span>':'')+'</td><td class="muted">'+esc(m.ts)+'</td><td>'+state+'</td></tr>';
    }).join('') + '</tbody></table>';

  $('foot').innerHTML = 'securus-agent dashboard · ' +
    (s.lastError ? 'last error: <span class="err">'+esc(s.lastError)+'</span>' : 'no recent errors');
}

const msgCache = {};
const docCache = {};
const imgByReq = {};       // request_id → image id, filled from gallery loads (thumbnails in Requests)
let reqCache = null;       // { requests, counts } for the active contact, or { unavailable: true }
let reqFilter = 'open';
let activeTab = 'document';

const PANES = { document:'docview', history:'timeline', entries:'entries', images:'gallery', requests:'requests' };
const TITLES = { document:'Document', history:'Update history', entries:'Entries', images:'Images', requests:'Requests' };

function updateTitle() {
  const suffix = activeTab === 'requests' ? ' · ' + inName() : (activeDoc ? ' · ' + activeDoc : '');
  $('tlTitle').textContent = (TITLES[activeTab] || 'Document') + suffix;
}

function setTab(tab) {
  if (!PANES[tab]) tab = 'document';
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  for (const k in PANES) $(PANES[k]).style.display = k === tab ? '' : 'none';
  updateTitle();
  if (tab === 'images' && activeDoc) loadGallery(activeDoc);
  if (tab === 'entries' && activeDoc) loadEntries(activeDoc);
  if (tab === 'requests') loadRequests();
}

async function loadGallery(tag) {
  const g = $('gallery');
  g.innerHTML = '<div class="empty">Loading images…</div>';
  try {
    const r = await fetch('/api/images' + qs({ contact: activeContact, tag }));
    if (!r.ok) throw new Error('http ' + r.status);
    const d2 = await r.json();
    const imgs = d2.images || [];
    for (const im of imgs) if (im.request_id != null) imgByReq[im.request_id] = im.id;
    if (tag !== activeDoc) return;
    if (!imgs.length) { g.innerHTML = '<div class="empty">No images generated for this project yet.</div>'; return; }
    g.innerHTML = imgs.map(im => {
      const chain = im.parent_image_id ? ' · revision of #' + im.parent_image_id : '';
      const meta = imageCardMeta(im);
      return '<div style="padding:14px 0;border-bottom:1px solid var(--border)">' +
        '<img src="/image/' + im.id + qs() + '" style="max-width:320px;max-height:320px;border-radius:8px;display:block;margin-bottom:8px" loading="lazy">' +
        (meta ? '<div style="font-size:13px;font-weight:600;margin-bottom:2px">' + esc(meta) + '</div>' : '') +
        '<div style="font-size:12px;color:var(--muted)">#' + im.id + ' · ' + esc((im.created_at||'').substring(0,16)) + chain + (im.cost ? ' · $' + Number(im.cost).toFixed(2) : '') + (im.hf_request_id ? ' · hf ' + esc(String(im.hf_request_id).slice(0,8)) : '') + '</div>' +
        (im.intent ? '<div style="font-size:13px;margin-top:4px"><b>Asked:</b> ' + esc(im.intent.substring(0,200)) + '</div>' : '') +
        '<div style="font-size:13px;margin-top:4px;color:var(--ink2)"><b>Prompt:</b> ' + esc((im.prompt||'').substring(0,400)) + '</div>' +
      '</div>';
    }).join('');
  } catch (e) { g.innerHTML = '<div class="empty">Failed to load images.</div>'; }
}

// one fetch per (contact, tag) per refresh — the Document and Entries tabs share it
async function fetchDoc(tag) {
  let doc = docCache[tag];
  if (!doc) {
    const r = await fetch('/api/document/' + encodeURIComponent(tag) + qs({ contact: activeContact }));
    if (!r.ok) throw new Error('http ' + r.status);
    doc = await r.json(); docCache[tag] = doc;
  }
  return doc;
}

async function loadDocView(tag) {
  const dv = $('docview');
  const summary = (DATA.docs || []).find(x => x.doc_tag === tag);
  if (summary && !summary.doc_version && summary.version == null) {
    dv.innerHTML = '<div class="docnone">No combined document has been built for <b>'+esc(tag)+'</b> yet.<br><br>'+
      'It builds automatically the next time a <code>makeupdate '+esc(tag)+'</code> comes in, or you can build it now from existing history:<br><br>'+
      '<code>/rebuild-doc/'+esc(tag)+'?contact='+esc(activeContact)+'&token=…</code></div>';
    return;
  }
  dv.innerHTML = '<div class="docnone">loading…</div>';
  try {
    const doc = await fetchDoc(tag);
    if (tag !== activeDoc) return; // user switched away while loading
    const D = doc.doc || {};
    const sections = parseSectionsJson(D.sections);
    const content = D.content || (sections ? sections.map(s => '## ' + s.heading + '\\n\\n' + s.body).join('\\n\\n') : '');
    if (!content) { dv.innerHTML = '<div class="docnone">No document body.</div>'; return; }
    const upd = (D.updated_at || '').replace('T',' ').slice(0,16);
    const clog = changelogLines(D.changelog);
    const entriesN = Array.isArray(doc.entries) ? doc.entries.length : null;
    let html =
      '<div class="docmeta"><span class="vtag">v'+esc(D.version ?? '?')+'</span>' +
      (D.protected ? '<span class="vtag prot" title="read-only: commands cannot modify this document">🔒 Protected</span>' : '') +
      '<span class="m">'+content.length.toLocaleString()+' chars</span>' +
      (upd ? '<span class="m">·  updated '+esc(upd)+'</span>' : '') +
      '<span class="m">·  '+(doc.versions ? doc.versions.length : 1)+' revisions</span>' +
      (entriesN != null ? '<span class="m">·  '+entriesN+' entries</span>' : '') +
      (sections ? '<span class="m">·  '+sections.length+' sections</span>' : '') +
      '</div>';
    if (clog.length) {
      html += '<div class="clog'+(clog.length > 5 ? ' collapsed' : '')+'" id="clog"><h3>Change log' +
        (clog.length > 5 ? ' <button class="lnk" onclick="toggleClog()" id="clogBtn">show all '+clog.length+'</button>' : '') +
        '</h3><ul>' + clog.map(l => '<li>'+esc(l)+'</li>').join('') + '</ul></div>';
    }
    if (sections) {
      html += '<div class="secbar"><span>'+sections.length+' sections</span>' +
        '<button class="lnk" onclick="toggleAllSections(true)">expand all</button>' +
        '<button class="lnk" onclick="toggleAllSections(false)">collapse all</button></div>';
      html += sections.map((s, i) =>
        '<div class="sec'+(i === 0 ? ' open' : '')+'">' +
          '<div class="sech" onclick="this.parentNode.classList.toggle(\\'open\\')"><span class="car">▶</span><span></span><span class="sl">'+fmtK(s.body.length)+'</span></div>' +
          '<div class="secb"><div class="doctext"></div></div>' +
        '</div>').join('');
      dv.innerHTML = html;
      const secs = dv.querySelectorAll('.sec');
      sections.forEach((s, i) => {
        const node = secs[i]; if (!node) return;
        const h = node.querySelector('.sech span:nth-child(2)'); if (h) h.textContent = s.heading;
        const b = node.querySelector('.doctext'); if (b) b.textContent = s.body || '(empty section)';
      });
    } else {
      dv.innerHTML = html + '<div class="doctext"></div>';
      dv.querySelector('.doctext').textContent = content;
    }
  } catch (e) {
    dv.innerHTML = '<div class="docnone">failed to load document ('+esc(e.message)+')</div>';
  }
}

function toggleClog() {
  const c = $('clog'); if (!c) return;
  const collapsed = c.classList.toggle('collapsed');
  const n = c.querySelectorAll('li').length;
  $('clogBtn').textContent = collapsed ? 'show all ' + n : 'show fewer';
}

function toggleAllSections(open) {
  document.querySelectorAll('#docview .sec').forEach(s => s.classList.toggle('open', open));
}

// ── Entries ledger (documents v2) ──
async function loadEntries(tag) {
  const el = $('entries');
  el.innerHTML = '<div class="empty">Loading entries…</div>';
  try {
    const doc = await fetchDoc(tag);
    if (tag !== activeDoc) return;
    if (!Array.isArray(doc.entries)) {
      el.innerHTML = '<div class="empty">Entries ledger not available — the deployed worker predates documents v2.</div>';
      return;
    }
    const rows = doc.entries.slice().sort((a, b) => (b.id || 0) - (a.id || 0));
    if (!rows.length) { el.innerHTML = '<div class="empty">No entries yet. They start with the first <code>makeupdate</code> after the v2 migration.</div>'; return; }
    el.innerHTML = rows.map(e => {
      const isAi = e.author === 'ai';
      const who = entryAuthorName(e.author, isAi ? null : contactName());
      const badge = '<span class="badge '+(isAi ? 'out' : 'in')+'">'+esc(who)+'</span>';
      const links = [
        e.inbound_id != null ? '<button class="lnk" onclick="event.stopPropagation();peekMessage(this,'+Number(e.inbound_id)+')">inbound #'+Number(e.inbound_id)+'</button>' : '',
        e.outbound_id != null ? '<button class="lnk" onclick="event.stopPropagation();peekMessage(this,'+Number(e.outbound_id)+')">outbound #'+Number(e.outbound_id)+'</button>' : '',
      ].filter(Boolean).join(' ');
      const len = e.content_len != null ? e.content_len : (e.content ? e.content.length : 0);
      const hasBody = !!(e.content && e.content.length);
      return '<div class="tl entry" data-eid="'+esc(e.id)+'" onclick="toggleEntryContent(this)">' +
        '<div class="row1">'+badge+'<span class="subj">'+esc(e.summary || '(no summary)')+'</span><span class="ts">'+esc(e.entry_date || (e.created_at||'').slice(0,10))+'</span></div>' +
        (hasBody ? '<div class="snip">'+esc(e.content.slice(0, 240))+'</div>' : '') +
        '<div class="meta2"><span class="len">entry #'+esc(e.id)+' · '+fmtK(len)+' chars</span>'+links+(hasBody ? '<span class="toggle">Read full ▾</span>' : '')+'</div>' +
        '<div class="peekslot"></div>' +
        '</div>';
    }).join('');
    // bodies via textContent so nothing in Sam's text is interpreted as markup
    el.querySelectorAll('.tl.entry').forEach((row, i) => { row._content = rows[i].content || ''; });
  } catch (e) {
    el.innerHTML = '<div class="empty">Failed to load entries ('+esc(e.message)+').</div>';
  }
}

function toggleEntryContent(el) {
  if (!el._content) return;
  const snip = el.querySelector('.snip'), tog = el.querySelector('.toggle');
  if (el.classList.contains('open')) {
    el.classList.remove('open');
    const f = el.querySelector('.full'); if (f) f.remove();
    if (snip) snip.style.display = '';
    if (tog) tog.textContent = 'Read full ▾';
    return;
  }
  el.classList.add('open');
  if (snip) snip.style.display = 'none';
  const full = document.createElement('div');
  full.className = 'full';
  full.textContent = el._content;
  el.querySelector('.meta2').before(full);
  if (tog) tog.textContent = 'Collapse ▴';
}

// inline peek at a message by id (entries + requests link to inbound/outbound ids)
async function peekMessage(btn, id) {
  const host = btn.closest('.tl, tr');
  if (!host) return;
  const slot = host.querySelector('.peekslot') || btn.parentNode;
  const existing = slot.querySelector('.msgpeek[data-mid="'+id+'"]');
  if (existing) { existing.remove(); return; }
  const box = document.createElement('div');
  box.className = 'msgpeek'; box.dataset.mid = id;
  box.innerHTML = '<div class="ph">message #'+id+' · loading…</div>';
  box.onclick = (ev) => ev.stopPropagation();
  slot.appendChild(box);
  try {
    let m = msgCache[id];
    if (!m) {
      const r = await fetch('/api/message/' + id + qs());
      if (!r.ok) throw new Error('http ' + r.status);
      m = await r.json(); msgCache[id] = m;
    }
    box.innerHTML = '<div class="ph"></div><div class="pb"></div>';
    box.querySelector('.ph').textContent = 'message #' + id + ' · ' + (m.direction || '') + ' · ' + (m.ts || '') + (m.subject ? ' · ' + m.subject : '');
    box.querySelector('.pb').textContent = m.body || '(empty)';
  } catch (e) {
    box.innerHTML = '<div class="ph">message #'+id+' — failed to load ('+esc(e.message)+')</div>';
  }
}

// ── Requests ledger ──
async function loadRequests(force) {
  const el = $('requests');
  if (!reqCache || force) {
    if (!reqCache) el.innerHTML = '<div class="empty">Loading requests…</div>';
    try {
      const r = await fetch('/api/requests' + qs({ contact: activeContact }));
      if (r.status === 404) reqCache = { unavailable: true, reason: 'the deployed worker has no /api/requests yet' };
      else if (!r.ok) reqCache = { unavailable: true, reason: 'http ' + r.status };
      else {
        const j = await r.json();
        reqCache = { requests: Array.isArray(j.requests) ? j.requests : [], counts: j.counts || null };
        if (reqCache.counts && DATA) { DATA.requestCounts = reqCache.counts; $('reqPillN').textContent = String(reqCache.counts.open || 0); $('reqPill').style.display = ''; }
      }
    } catch (e) { reqCache = { unavailable: true, reason: e.message }; }
  }
  renderRequests();
}

function setReqFilter(f) { reqFilter = f; renderRequests(); }

function renderRequests() {
  const el = $('requests');
  if (!reqCache) return;
  if (reqCache.unavailable) {
    el.innerHTML = '<div class="empty">Requests ledger not available — ' + esc(reqCache.reason || 'unknown') + '.</div>';
    return;
  }
  const all = reqCache.requests || [];
  const counts = reqCache.counts || all.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  const chip = (k, label) => '<span class="chip">'+esc(label)+' <b>'+(counts[k] || 0)+'</b></span>';
  const filt = (k, label) => '<button class="'+(reqFilter === k ? 'on' : '')+'" onclick="setReqFilter(\\''+k+'\\')">'+label+'</button>';
  const rows = all.filter(r => requestMatchesFilter(r.status, reqFilter));
  const now = Date.now();
  let html = '<div class="chips">' + chip('open','open') + chip('in_progress','in progress') + chip('done','done') + chip('failed','failed') +
    ((counts.deferred || counts.cancelled) ? '<span class="chip muted">'+(counts.deferred||0)+' deferred · '+(counts.cancelled||0)+' cancelled</span>' : '') +
    '<span class="filters">' + filt('open','open') + filt('all','all') + filt('done','done') + filt('failed','failed') + '</span></div>';
  if (!rows.length) {
    html += '<div class="empty">' + (all.length ? 'No ' + esc(reqFilter === 'open' ? 'open' : reqFilter) + ' requests.' : 'No requests recorded for ' + esc(inName()) + ' yet.') + '</div>';
    el.innerHTML = html; return;
  }
  html += '<div class="reqwrap"><table><thead><tr><th>#</th><th>Kind</th><th>Label</th><th>Status</th><th>Age</th><th>Source</th><th>Fulfilled by</th><th>Note</th><th></th></tr></thead><tbody>' +
    rows.map(r => {
      const spec = requestSpec(r);
      const isImg = r.kind === 'image';
      const thumbId = isImg ? imgByReq[r.id] : null;
      const specLine = isImg
        ? [spec.model ? 'model: ' + spec.model : '', spec.group ? 'group: ' + spec.group : '', spec.prompt ? spec.prompt : ''].filter(Boolean).join(' · ')
        : (spec.prompt || spec.question || spec.detail || '');
      const label = (thumbId ? '<img class="thumb" src="/image/'+thumbId+qs()+'" loading="lazy">' : '') +
        '<span class="lbl">'+esc(r.label || (isImg && spec.label) || '(untitled)')+'</span>' +
        (specLine ? '<div class="spec" title="'+esc(specLine)+'">'+esc(specLine)+'</div>' : '');
      const src = r.inbound_id != null
        ? '<button class="lnk" onclick="peekMessage(this,'+Number(r.inbound_id)+')">inbound #'+Number(r.inbound_id)+'</button>'
        : '<span class="muted">—</span>';
      const ful = r.fulfilled_by_outbound_id != null
        ? '<button class="lnk" onclick="peekMessage(this,'+Number(r.fulfilled_by_outbound_id)+')">outbound #'+Number(r.fulfilled_by_outbound_id)+'</button>'
        : '<span class="muted">—</span>';
      const age = relativeAge(r.created_at, now);
      const upd = r.updated_at && r.updated_at !== r.created_at ? ' · upd ' + relativeAge(r.updated_at, now) : '';
      const att = r.attempts ? ' · ' + r.attempts + ' att' : '';
      const canCancel = r.status === 'open' || r.status === 'in_progress' || r.status === 'deferred';
      const canReopen = r.status === 'done' || r.status === 'failed' || r.status === 'cancelled' || r.status === 'deferred';
      const acts = '<span class="acts">' +
        (canCancel ? '<button class="lnk danger" onclick="setRequestStatus(this,'+Number(r.id)+',\\'cancelled\\')">Cancel</button>' : '') +
        (canReopen ? '<button class="lnk" onclick="setRequestStatus(this,'+Number(r.id)+',\\'open\\')">Reopen</button>' : '') +
        (r.status !== 'done' && r.status !== 'cancelled' ? '<button class="lnk" onclick="setRequestStatus(this,'+Number(r.id)+',\\'done\\')">Done</button>' : '') +
        '</span>';
      return '<tr>' +
        '<td class="num">'+Number(r.id)+(r.priority != null ? '<div class="muted" style="font-size:10.5px">p'+esc(r.priority)+'</div>' : '')+'</td>' +
        '<td><span class="badge k">'+esc(r.kind || '?')+'</span></td>' +
        '<td>'+label+'</td>' +
        '<td><span class="badge s-'+esc(r.status || 'open')+'">'+esc(String(r.status || 'open').replace('_',' '))+'</span></td>' +
        '<td class="num" title="'+esc(r.created_at || '')+'">'+esc(age)+'<div class="muted" style="font-size:10.5px">'+esc((upd + att).replace(/^ · /, ''))+'</div></td>' +
        '<td>'+src+'</td>' +
        '<td>'+ful+'</td>' +
        '<td><div class="note">'+esc(r.note || '')+'</div></td>' +
        '<td>'+acts+'</td>' +
      '</tr>';
    }).join('') + '</tbody></table></div>';
  el.innerHTML = html;
}

async function setRequestStatus(btn, id, status) {
  const verb = status === 'cancelled' ? 'Cancel' : status === 'open' ? 'Reopen' : 'Mark done';
  if (!confirm(verb + ' request #' + id + '?')) return;
  const buttons = btn.closest('tr').querySelectorAll('button.lnk');
  buttons.forEach(b => b.disabled = true);
  try {
    const r = await fetch('/api/requests/' + id + qs(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, note: 'dashboard: ' + verb.toLowerCase() }),
    });
    if (!r.ok) throw new Error('http ' + r.status);
    await loadRequests(true);
  } catch (e) {
    buttons.forEach(b => b.disabled = false);
    alert('Could not update request #' + id + ' (' + e.message + ')');
  }
}

function selectDoc(tag) {
  activeDoc = tag;
  document.querySelectorAll('.docitem').forEach(el => el.classList.toggle('active', el.dataset.doc === tag));
  updateTitle();
  loadDocView(tag);
  if (activeTab === 'entries') loadEntries(tag);
  if (activeTab === 'images') loadGallery(tag);
  const items = ((DATA.history || {})[tag] || []);
  $('timeline').innerHTML = items.length ? items.slice().reverse().map(h => {
    const badge = h.direction === 'inbound' ? '<span class="badge in">'+inName()+'</span>' : '<span class="badge out">Dennis</span>';
    return '<div class="tl" data-id="'+h.id+'" onclick="toggleEntry(this)">' +
      '<div class="row1">'+badge+'<span class="subj">'+esc((h.subject||'').slice(0,70))+'</span><span class="ts">'+esc(h.ts)+'</span></div>' +
      '<div class="snip">'+esc(h.snippet||'')+'</div>' +
      '<div class="meta2"><span class="len">#'+h.id+' · '+h.body_len+' chars</span><span class="toggle">Read full ▾</span></div>' +
      '</div>';
  }).join('') : '<div class="empty">No history for this document.</div>';
  $('timeline').scrollTop = 0;
}

async function toggleEntry(el) {
  const id = el.dataset.id;
  if (el.classList.contains('open')) {
    el.classList.remove('open');
    const f = el.querySelector('.full'); if (f) f.remove();
    el.querySelector('.snip').style.display = '';
    el.querySelector('.toggle').textContent = 'Read full ▾';
    return;
  }
  el.classList.add('loading');
  el.querySelector('.toggle').textContent = 'loading';
  try {
    let m = msgCache[id];
    if (!m) {
      const r = await fetch('/api/message/' + id + (TOKEN ? ('?token=' + encodeURIComponent(TOKEN)) : ''));
      if (!r.ok) throw new Error('http ' + r.status);
      m = await r.json(); msgCache[id] = m;
    }
    el.classList.remove('loading');
    el.classList.add('open');
    el.querySelector('.snip').style.display = 'none';
    const full = document.createElement('div');
    full.className = 'full';
    full.textContent = m.body || '(empty)';
    el.querySelector('.meta2').before(full);
    el.querySelector('.toggle').textContent = 'Collapse ▴';
  } catch (e) {
    el.classList.remove('loading');
    el.querySelector('.toggle').textContent = 'failed to load — tap to retry';
  }
}

function drawSpark(daily) {
  const svg = $('spark'); const W = 600, H = 54, pad = 4;
  if (!daily.length) { svg.innerHTML = '<text x="10" y="30" fill="var(--muted)" font-size="12">no messages in range</text>'; return; }
  const max = Math.max(1, ...daily.map(d => Math.max(d.inbound, d.outbound)));
  const n = daily.length;
  const x = i => pad + (n === 1 ? W/2 : i * (W - 2*pad) / (n - 1));
  const y = v => H - pad - (v / max) * (H - 2*pad);
  const line = (key, color) => {
    const pts = daily.map((d,i) => x(i) + ',' + y(d[key])).join(' ');
    const dots = daily.map((d,i) => '<circle cx="'+x(i).toFixed(1)+'" cy="'+y(d[key]).toFixed(1)+'" r="2.4" fill="'+color+'"/>').join('');
    return '<polyline fill="none" stroke="'+color+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="'+pts+'"/>' + dots;
  };
  svg.innerHTML =
    '<line x1="'+pad+'" y1="'+(H-pad)+'" x2="'+(W-pad)+'" y2="'+(H-pad)+'" stroke="var(--baseline)" stroke-width="1"/>' +
    line('outbound','var(--s1)') + line('inbound','var(--s2)');
}

load();
setInterval(load, 60000);
</script>
</body>
</html>`;
}

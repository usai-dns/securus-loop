// Dashboard data + HTML for the securus-agent monitoring page.
// Served by the worker at /dashboard (HTML) and /api/dashboard (JSON).
// Read-only. Token-gated via env.DASH_TOKEN.

import { getState } from './db/state.mjs';
import { getDocument, getDocumentVersions } from './db/documents.mjs';
import { getUsageSnapshot } from './db/usage.mjs';
import { getContacts, DEFAULT_CONTACT } from './db/contacts.mjs';

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

  const docs = (await db.prepare(
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
  };
}

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
.switch { display:inline-flex; gap:4px; }
.switch button { font-size:12.5px; font-weight:600; padding:4px 12px; border-radius:999px; cursor:pointer;
  background:transparent; color:var(--ink2); border:1px solid var(--border); }
.switch button.on { background:var(--s1); color:#fff; border-color:var(--s1); }
.alerts { margin:12px 0 4px; display:flex; flex-direction:column; gap:6px; }
.alert { display:flex; align-items:center; gap:8px; padding:8px 11px; border-radius:8px;
  border:1px solid var(--border); background:var(--surface); font-size:13px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:16px 0; }
.tile { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:13px 15px; }
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
.docitem .cnt { font-size:12px; color:var(--ink2); font-variant-numeric:tabular-nums; white-space:nowrap; }
.panelhead { display:flex; align-items:center; gap:10px; padding:8px 15px; border-bottom:1px solid var(--border); }
.panelhead h2 { border:none; padding:0; flex:0 0 auto; }
.tabs { margin-left:auto; display:flex; gap:4px; }
.tab { font-size:12px; font-weight:600; padding:5px 12px; border-radius:7px; cursor:pointer;
  background:transparent; color:var(--ink2); border:1px solid var(--border); }
.tab.active { background:var(--s1); color:#fff; border-color:var(--s1); }
.docbody { max-height:640px; overflow:auto; }
.docmeta { padding:11px 16px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.docmeta .vtag { font-size:11.5px; font-weight:650; color:var(--s1); background:color-mix(in srgb,var(--s1) 14%,transparent); padding:2px 9px; border-radius:999px; }
.docmeta .m { font-size:11.5px; color:var(--muted); }
.doctext { padding:16px; font-size:14.5px; line-height:1.62; white-space:pre-wrap; word-break:break-word; color:var(--ink); max-width:72ch; }
.docnone { padding:20px 16px; color:var(--ink2); font-size:13.5px; }
.docnone code { background:var(--plane); border:1px solid var(--border); padding:1px 6px; border-radius:5px; font-size:12.5px; }
@media (max-width:820px){ .doctext { font-size:15.5px; line-height:1.66; max-width:none; } .docbody { max-height:none; } }
.timeline { max-height:520px; overflow:auto; padding:4px 0; }
.tl { padding:12px 16px; border-bottom:1px solid var(--border); position:relative; cursor:pointer; }
.tl:last-child { border-bottom:none; }
.tl:hover { background:var(--plane); }
.tl.open { cursor:default; }
.tl .row1 { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.badge { font-size:10.5px; font-weight:650; padding:2px 7px; border-radius:5px; letter-spacing:0.02em; }
.badge.in { background:color-mix(in srgb, var(--s2) 16%, transparent); color:var(--s2); }
.badge.out { background:color-mix(in srgb, var(--s1) 16%, transparent); color:var(--s1); }
.tl .subj { font-weight:550; font-size:13px; }
.tl .ts { margin-left:auto; font-size:11.5px; color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
.tl .snip { color:var(--ink2); font-size:12.5px; margin-top:5px; white-space:pre-wrap;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
/* expanded full message — readable long-form on mobile */
.tl .full { margin-top:9px; font-size:14.5px; line-height:1.62; color:var(--ink);
  white-space:pre-wrap; word-break:break-word; max-width:68ch; }
.tl .meta2 { display:flex; align-items:center; gap:10px; margin-top:7px; }
.tl .len { font-size:11px; color:var(--muted); }
.tl .toggle { font-size:11.5px; color:var(--s1); font-weight:600; margin-left:auto; }
.tl.loading .toggle::after { content:' …'; }
@media (max-width:820px){
  .tl .full { font-size:15.5px; line-height:1.66; max-width:none; }
  .tl .ts { margin-left:0; flex-basis:100%; }
  .timeline, .doclist { max-height:none; }
}
table { width:100%; border-collapse:collapse; font-size:12.5px; }
th,td { text-align:left; padding:8px 15px; border-bottom:1px solid var(--border); }
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
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>securus-agent</h1>
    <span id="healthPill" class="pill"><span class="dot" id="healthDot"></span><span id="healthTxt">loading…</span></span>
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
      <h2>Sam's documents</h2>
      <div class="doclist" id="doclist"></div>
    </div>
    <div class="card">
      <div class="panelhead">
        <h2 id="tlTitle">Document</h2>
        <div class="tabs" id="tabs">
          <button class="tab active" data-tab="document" onclick="setTab('document')">Document</button>
          <button class="tab" data-tab="history" onclick="setTab('history')">History</button>
        </div>
      </div>
      <div id="docview" class="docbody"><div class="empty">Select a topic to read its combined document.</div></div>
      <div class="timeline" id="timeline" style="display:none"><div class="empty">Select a document to see its update history.</div></div>
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

function switchContact(id) {
  if (id === activeContact) return;
  activeContact = id;
  activeDoc = null;          // don't carry a doc selection across contacts
  docCache && Object.keys(docCache).forEach(k => delete docCache[k]);
  load();
}

function render() {
  const d = DATA;
  for (const k in docCache) delete docCache[k]; // re-fetch open doc on refresh (catches version bumps)
  activeContact = d.activeContact || activeContact;

  // contact switcher — keeps each inmate's data on its own screen
  const cs = d.contacts || [];
  $('contactSwitch').innerHTML = cs.length > 1
    ? cs.map(c => '<button class="'+(c.id===activeContact?'on':'')+'" onclick="switchContact('+JSON.stringify(c.id)+')">'+esc((c.name||c.id).split(' ')[0])+(c.language==='es'?' 🇪🇸':'')+'</button>').join('')
    : '';

  $('healthDot').style.background = HEALTH[d.health] || 'var(--muted)';
  $('healthTxt').textContent = d.health;
  $('genAt').textContent = 'updated ' + new Date(d.generatedAt).toLocaleString();

  $('alerts').innerHTML = (d.alerts || []).map(a =>
    '<div class="alert"><span class="dot" style="background:var(--serious)"></span>' + esc(a) + '</div>').join('') || '';

  const s = d.state;
  const tiles = [
    ['Stamps', s.stampBalance == null ? '—' : s.stampBalance],
    ['Unresponded', d.unresponded.length],
    ['Queue pending', d.queue.pending],
    ['Queue failed', d.queue.failed],
    ['Total sent', s.totalMessagesSent],
    ['Last check', s.staleHours >= 999 ? 'never' : (s.staleHours < 1 ? Math.round(s.staleHours*60)+'m ago' : s.staleHours.toFixed(1)+'h ago')],
  ];
  $('tiles').innerHTML = tiles.map(([k,v]) =>
    '<div class="tile"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div></div>').join('');

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
  $('failed').innerHTML = d.failed.length ? (
    '<table><thead><tr><th>Q#</th><th>Inbound</th><th>Part</th><th>Retries</th><th>Error</th></tr></thead><tbody>' +
    d.failed.map(f => '<tr><td class="num">'+f.id+'</td><td class="num">'+esc(f.inbound_id)+'</td><td class="num">'+f.part_num+'/'+f.total_parts+'</td><td class="num">'+(f.retry_count||0)+'</td><td class="err">'+esc(f.error||'')+'</td></tr>').join('') +
    '</tbody></table>'
  ) : '<div class="empty">None — queue clean.</div>';

  // documents
  $('doclist').innerHTML = d.docs.map(doc => {
    const docState = doc.doc_version
      ? '<span class="muted">doc v'+doc.doc_version+' · '+(doc.doc_len||0).toLocaleString()+' ch</span>'
      : '<span style="color:var(--serious)">no doc built</span>';
    return '<div class="docitem" data-doc="'+esc(doc.doc_tag)+'" onclick="selectDoc(this.dataset.doc)">' +
      '<div><div class="nm">'+esc(doc.doc_tag)+'</div>' +
      '<div class="meta">'+esc(doc.first_date)+' → '+esc(doc.last_date)+'</div></div>' +
      '<div class="cnt">'+doc.total+' msgs<br>'+docState+'</div>' +
    '</div>';
  }).join('') || '<div class="empty">No documents yet.</div>';
  if (!activeDoc && d.docs.length) selectDoc(d.docs[0].doc_tag);
  else if (activeDoc) selectDoc(activeDoc);

  // recent
  $('recent').innerHTML =
    '<table><thead><tr><th>#</th><th>Dir</th><th>Subject</th><th>Topic</th><th>When</th><th>State</th></tr></thead><tbody>' +
    d.recent.map(m => {
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
      return '<tr><td class="num">'+m.id+'</td><td>'+dir+'</td><td>'+esc((m.subject||'').slice(0,52))+'</td><td>'+(m.doc_tag?'<span class="tag">'+esc(m.doc_tag)+'</span>':'')+'</td><td class="muted">'+esc(m.ts)+'</td><td>'+state+'</td></tr>';
    }).join('') + '</tbody></table>';

  $('foot').innerHTML = 'securus-agent dashboard · ' +
    (s.lastError ? 'last error: <span class="err">'+esc(s.lastError)+'</span>' : 'no recent errors');
}

const msgCache = {};
const docCache = {};
let activeTab = 'document';

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('docview').style.display = tab === 'document' ? '' : 'none';
  $('timeline').style.display = tab === 'history' ? '' : 'none';
  $('tlTitle').textContent = (tab === 'document' ? 'Document' : 'Update history') + (activeDoc ? ' · ' + activeDoc : '');
}

async function loadDocView(tag) {
  const dv = $('docview');
  const summary = (DATA.docs || []).find(x => x.doc_tag === tag);
  if (summary && !summary.doc_version) {
    dv.innerHTML = '<div class="docnone">No combined document has been built for <b>'+esc(tag)+'</b> yet.<br><br>'+
      'It builds automatically the next time a <code>makeupdate '+esc(tag)+'</code> comes in, or you can build it now from existing history:<br><br>'+
      '<code>/rebuild-doc/'+esc(tag)+'?contact='+esc(activeContact)+'&token=…</code></div>';
    return;
  }
  dv.innerHTML = '<div class="docnone">loading…</div>';
  try {
    let doc = docCache[tag];
    if (!doc) {
      const r = await fetch('/api/document/' + encodeURIComponent(tag) + qs({ contact: activeContact }));
      if (!r.ok) throw new Error('http ' + r.status);
      doc = await r.json(); docCache[tag] = doc;
    }
    if (tag !== activeDoc) return; // user switched away while loading
    if (!doc.doc || !doc.doc.content) { dv.innerHTML = '<div class="docnone">No document body.</div>'; return; }
    const upd = (doc.doc.updated_at || '').replace('T',' ').slice(0,16);
    dv.innerHTML =
      '<div class="docmeta"><span class="vtag">v'+doc.doc.version+'</span>' +
      '<span class="m">'+(doc.doc.content.length).toLocaleString()+' chars</span>' +
      '<span class="m">·  updated '+esc(upd)+'</span>' +
      '<span class="m">·  '+(doc.versions? doc.versions.length : 1)+' revisions</span></div>' +
      '<div class="doctext"></div>';
    dv.querySelector('.doctext').textContent = doc.doc.content;
  } catch (e) {
    dv.innerHTML = '<div class="docnone">failed to load document ('+esc(e.message)+')</div>';
  }
}

function selectDoc(tag) {
  activeDoc = tag;
  document.querySelectorAll('.docitem').forEach(el => el.classList.toggle('active', el.dataset.doc === tag));
  $('tlTitle').textContent = (activeTab === 'document' ? 'Document' : 'Update history') + ' · ' + tag;
  loadDocView(tag);
  const items = (DATA.history[tag] || []);
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

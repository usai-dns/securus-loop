// Pipeline test: a fake D1 (node:sqlite) + mocked Anthropic/Higgsfield drive the
// REAL worker (src/index.js) through /migrate → /draft?id= (dry run) →
// /generate → /api/* → carry-over → images. No network, no browser.
// Needs node >= 22.5 (node:sqlite); skips cleanly on older runtimes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch { console.log('Pipeline: node:sqlite unavailable on this runtime — skipped'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = (await import(path.join(ROOT, 'src/index.js'))).default;
let passedCount = 0, failedCount = 0;
// the worker logs every step; keep the test output to the checks (VERBOSE=1 to see it all)
const out = console.log.bind(console);
if (!process.env.VERBOSE) { console.log = () => {}; console.error = () => {}; }

// ── fake D1 over node:sqlite ──
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
// make it look like a pre-v2 production db: drop the v2 columns/tables so /migrate adds them
sqlite.exec(`
  DROP TABLE requests; DROP TABLE document_entries; DROP TABLE images; DROP TABLE image_chunks;
  CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id TEXT NOT NULL DEFAULT 'sam', doc_tag TEXT NOT NULL, intent TEXT, prompt TEXT NOT NULL, parent_image_id INTEGER, hf_request_id TEXT, mime TEXT, data_b64 TEXT, status TEXT DEFAULT 'completed', cost REAL, created_at TEXT DEFAULT (datetime('now')));
  ALTER TABLE documents DROP COLUMN protected; ALTER TABLE documents DROP COLUMN sections; ALTER TABLE documents DROP COLUMN changelog;
  ALTER TABLE send_queue DROP COLUMN image_ids; ALTER TABLE send_queue DROP COLUMN image_id;
`);
const fix = (v) => (v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
function stmt(sql, params = []) {
  const s = sqlite.prepare(sql);
  return {
    bind: (...args) => stmt(sql, args.map(fix)),
    first: async () => s.get(...params) ?? null,
    all: async () => ({ results: s.all(...params) }),
    run: async () => { const r = s.run(...params); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; },
  };
}
const DB = {
  prepare: (sql) => stmt(sql),
  batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
};

// ── mocked Anthropic ──
const calls = [];
function sse(text, usage = {}) {
  const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
  return ev({ type: 'message_start', message: { usage: { input_tokens: 100 } } })
    + ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    + ev({ type: 'message_delta', usage: { output_tokens: 200, ...usage } });
}
const REPLY = `Sam,\n\nGood to hear from you. Here is my full take on the drone — the exploded view idea is strong, and I'd push the top view toward a cleaner silhouette. On the parole question: the hearing window you mentioned lines up with what I found.\n\nMore soon,\nDennis`;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('api.anthropic.com')) {
    const body = JSON.parse(init.body);
    const sys = body.system || '';
    calls.push({ sys: sys.substring(0, 60), stream: !!body.stream });
    const json = (o) => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(o) }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 });
    if (sys.startsWith('You turn a message')) {
      // extractor: one answer + one research; an extra image ask only while mockExtraImage is on
      return json({ requests: [
        { kind: 'answer', label: 'Drone design feedback', spec: {}, priority: 7 },
        { kind: 'research', label: 'Parole hearing timeline', spec: {}, priority: 5 },
        // a genuinely new picture described in prose (long enough not to read as a restated directive)
        ...(globalThis.mockExtraImage ? [{ kind: 'image', label: 'Front view', spec: { prompt: 'a clean front view of the fully assembled prototype drone on a white background, product-render style', model: null, group: 'drone', count: 1 }, priority: 6 }] : []),
      ] });
    }
    if (sys.startsWith('You check a drafted reply')) {
      const ids = [...(init.body.match(/#(-?\d+) \[/g) || [])].map(s => parseInt(s.slice(1), 10));
      const m = init.body.match(/#(-?\d+) \[research\]/);
      return json({ done: ids.filter(id => !m || id !== parseInt(m[1], 10)), partial: m ? [{ id: parseInt(m[1], 10), note: 'dates not confirmed' }] : [] });
    }
    if (sys.startsWith('You maintain the authoritative STATE')) {
      // state extractor: one settled fact whose value the scenario controls
      return json({ changes: globalThis.mockStateValue ? [{ key: 'hardware.rangefinder', value: globalThis.mockStateValue, action: 'set', note: 'author confirmed the part' }] : [] });
    }
    if (sys.startsWith('You maintain a single living document')) {
      globalThis.lastPatchBody = init.body;
      return new Response(sse(JSON.stringify({ section_updates: [], new_sections: [{ heading: 'Drone design', body: 'Exploded view, top view, side, front. (AI) Assistant note: silhouettes.' }], changelog: 'Added Drone design from the 11-07 notes.' })), { status: 200 });
    }
    if (sys.startsWith('You maintain a continuity file')) {
      return json({}).text().then(() => new Response(JSON.stringify({ content: [{ type: 'text', text: '## Preferences & voice\n- likes depth\n## Projects index\n- drone — active\n## Commitments & cadence\n- none\n## Open threads\n- parole timeline\n## Glossary\n- VolEst' }], usage: { input_tokens: 5, output_tokens: 5 } })));
    }
    if (sys.startsWith('You write prompts for a text-to-image')) return json({ prompt: 'engineered prompt', note: 'kept it clean' });
    if (sys.startsWith('You tighten a personal letter')) return new Response(sse(JSON.stringify({ text: 'short', overflow_items: ['rest'] })));
    if (sys.startsWith('The sender keeps named living documents')) return json({ references: [] });
    if (sys.startsWith('You classify whether a message')) return json({ wantsImage: false });
    if (body.stream) return new Response(sse(REPLY), { status: 200 });
    return json({});
  }
  throw new Error(`unexpected fetch ${u}`);
};

globalThis.mockExtraImage = true;
const env = { DB, ANTHROPIC_API_KEY: 'test', DASH_TOKEN: '', SAM_CONTACT_ID: '65651103' };
const ctx = { waitUntil: () => {} };
const call = async (p, init) => { const r = await worker.fetch(new Request(`https://w.test${p}`, init), env, ctx); return r.json(); };
const check = (c, name) => { if (c) passedCount++; else { failedCount++; out(`  ✗ ${name}`); } };

// 1. migrate (twice — idempotent)
const m1 = await call('/migrate');
const errs = m1.migrations.filter(x => x.status === 'error');
check(errs.length === 0, `migrate: no errors ${JSON.stringify(errs)}`);
const m2 = await call('/migrate');
check(m2.migrations.every(x => x.status !== 'error'), 'migrate: idempotent re-run');
const cols = sqlite.prepare("PRAGMA table_info(send_queue)").all().map(r => r.name);
check(cols.includes('image_ids') && cols.includes('image_id'), 'migrate: send_queue.image_ids added');
check(sqlite.prepare("SELECT name FROM sqlite_master WHERE name IN ('requests','document_entries')").all().length === 2, 'migrate: requests + document_entries tables');

// 2. seed a #498-style inbound: MakeUpdate + two directives, one on an unverified model
sqlite.prepare(`INSERT INTO documents (contact_id, tag, title, content, version) VALUES ('sam','drone','Drone — working document','# Drone\n\n## Overview\n\nA drone project.\n\n## Backlog\n\n- nothing yet', 3)`).run();
sqlite.prepare(`INSERT INTO documents (contact_id, tag, title, content, version, protected) VALUES ('sam','qualia-bible','Qualia Series Bible','## Characters\n\nMany.', 1, 1)`).run();
sqlite.prepare(`INSERT INTO system_state (key, value) VALUES ('stamp_balance', '6')`).run();
const body = `MakeUpdate drone\n\nHere are my notes on the drone. Please give me your full take.\n\nMakeImage - Saga2: a figure in a rain-soaked alley, Saga aesthetic (Run this prompt on Seedream 5.0)\n\nMakeImage - Wytches2: a skeletal tree with eyes in the bark\n\nAlso, what is the parole hearing timeline for Colorado?`;
const ins = sqlite.prepare(`INSERT INTO messages (external_id, contact_id, direction, sender, subject, body, timestamp, doc_tag) VALUES ('x1','sam','inbound','SAMUEL MULLIKIN','Drone update','${body.replace(/'/g, "''")}','2026-11-07T10:00:00Z','drone')`).run();
const inboundId = Number(ins.lastInsertRowid);

// 3. dry run — no writes
const d = await call(`/draft?id=${inboundId}&images=0`);
check(d.dryRun === true && d.status === 'generated', `draft: status generated (${d.status} ${d.error || ''})`);
check(d.requests.filter(r => r.kind === 'image').length === 3, `draft: 3 image requests (2 directives + 1 extractor) got ${d.requests.filter(r => r.kind === 'image').length}`);
check(d.requests.find(r => r.label === 'Saga2')?.spec.model === 'seedream' && d.requests.find(r => r.label === 'Saga2')?.spec.modelRaw === 'Seedream 5.0', 'draft: Saga2 carries model + raw hint');
check(d.requests.every(r => r.id < 0), 'draft: in-memory requests (negative ids)');
check(sqlite.prepare("SELECT COUNT(*) n FROM requests").get().n === 0, 'draft: no request rows persisted');
check(sqlite.prepare("SELECT COUNT(*) n FROM send_queue").get().n === 0, 'draft: nothing queued');
check(d.footer.includes('Still working on:') && d.footer.includes('Saga2') && d.footer.includes('Stamps left after this message: 5'), `draft: footer lists deferred images + stamps → "${d.footer}"`);
check(d.manifest.openRequests.some(r => r.label === 'Parole hearing timeline'), 'draft: partial research item stays open in manifest');
check(d.parts.length === 1 && d.parts[0].subject === 'RE: Drone update', `draft: 1 part, subject "${d.parts[0]?.subject}"`);
check(d.text.startsWith("I've updated your Drone document") && d.text.includes('— — —'), 'draft: ack + separator + footer assembled');
check(sqlite.prepare("SELECT version FROM documents WHERE tag='drone'").get().version === 3, 'draft: document untouched');

// 4. real generate
const g = await call('/generate');
const gen = g.results.find(r => r.id === inboundId);
check(gen?.status === 'generated', `generate: status ${gen?.status} ${gen?.error || ''}`);
const reqs = sqlite.prepare("SELECT * FROM requests WHERE inbound_id = ? ORDER BY id").all(inboundId);
check(reqs.length === 5, `generate: 5 ledger rows persisted (got ${reqs.length}: ${reqs.map(r => r.kind + ':' + r.status).join(', ')})`);
check(reqs.find(r => r.label === 'Drone design feedback')?.status === 'done', 'generate: answer reconciled done');
check(reqs.find(r => r.label === 'Parole hearing timeline')?.status === 'open' && reqs.find(r => r.label === 'Parole hearing timeline')?.note === 'dates not confirmed', 'generate: partial research stays open with note');
check(reqs.filter(r => r.kind === 'image').every(r => r.status === 'open'), 'generate: images stay open when HF keys are missing (deferred, not failed)');
const q = sqlite.prepare("SELECT * FROM send_queue WHERE inbound_id = ?").all(inboundId);
check(q.length === 1 && q[0].total_parts === 1 && q[0].doc_tag === 'drone', `generate: 1 queued part (got ${q.length})`);
check(q[0].body.includes('Still working on:') && q[0].body.includes("Stamps left after this message: 5"), 'generate: queued body carries footer');
const doc = sqlite.prepare("SELECT * FROM documents WHERE tag='drone'").get();
check(doc.version === 4 && JSON.parse(doc.sections).some(s => s.heading === 'Drone design') && doc.content.includes('## Backlog'), `generate: doc patched to v${doc.version}, sections stored, untouched section kept`);
check((doc.changelog || '').startsWith('- 20') && doc.changelog.includes('Drone design'), `generate: changelog "${(doc.changelog || '').substring(0, 60)}"`);
const entries = sqlite.prepare("SELECT author, inbound_id FROM document_entries WHERE tag='drone' ORDER BY id").all();
check(entries.length === 2 && entries[0].author === 'sam' && entries[1].author === 'ai' && entries.every(e => e.inbound_id === inboundId), `generate: sam + ai entries (${JSON.stringify(entries)})`);
check(sqlite.prepare("SELECT * FROM documents WHERE tag='profile'").get()?.protected === 1, 'generate: profile doc created + protected');
check(g.results.some(r => r.status === 'profile_refreshed'), 'generate: profile refresh reported');

// 5. second run: dedup (already queued) — no second generation
const g2 = await call('/generate');
check(g2.results.find(r => r.id === inboundId)?.status === 'already_queued', 'generate#2: already_queued dedup');

// 6. protected doc refusal + MakeNew archive
sqlite.prepare(`INSERT INTO messages (external_id, contact_id, direction, sender, subject, body, timestamp, doc_tag) VALUES ('x2','sam','inbound','SAMUEL MULLIKIN','Bible','MakeUpdate qualia-bible\n\nchange the characters','2026-11-07T11:00:00Z','qualia-bible')`).run();
sqlite.prepare(`INSERT INTO messages (external_id, contact_id, direction, sender, subject, body, timestamp, doc_tag) VALUES ('x3','sam','inbound','SAMUEL MULLIKIN','New drone','MakeNew drone\n\nstart over with a fresh plan','2026-11-07T12:00:00Z','drone')`).run();
// mark the first as responded so it is out of the way
sqlite.prepare("UPDATE messages SET responded_at = datetime('now') WHERE id = ?").run(inboundId);
const g3 = await call('/generate');
const prot = g3.results.find(r => r.tag === 'qualia-bible');
check(prot?.status === 'protected_doc_refused', `protected: ${prot?.status}`);
check(sqlite.prepare("SELECT content FROM documents WHERE tag='qualia-bible'").get().content === '## Characters\n\nMany.', 'protected: body untouched');
check(sqlite.prepare("SELECT body FROM send_queue WHERE doc_tag='qualia-bible'").get()?.body.includes('protected reference document'), 'protected: refusal notice queued');
const mk = g3.results.find(r => r.status === 'generated' && r.archivedAs);
check(!!mk && /^drone-archived-\d{8}$/.test(mk.archivedAs), `makenew: archived as ${mk?.archivedAs}`);
const tags = sqlite.prepare("SELECT tag, version, protected FROM documents ORDER BY tag").all();
check(tags.some(t => t.tag === mk?.archivedAs && t.protected === 1 && t.version === 4), 'makenew: archive is protected and keeps v4');
check(tags.find(t => t.tag === 'drone')?.version === 1, `makenew: fresh drone doc at v1 (${JSON.stringify(tags)})`);
check(sqlite.prepare("SELECT body FROM send_queue WHERE inbound_id = (SELECT id FROM messages WHERE external_id='x3')").get()?.body.includes(`kept untouched as "${mk?.archivedAs}"`), 'makenew: ack names the archive');
check(sqlite.prepare("SELECT COUNT(*) n FROM document_entries WHERE tag = ?").get(mk?.archivedAs).n === 2, 'makenew: ledger entries moved with the archive');

// 7. API contract
const api = await call('/api/requests?contact=sam');
check(Array.isArray(api.requests) && api.counts && 'open' in api.counts && 'cancelled' in api.counts, 'api: /api/requests shape');
const openOne = api.requests.find(r => r.status === 'open');
const upd = await call(`/api/requests/${openOne.id}`, { method: 'POST', body: JSON.stringify({ status: 'cancelled', note: 'admin' }) });
check(upd.request?.status === 'cancelled' && upd.request?.note === 'admin', 'api: POST status update');
const docApi = await call('/api/document/drone?contact=sam');
check(Array.isArray(docApi.entries) && Array.isArray(docApi.doc.sections) && typeof docApi.doc.changelog === 'string' && docApi.doc.protected === false, 'api: /api/document has entries/sections/changelog/protected');
const dash = await call('/api/dashboard?contact=sam');
check(Array.isArray(dash.documents) && dash.documents.some(x => x.tag === 'profile' && x.protected && x.system) && dash.requestCounts, 'api: /api/dashboard documents + requestCounts');
const st = await call('/status');
check(st.requests && typeof st.requests.open === 'number', 'api: /status.requests');

// 8. carry-over delivery: age the open research item, no new inbound for sam
sqlite.prepare("UPDATE requests SET status='open', created_at = datetime('now','-3 hours'), updated_at = datetime('now','-3 hours') WHERE label='Parole hearing timeline'").run();
sqlite.prepare("UPDATE messages SET responded_at = datetime('now') WHERE responded_at IS NULL").run();
const g4 = await call('/generate');
const co = g4.results.find(r => r.status === 'carryover_queued');
check(!!co && co.items.length >= 1, `carry-over: queued (${JSON.stringify(co)})`);
const coRow = sqlite.prepare("SELECT * FROM send_queue WHERE inbound_id IS NULL ORDER BY id DESC LIMIT 1").get();
check(coRow && coRow.subject.startsWith('Follow-up: '), `carry-over: subject "${coRow?.subject}"`);
const coReq = sqlite.prepare("SELECT * FROM requests WHERE label='Parole hearing timeline'").get();
check(coReq.status === 'open' && coReq.attempts === 1, `carry-over: research still partial → open, attempts=${coReq.attempts}`);
sqlite.prepare("UPDATE requests SET updated_at = datetime('now','-3 hours') WHERE label='Parole hearing timeline'").run();
const g5 = await call('/generate');
check(!g5.results.some(r => r.status === 'carryover_queued'), 'carry-over: per-contact cooldown blocks a second follow-up next cycle');
sqlite.prepare("UPDATE system_state SET value = '2020-01-01T00:00:00Z' WHERE key = 'carryover_sent_at_sam'").run();
const g6 = await call('/generate');
check(g6.results.some(r => r.status === 'carryover_queued'), 'carry-over: retried after the cooldown');
sqlite.prepare("UPDATE system_state SET value = '2020-01-01T00:00:00Z' WHERE key = 'carryover_sent_at_sam'").run();
sqlite.prepare("UPDATE requests SET updated_at = datetime('now','-3 hours') WHERE label='Parole hearing timeline'").run();
await call('/generate');
sqlite.prepare("UPDATE system_state SET value = '2020-01-01T00:00:00Z' WHERE key = 'carryover_sent_at_sam'").run();
sqlite.prepare("UPDATE requests SET updated_at = datetime('now','-3 hours') WHERE label='Parole hearing timeline'").run();
const g7 = await call('/generate');
const finalReq = sqlite.prepare("SELECT status, attempts, note FROM requests WHERE label='Parole hearing timeline'").get();
check(finalReq.status === 'deferred' && finalReq.attempts === 3 && !g7.results.some(r => r.status === 'carryover_queued'), `carry-over: parked as deferred after ${finalReq.attempts} attempts (${finalReq.status})`);
const stamps = sqlite.prepare("SELECT COUNT(*) n FROM send_queue WHERE inbound_id IS NULL").get().n;
check(stamps === 3, `carry-over: exactly 3 standalone parts queued in total (got ${stamps})`);

// 8b. carried-over images: the 3 image requests from message #1 are still open
// (HF was unconfigured). With keys present and a new plain message, they must
// be generated now, filed under THEIR project (drone), and attached.
env.HF_API_KEY_SECRET = 'k';
globalThis.mockExtraImage = false;
let hfSubmits = [];
const baseFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('api.higgsfield.ai')) {
    if (u.includes('/status')) return new Response(JSON.stringify({ status: 'completed', images: [{ url: `https://img.test/${u.split('/')[4]}.png` }] }), { status: 200 });
    hfSubmits.push({ path: new URL(u).pathname, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ request_id: `req-${hfSubmits.length}` }), { status: 200 });
  }
  if (u.startsWith('https://img.test/')) return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/png' } });
  return baseFetch(url, init);
};
const realSetTimeout = globalThis.setTimeout;
const fastTimers = () => { globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 5), ...a); };
const slowTimers = () => { globalThis.setTimeout = realSetTimeout; };
sqlite.prepare("UPDATE requests SET status='cancelled' WHERE kind='image' AND status='open' AND inbound_id != ?").run(inboundId);
sqlite.prepare("UPDATE system_state SET value = '2020-01-01T00:00:00Z' WHERE key = 'carryover_sent_at_sam'").run();
const plainIns = sqlite.prepare(`INSERT INTO messages (external_id, contact_id, direction, sender, subject, body, timestamp) VALUES ('x3b','sam','inbound','SAMUEL MULLIKIN','Hey','Just checking in, how are things?','2026-11-07T12:30:00Z')`).run();
const plainInbound = Number(plainIns.lastInsertRowid);
sqlite.prepare("UPDATE messages SET responded_at = datetime('now') WHERE responded_at IS NULL AND id != ?").run(plainInbound);
fastTimers();
const g7b = await call('/generate');
slowTimers();
const pg = g7b.results.find(r => r.id === plainInbound);
check(pg?.status === 'generated' && pg.images === 3, `carried images: 3 older open image requests generated with the new reply (${JSON.stringify(pg)})`);
const carriedImgs = sqlite.prepare("SELECT doc_tag, label, request_id FROM images ORDER BY id").all();
check(carriedImgs.length === 3 && carriedImgs.every(i => i.doc_tag === 'drone'), `carried images: filed under their ORIGINAL project (${JSON.stringify(carriedImgs)})`);
check(sqlite.prepare("SELECT status FROM requests WHERE inbound_id = ? AND kind='image'").all(inboundId).every(r => r.status === 'done'), 'carried images: original requests marked done');
check(JSON.parse(sqlite.prepare("SELECT image_ids FROM send_queue WHERE inbound_id = ?").get(plainInbound).image_ids).length === 3, 'carried images: attached to the new reply');
sqlite.prepare("DELETE FROM images").run();
hfSubmits = [];

// 9. images with Higgsfield configured (mocked): #498-style message → 3 images attached to part 1
globalThis.mockExtraImage = true;
sqlite.prepare("UPDATE messages SET responded_at = datetime('now') WHERE responded_at IS NULL").run();
const imgBody = `MakeImage - Saga2: a figure in a rain-soaked alley (Run this prompt on Seedream 5.0)\n\nMakeImage - Wytches2: a skeletal tree with eyes in the bark (run this prompt on GPT Image 2.5 Flare)\n\nWhat do you think of these two?`;
const imgIns = sqlite.prepare(`INSERT INTO messages (external_id, contact_id, direction, sender, subject, body, timestamp) VALUES ('x4','sam','inbound','SAMUEL MULLIKIN','Two images','${imgBody.replace(/'/g, "''")}','2026-11-07T13:00:00Z')`).run();
const imgInbound = Number(imgIns.lastInsertRowid);
fastTimers();
const g8 = await call('/generate');
slowTimers();
const ig = g8.results.find(r => r.id === imgInbound);
check(ig?.status === 'generated' && ig.images === 3, `images: generated with 3 attachments (${JSON.stringify(ig)})`);
check(hfSubmits.length === 3, `images: 3 Higgsfield submits (${hfSubmits.length})`);
check(hfSubmits[0].path === '/higgsfield-ai/soul/v2/standard' && hfSubmits[1].path === '/marketing-studio/image/flare', `images: seedream→soul fallback, gpt-image→flare path (${hfSubmits.map(s => s.path).join(', ')})`);
const imgRows = sqlite.prepare("SELECT id, label, model, request_id FROM images WHERE contact_id='sam' ORDER BY id").all();
check(imgRows.length === 3 && imgRows[0].label === 'Saga2' && imgRows[0].model === 'soul' && imgRows[1].model === 'gpt-image' && imgRows.every(r => r.request_id > 0), `images: rows carry label/model/request_id (${JSON.stringify(imgRows)})`);
const qImg = sqlite.prepare("SELECT * FROM send_queue WHERE inbound_id = ?").all(imgInbound);
check(qImg.length === 1 && JSON.parse(qImg[0].image_ids).length === 3 && qImg[0].image_id === imgRows[0].id, `images: part 1 carries image_ids=${qImg[0]?.image_ids}, image_id=${qImg[0]?.image_id}`);
check(qImg[0].body.includes('Attached: 1) Saga2 — Higgsfield Soul v2 (requested "Seedream 5.0" — not available, used Soul) · 2) Wytches2 — GPT Image 2.5 Flare'), `images: footer names attachments + fallback → "${qImg[0].body.split('— — —')[1]?.trim().split('\n')[0]}"`);
check(!/Your image is attached|follow-up/i.test(qImg[0].body), 'images: legacy trailer text is gone');
const imgReqs = sqlite.prepare("SELECT kind, status FROM requests WHERE inbound_id = ? AND kind='image'").all(imgInbound);
check(imgReqs.length === 3 && imgReqs.every(r => r.status === 'done'), `images: image requests done (${imgReqs.map(r => r.status).join(',')})`);

// 10. cap: 7 image directives → 5 on part 1 this message, 2 left open for a later one
hfSubmits = [];
globalThis.mockExtraImage = false;
const many = Array.from({ length: 7 }, (_, i) => `MakeImage - View${i + 1}: drone view number ${i + 1}`).join('\n\n') + '\n\nSeven views please.';
const manyIns = sqlite.prepare(`INSERT INTO messages (external_id, contact_id, direction, sender, subject, body, timestamp) VALUES ('x5','sam','inbound','SAMUEL MULLIKIN','Seven views','${many.replace(/'/g, "''")}','2026-11-07T14:00:00Z')`).run();
const manyInbound = Number(manyIns.lastInsertRowid);
sqlite.prepare("UPDATE messages SET responded_at = datetime('now') WHERE responded_at IS NULL AND id != ?").run(manyInbound);
fastTimers();
const g9 = await call('/generate');
slowTimers();
const mg = g9.results.find(r => r.id === manyInbound);
check(mg?.status === 'generated' && mg.images === 5, `overflow: 5 generated this message (${JSON.stringify(mg)})`);
const qMany = sqlite.prepare("SELECT part_num, total_parts, subject, image_ids, body FROM send_queue WHERE inbound_id = ? ORDER BY part_num").all(manyInbound);
check(qMany.length === 1 && qMany[0].total_parts === 1 && JSON.parse(qMany[0].image_ids).length === 5, `overflow: 5 per message cap → one part with 5 ids, 2 requests deferred (${qMany.map(q => `${q.part_num}/${q.total_parts}:${q.image_ids}`).join(' ')})`);
const manyReqs = sqlite.prepare("SELECT label, status FROM requests WHERE inbound_id = ? AND kind='image' ORDER BY id").all(manyInbound);
check(manyReqs.filter(r => r.status === 'done').length === 5 && manyReqs.filter(r => r.status === 'open').length === 2, `overflow: 5 done, 2 still open for a later message (${manyReqs.map(r => r.status).join(',')})`);
check(/Still working on: .*View6, View7/.test(qMany[0].body), `overflow: footer lists the two deferred images (${qMany[0].body.split('— — —')[1]?.trim().split('\n')[0]})`);

// 11. legacy first-line MakeImage creates its ledger row on the fly and attaches
hfSubmits = [];
// the two View6/View7 leftovers would ride along — park them so this scenario is isolated
sqlite.prepare("UPDATE requests SET status='cancelled' WHERE kind='image' AND status='open'").run();
const legIns = sqlite.prepare(`INSERT INTO messages (external_id, contact_id, direction, sender, subject, body, timestamp) VALUES ('x6','sam','inbound','SAMUEL MULLIKIN','Logo','MakeImage drone a clean logo for the drone project','2026-11-07T15:00:00Z')`).run();
const legInbound = Number(legIns.lastInsertRowid);
sqlite.prepare("UPDATE messages SET responded_at = datetime('now') WHERE responded_at IS NULL AND id != ?").run(legInbound);
// simulate a pre-ledger message: SCAN never ran, so no rows exist yet
fastTimers();
const g10 = await call('/generate');
slowTimers();
const lg = g10.results.find(r => r.id === legInbound);
const legReqs = sqlite.prepare("SELECT kind, label, spec, status FROM requests WHERE inbound_id = ? ORDER BY id").all(legInbound);
check(lg?.status === 'generated' && lg.images === 1, `legacy: generated with 1 image (${JSON.stringify(lg)})`);
check(legReqs.filter(r => r.kind === 'image').length === 1 && legReqs.some(r => r.kind === 'image' && r.label === 'Drone image' && JSON.parse(r.spec).project === 'drone' && r.status === 'done'), `legacy: exactly one image row, created on the fly (${JSON.stringify(legReqs)})`);
check(sqlite.prepare("SELECT doc_tag FROM images ORDER BY id DESC LIMIT 1").get().doc_tag === 'drone', 'legacy: image filed under the project');

// 12. project state (v2 §13): facts settle on MakeUpdate, a changed value
// supersedes, and the doc patch is asked to sweep stale sections
globalThis.mockStateValue = { model: 'TFmini-S', range_m: 12 };
const st1 = sqlite.prepare(`INSERT INTO messages (external_id, contact_id, direction, sender, subject, body, timestamp) VALUES ('x7','sam','inbound','SAMUEL MULLIKIN','MakeUpdate Drone sensors','MakeUpdate drone\nConfirm the TFmini-S 12m rangefinder as the forward sensor.','2026-11-07T16:00:00Z')`).run();
sqlite.prepare("UPDATE messages SET responded_at = datetime('now') WHERE responded_at IS NULL AND id != ?").run(Number(st1.lastInsertRowid));
fastTimers(); await call('/generate'); slowTimers();
const s1 = await call('/api/state?contact=sam&tag=drone');
check(s1.state.length === 1 && s1.state[0].key === 'hardware.rangefinder' && s1.state[0].value.range_m === 12 && s1.state[0].status === 'current', `state: fact settled from the exchange (${JSON.stringify(s1.state)})`);
check(typeof s1.block === 'string' && s1.block.includes('[hardware]') && s1.block.includes('range_m=12'), 'state: prompt block renders the fact');

globalThis.mockStateValue = { model: 'Garmin LIDAR-Lite v3', range_m: 40 };
globalThis.lastPatchBody = null;
const st2 = sqlite.prepare(`INSERT INTO messages (external_id, contact_id, direction, sender, subject, body, timestamp) VALUES ('x8','sam','inbound','SAMUEL MULLIKIN','MakeUpdate Drone 40m','MakeUpdate drone\nWe switched the rangefinder out to the 40m Garmin model.','2026-11-07T17:00:00Z')`).run();
sqlite.prepare("UPDATE messages SET responded_at = datetime('now') WHERE responded_at IS NULL AND id != ?").run(Number(st2.lastInsertRowid));
fastTimers(); await call('/generate'); slowTimers();
const s2 = await call('/api/state?contact=sam&tag=drone');
check(s2.state.length === 1 && s2.state[0].value.range_m === 40 && s2.state[0].supersedes_id, `state: changed value supersedes the old row (${JSON.stringify(s2.state)})`);
const hist = await call('/api/state?contact=sam&tag=drone&key=hardware.rangefinder');
check(hist.state.length === 2 && hist.state.map(r => r.status).sort().join(',') === 'current,superseded', `state: history keeps the superseded row (${hist.state.map(r => r.status).join(',')})`);
check(typeof globalThis.lastPatchBody === 'string' && globalThis.lastPatchBody.includes('CONSISTENCY SWEEP') && globalThis.lastPatchBody.includes('range_m'), 'state: doc patch was asked to sweep the superseded value');
globalThis.mockStateValue = null;

out(`\nPipeline: ${passedCount} passed, ${failedCount} failed (${calls.length} mocked model calls)`);
if (failedCount) process.exit(1);

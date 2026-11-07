import { upgradeableTags, entriesFromMessages, pairEntries } from '../src/ops/upgrade.mjs';

let passed = 0, failed = 0; const failures = [];
function assert(c, name) { if (c) passed++; else { failed++; failures.push(name); console.log(`  ✗ ${name}`); } }

console.log('\n--- Upgrade: upgradeableTags ---');
{
  const docs = [
    { tag: 'swarm', protected: false }, { tag: 'qualia', protected: 0 },
    { tag: 'qualia-bible', protected: true }, { tag: 'profile', protected: 1 },
    { tag: 'swarm-archived-20261107', protected: 1 }, { tag: 'monday-archived-20261001', protected: 0 },
    { tag: '', protected: 0 }, null,
  ];
  const out = upgradeableTags(docs);
  assert(JSON.stringify(out) === '["swarm","qualia"]', 'live projects only — no protected, profile, archives, blanks');
  assert(upgradeableTags([]).length === 0 && upgradeableTags(null).length === 0, 'empty/null safe');
}

console.log('\n--- Upgrade: entriesFromMessages ---');
{
  const msgs = [
    { id: 10, direction: 'inbound', subject: 'MakeUpdate Swarm 10-26 A', body: 'x'.repeat(25000), timestamp: '2026-10-27T15:03:00.000Z' },
    { id: 11, direction: 'outbound', subject: 'RE: MakeUpdate Swarm10-26 A', body: 'reply', timestamp: '2026-10-27T21:03:00.000Z' },
    { id: 12, direction: 'inbound', subject: 'no date', body: 'y', timestamp: null, created_at: null },
  ];
  const e = entriesFromMessages(msgs, 'sam');
  assert(e.length === 2, 'messages without a date are skipped');
  assert(e[0].author === 'sam' && e[0].inboundId === 10 && e[0].outboundId === null && e[0].entryDate === '2026-10-27', 'inbound → contact author, inbound id, date');
  assert(e[1].author === 'ai' && e[1].outboundId === 11 && e[1].inboundId === null, 'outbound → ai author, outbound id');
  assert(e[0].content.length === 20000, 'content capped at 20000');
}

console.log('\n--- Upgrade: pairEntries ---');
{
  const rows = [
    { id: 1, author: 'sam', inbound_id: 10, content: 'a' },
    { id: 2, author: 'ai', inbound_id: 10, content: 'reply a' },
    { id: 3, author: 'sam', inbound_id: 11, content: 'b' },
    { id: 4, author: 'sam', inbound_id: 12, content: 'c' },
    { id: 5, author: 'ai', inbound_id: null, content: 'reply c?' },
  ];
  const p = pairEntries(rows);
  assert(p.length === 3, 'one pair per contact entry');
  assert(p[0].reply.id === 2, 'paired by inbound id');
  assert(p[1].reply.id === 5 && p[2].reply.id === 5, 'no same-inbound reply → next AI entry');
  assert(pairEntries([]).length === 0, 'empty safe');
}

console.log(`\nUpgrade: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }

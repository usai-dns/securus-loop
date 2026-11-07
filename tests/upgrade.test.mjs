import { upgradeableTags, entriesFromMessages } from '../src/ops/upgrade.mjs';

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

console.log(`\nUpgrade: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }

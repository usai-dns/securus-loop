import { normalizeKey, renderStateBlock, diffState, sectionsCitingStale } from '../src/db/project_state.mjs';
import { consistencySweepInstruction } from '../src/ai/state.mjs';
import { buildSystemPrompt } from '../src/ai/prompt.mjs';

let passed = 0, failed = 0; const failures = [];
function assert(c, name) { if (c) passed++; else { failed++; failures.push(name); console.log(`  ✗ ${name}`); } }

console.log('\n--- Project State: normalizeKey ---');
{
  assert(normalizeKey('Hardware / Rangefinder') === 'hardware.rangefinder', 'slash separator becomes dot, lowercase');
  assert(normalizeKey('rules.battery reposition %') === 'rules.battery_reposition', 'spaces/symbols collapse to underscore, trailing junk trimmed');
  assert(normalizeKey('  .decisions..first_test. ') === 'decisions.first_test', 'leading/trailing/double dots cleaned');
  assert(normalizeKey('') === '' && normalizeKey(null) === '', 'empty/null safe');
}

console.log('\n--- Project State: renderStateBlock ---');
{
  const rows = [
    { key: 'hardware.rangefinder', value: { model: 'Garmin LIDAR-Lite v3', range_m: 40 }, set_at: '2026-10-27 15:00:00', note: 'switched from TFmini-S' },
    { key: 'rules.battery_reposition_pct', value: 20, set_at: '2026-11-03 01:00:00' },
    { key: 'decisions.first_test.relay_drones', value: 'none', set_at: '2026-11-03 01:00:00' },
  ];
  const txt = renderStateBlock(rows, { assets: [{ id: 4, label: 'proto-exploded', created_at: '2026-10-23 17:06:03', prompt: 'exploded diagram of the drone' }] });
  assert(txt.includes('[hardware]') && txt.includes('[rules]') && txt.includes('[decisions]'), 'grouped by namespace');
  assert(txt.includes('hardware.rangefinder = model=Garmin LIDAR-Lite v3, range_m=40 (set 2026-10-27) — switched from TFmini-S'), 'object value flattened with date and note');
  assert(txt.includes('rules.battery_reposition_pct = 20 (set 2026-11-03)'), 'scalar value rendered');
  assert(txt.includes('[assets.images]') && txt.includes('#4 proto-exploded (2026-10-23): exploded diagram'), 'assets listed');
  assert(txt.indexOf('[decisions]') < txt.indexOf('[hardware]') && txt.indexOf('[hardware]') < txt.indexOf('[rules]'), 'namespaces sorted');
  assert(renderStateBlock([], { assets: [] }) === '', 'empty state renders nothing');
  const big = renderStateBlock(Array.from({ length: 400 }, (_, i) => ({ key: `k.key${i}`, value: 'x'.repeat(40), set_at: '' })), { cap: 2000 });
  assert(big.length <= 2000 + 30 && big.endsWith('…(state truncated)'), 'cap truncates with marker');
}

console.log('\n--- Project State: diffState ---');
{
  const before = [{ key: 'hardware.rangefinder', value: { model: 'TFmini-S', range_m: 12 } }, { key: 'rules.max_drones_red_room', value: 1 }];
  const after = [{ key: 'hardware.rangefinder', value: { model: 'Garmin LIDAR-Lite v3', range_m: 40 } }, { key: 'rules.battery_reposition_pct', value: 20 }];
  const d = diffState(before, after);
  const byKey = Object.fromEntries(d.map(x => [x.key, x]));
  assert(byKey['hardware.rangefinder'].from.range_m === 12 && byKey['hardware.rangefinder'].to.range_m === 40, 'changed value reported from→to');
  assert(byKey['rules.battery_reposition_pct'].from === null && byKey['rules.battery_reposition_pct'].to === 20, 'new key reported with from=null');
  assert(byKey['rules.max_drones_red_room'].to === null, 'removed key reported with to=null');
  assert(diffState(before, before).length === 0, 'identical snapshots → no diff');
}

console.log('\n--- Project State: sectionsCitingStale ---');
{
  const sections = [
    { heading: 'Hardware', body: 'Forward rangefinder: Garmin LIDAR-Lite v3 (40m).' },
    { heading: 'VolEst_PENDING', body: 'With the TFmini-S 12m limit the drone cannot read the far wall.' },
    { heading: 'Backlog', body: 'Explore relay pods.' },
  ];
  const stale = sectionsCitingStale(sections, [{ key: 'hardware.rangefinder', from: { model: 'TFmini-S', range_m: 12 }, to: { model: 'Garmin', range_m: 40 } }]);
  assert(JSON.stringify(stale) === '["VolEst_PENDING"]', 'finds the section citing the superseded model, skips tiny numeric needles');
  assert(sectionsCitingStale(sections, [{ key: 'x', from: 12, to: 40 }]).length === 0, 'two-digit numbers are not needles');
  const tokenHit = sectionsCitingStale([{ heading: 'Sim', body: 'modeled against TFmini-S specs — 12m max range' }], [{ key: 'hardware.rangefinder.model', from: 'Benewake TFmini-S', to: 'Garmin LIDAR-Lite v3' }]);
  assert(JSON.stringify(tokenHit) === '["Sim"]', 'distinctive token (TFmini-S) matches when the full phrase does not');
  const noWordHit = sectionsCitingStale([{ heading: 'A', body: 'the camera module is light' }], [{ key: 'k', from: 'camera module', to: 'thermal module' }]);
  assert(noWordHit.length === 1, 'short plain phrase still matches as a whole');
  const noGeneric = sectionsCitingStale([{ heading: 'B', body: 'runs at 100Hz on the bench' }], [{ key: 'k', from: 'rate 100Hz', to: 'rate 50Hz' }]);
  assert(noGeneric.length === 0, 'unit-number tokens (100Hz) are not needles');
  assert(sectionsCitingStale(sections, []).length === 0, 'no superseded → nothing');
}

console.log('\n--- Project State: consistencySweepInstruction ---');
{
  const s = consistencySweepInstruction([{ key: 'hardware.rangefinder', from: 'TFmini-S', to: 'Garmin LIDAR-Lite v3' }], ['VolEst_PENDING']);
  assert(s.startsWith('CONSISTENCY SWEEP') && s.includes('"TFmini-S" → "Garmin LIDAR-Lite v3"') && s.includes('VolEst_PENDING'), 'instruction names facts and stale sections');
  assert(consistencySweepInstruction([], []) === '', 'no changes → empty instruction');
  assert(consistencySweepInstruction([{ key: 'a', from: 1, to: 2 }], []).includes('Scan every section'), 'no known stale sections → scan-all wording');
}

console.log('\n--- Project State: prompt slot ---');
{
  const p = buildSystemPrompt([], [], 40, null, 'swarm', { contactNick: 'sam', contactName: 'SAMUEL MULLIKIN', currentDocument: '## Hardware\n\nTFmini-S 12m', projectState: '[hardware]\n- hardware.rangefinder = model=Garmin LIDAR-Lite v3, range_m=40 (set 2026-10-27)' });
  assert(p.includes('<project_state>') && p.includes('range_m=40'), 'state block rendered');
  assert(p.indexOf('<project_state>') < p.indexOf('<current_document>'), 'state precedes the document');
  assert(p.includes('"Swarm" project') && p.includes('override anything older'), 'labelled and declared authoritative');
  const q = buildSystemPrompt([], [], 40, null, 'swarm', { contactNick: 'sam' });
  assert(!q.includes('<project_state>'), 'no state → no block');
}

console.log(`\nState: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }

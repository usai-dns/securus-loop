import { normalizeRequests, imageDirectivesToRequests, requestLabel, REQUEST_KINDS } from '../src/db/requests.mjs';

let passed = 0, failed = 0; const failures = [];
function assert(c, name) { if (c) passed++; else { failed++; failures.push(name); console.log(`  ✗ ${name}`); } }

console.log('\n--- Request Ledger: normalizeRequests ---');
{
  const out = normalizeRequests([
    { kind: 'answer', label: 'Explain VolEst', priority: 7 },
    { kind: 'image', spec: { prompt: 'exploded diagram of the drone', group: 'proto' }, priority: 12 },
    { kind: 'bogus', label: 'nope' },
    { kind: 'research', label: '   spaced    label  ', priority: 'x' },
    null,
  ]);
  assert(out.length === 3, 'drops unknown kinds and nulls');
  assert(out[0].label === 'Explain VolEst' && out[0].priority === 7, 'keeps explicit label/priority');
  assert(out[1].label === 'exploded diagram of the drone' && out[1].priority === 9, 'label from spec.prompt; priority clamped to 9');
  assert(out[2].label === 'spaced label' && out[2].priority === 5, 'whitespace collapsed; bad priority defaults to 5');
  assert(normalizeRequests(null).length === 0 && normalizeRequests('x').length === 0, 'non-array input yields []');
  assert(normalizeRequests([{ kind: 'answer', label: 'x'.repeat(100) }])[0].label.length === 60, 'label capped at 60');
}

console.log('\n--- Request Ledger: imageDirectivesToRequests ---');
{
  const reqs = imageDirectivesToRequests([
    { label: 'Saga2', prompt: 'alley figure', modelHint: 'seedream' },
    { label: null, prompt: 'skeleton cupcake', modelHint: null },
    { label: 'empty', prompt: '' },
  ], { group: 'S&W' });
  assert(reqs.length === 2, 'directives without a prompt are dropped');
  assert(reqs[0].kind === 'image' && reqs[0].label === 'Saga2' && reqs[0].spec.model === 'seedream' && reqs[0].spec.group === 'S&W', 'labelled directive maps to spec');
  assert(reqs[1].label === 'Image 2' && reqs[1].spec.model === null, 'unlabelled directive gets a positional label');
}

console.log('\n--- Request Ledger: requestLabel ---');
{
  assert(requestLabel({ label: 'Hello' }) === 'Hello', 'explicit label wins');
  assert(requestLabel({ kind: 'image', spec: { prompt: 'a'.repeat(50) } }).endsWith('…'), 'image without label uses truncated prompt');
  assert(requestLabel({ kind: 'answer', id: 7, spec: {} }) === 'answer #7', 'fallback label');
  assert(REQUEST_KINDS.includes('followup'), 'followup is a known kind');
}

console.log(`\nRequests: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }

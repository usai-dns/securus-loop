import { normalizeRequests, imageDirectivesToRequests, requestLabel, mergeExtractedImages, REQUEST_KINDS } from '../src/db/requests.mjs';

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

console.log('\n--- Request Ledger: umbrella directive split (replaces) ---');
{
  const parsed = imageDirectivesToRequests([{ label: null, prompt: 'I want to get four separate pictures of the prototype drone (1) exploded (2) top (3) side (4) front', modelHint: null }]);
  assert(parsed[0].label === 'Image 1', 'umbrella directive parsed as one row');
  const extracted = normalizeRequests([
    { kind: 'image', label: 'Exploded diagram', spec: { prompt: 'exploded diagram of all parts', group: 'drone views' }, priority: 6, replaces: 'Image 1' },
    { kind: 'image', label: 'Top view', spec: { prompt: 'assembled drone from the top', group: 'drone views' }, priority: 6, replaces: 'image 1' },
    { kind: 'answer', label: 'Reply', spec: {}, priority: 5 },
  ]);
  assert(extracted[0].replaces === 'Image 1', 'normalizeRequests keeps replaces');
  const merged = mergeExtractedImages(parsed, extracted);
  assert(merged.length === 3 && !merged.some(r => r.label === 'Image 1'), 'umbrella row dropped, split rows kept (case-insensitive)');
  assert(merged.every(r => !('replaces' in r)), 'replaces stripped from stored rows');
  const untouched = mergeExtractedImages(parsed, normalizeRequests([{ kind: 'answer', label: 'Reply' }]));
  assert(untouched.length === 2 && untouched[0].label === 'Image 1', 'no replaces → parsed rows kept');
}

console.log(`\nRequests: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }

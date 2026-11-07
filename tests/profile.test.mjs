import { normalizeProfile, buildProfileInput, isUserDocTag, PROFILE_SECTIONS, PROFILE_MAX_CHARS, PROFILE_TAG } from '../src/ai/profile.mjs';

let passed = 0, failed = 0; const failures = [];
function assert(c, name) { if (c) passed++; else { failed++; failures.push(name); console.log(`  ✗ ${name}`); } }

console.log('\n--- Profile: isUserDocTag ---');
{
  assert(isUserDocTag('swarm'), 'plain tag is a user tag');
  assert(!isUserDocTag(PROFILE_TAG), 'profile is not a user tag');
  assert(!isUserDocTag('swarm-archived-20261107'), 'archived copy is not a user tag');
  assert(!isUserDocTag('swarm-archived-20261107-2'), 'numbered archive is not a user tag');
  assert(!isUserDocTag(null) && !isUserDocTag(''), 'empty is not a user tag');
  assert(isUserDocTag('qualia-bible'), 'hyphenated reference doc is a user tag');
}

console.log('\n--- Profile: normalizeProfile ---');
{
  const raw = `Some preamble the model should not have written.
## Preferences & voice
- likes long letters (10-21)

## Projects index
- swarm — drone army sci-fi, active

## Commitments and cadence
- Documentary check-in every Monday

## Open threads
- Saga3 image still owed

## Glossary
- VolEst: volume estimator

## Extra section
- should be dropped`;
  const out = normalizeProfile(raw);
  const headings = out.split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(3));
  assert(JSON.stringify(headings) === JSON.stringify(PROFILE_SECTIONS), 'exactly the five canonical headings, in order');
  assert(out.startsWith('## Preferences & voice'), 'preamble before the first heading is dropped');
  assert(out.includes('Documentary check-in every Monday'), '"and" heading variant maps to the canonical "&" heading');
  assert(!out.includes('should be dropped'), 'unknown sections are dropped');
  assert(out.includes('- VolEst: volume estimator'), 'glossary body kept');
}
{
  const out = normalizeProfile('## Glossary\n- only this');
  const headings = out.split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(3));
  assert(headings.length === 5, 'missing sections are added');
  assert(out.includes('## Preferences & voice\n\n(nothing recorded yet)'), 'missing section gets a placeholder body');
  assert(out.endsWith('## Glossary\n\n- only this'), 'present section keeps its body and position');
}
{
  const out = normalizeProfile('```markdown\n## Preferences & voice\n- fenced\n```');
  assert(out.includes('- fenced') && !out.includes('```'), 'code fences around the output are stripped');
}
{
  const big = PROFILE_SECTIONS.map(h => `## ${h}\n\n${'x'.repeat(3000)}`).join('\n\n');
  const out = normalizeProfile(big);
  assert(out.length <= PROFILE_MAX_CHARS, `capped at ${PROFILE_MAX_CHARS} chars (got ${out.length})`);
  const headings = out.split('\n').filter(l => l.startsWith('## ')).length;
  assert(headings === 5, 'cap never removes a heading');
  assert(out.includes('## Preferences & voice\n\n' + 'x'.repeat(3000)), 'cap trims the LAST sections first, the first stays whole');
}
{
  assert(normalizeProfile('').split('\n').filter(l => l.startsWith('## ')).length === 5, 'empty input still yields the skeleton');
}

console.log('\n--- Profile: buildProfileInput ---');
{
  const input = buildProfileInput({
    current: null,
    docs: [
      { tag: 'swarm', title: 'Swarm — working document', version: 12, length: 130000 },
      { tag: 'profile', title: 'Contact profile', version: 3, length: 4000 },
      { tag: 'swarm-archived-20261107', title: 'Swarm (archived)', version: 11, length: 129000 },
    ],
    messages: [
      { direction: 'outbound', subject: 'RE: Swarm', body: 'reply '.repeat(200), timestamp: '2026-11-06T10:00:00Z' },
      { direction: 'inbound', subject: 'Swarm', body: 'hello there', timestamp: '2026-11-05T10:00:00Z' },
    ],
    openRequests: [{ id: 4, kind: 'followup', label: 'Parole timeline', status: 'open' }],
    contactId: 'sam',
  });
  assert(input.includes('- swarm — "Swarm — working document" (v12, 130,000 chars)'), 'documents listed with version and size');
  assert(!input.includes('- profile —') && !input.includes('swarm-archived'), 'profile and archived docs are excluded from the document list');
  assert(input.indexOf('[2026-11-05] sam:') < input.indexOf('[2026-11-06] dennis:'), 'messages are oldest first and attributed');
  const outboundLine = input.split('\n').find(l => l.startsWith('[2026-11-06] dennis:'));
  assert(outboundLine.length < 460, 'message bodies capped at ~400 chars');
  assert(input.includes('- Parole timeline (followup, open)'), 'open requests listed with kind and status');
  assert(input.includes('(none yet)'), 'empty current profile is stated');
}

console.log(`\nProfile: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }

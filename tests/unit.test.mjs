import { detectSeriesIndicator, stripSeriesIndicator } from '../src/db/series.mjs';
import { parseDocCommand, docAcknowledgment } from '../src/docs/commands.mjs';
import { splitForSend, shouldEscalate } from '../src/ai/responder.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, name) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL: ${name}`);
  }
}

function eq(actual, expected, name) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (!match) {
    assert(false, `${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    assert(true, name);
  }
}

// ═══════════════════════════════════════════
// Series Detection
// ═══════════════════════════════════════════
console.log('\n--- Series Detection ---');

{
  const r = detectSeriesIndicator('message 1/6\n\nHere is part one of my story update...');
  assert(r !== null, 'detects "message 1/6" in body');
  eq(r.partNum, 1, 'series partNum = 1');
  eq(r.totalParts, 6, 'series totalParts = 6');
}

{
  const r = detectSeriesIndicator('Hey Dennis, message 3/5 this is the middle part');
  assert(r !== null, 'detects "message 3/5" mid-body');
  eq(r.partNum, 3, 'mid-body partNum = 3');
  eq(r.totalParts, 5, 'mid-body totalParts = 5');
}

{
  const r = detectSeriesIndicator('MESSAGE 2/4\nSome content here');
  assert(r !== null, 'case insensitive MESSAGE 2/4');
  eq(r.partNum, 2, 'uppercase partNum = 2');
}

{
  const r = detectSeriesIndicator('I ate 1/2 the pizza and gave 3/4 to my cellmate');
  assert(r === null, 'bare fractions do NOT trigger series');
}

{
  const r = detectSeriesIndicator('The score was 3/5 on my test');
  assert(r === null, 'bare N/M in normal text does not trigger');
}

{
  const r = detectSeriesIndicator('');
  assert(r === null, 'empty body returns null');
}

{
  const r = detectSeriesIndicator(null);
  assert(r === null, 'null body returns null');
}

{
  const r = detectSeriesIndicator('message 0/5\nsome text');
  assert(r === null, 'partNum 0 rejected');
}

{
  const r = detectSeriesIndicator('message 6/5\nsome text');
  assert(r === null, 'partNum > totalParts rejected');
}

{
  const r = detectSeriesIndicator('message 1/1\nsome text');
  assert(r === null, 'totalParts 1 rejected (not a series)');
}

{
  const r = detectSeriesIndicator('message 1/31\nsome text');
  assert(r === null, 'totalParts > 30 rejected');
}

{
  const r1 = detectSeriesIndicator('message 1/3\nfirst part');
  const r2 = detectSeriesIndicator('message 2/3\nfirst part');
  assert(r1 !== null && r2 !== null, 'both parts detected');
  eq(r1.seriesKey, r2.seriesKey, 'same body produces same seriesKey');
}

{
  const r1 = detectSeriesIndicator('message 1/3\nstory about dragons');
  const r2 = detectSeriesIndicator('message 1/3\nrecipe for tacos');
  assert(r1.seriesKey !== r2.seriesKey, 'different body produces different seriesKey');
}

// ═══════════════════════════════════════════
// Strip Series Indicator
// ═══════════════════════════════════════════
console.log('\n--- Strip Series Indicator ---');

{
  const r = stripSeriesIndicator('message 1/6\n\nActual content here');
  assert(!r.includes('message 1/6'), 'strips "message 1/6"');
  assert(r.includes('Actual content here'), 'preserves content after indicator');
}

{
  const r = stripSeriesIndicator('Hey Dennis, message 2/3 this is the rest');
  assert(!r.includes('message 2/3'), 'strips mid-body indicator');
  assert(r.includes('Hey Dennis'), 'preserves text before indicator');
  assert(r.includes('this is the rest'), 'preserves text after indicator');
}

{
  const r = stripSeriesIndicator('No series indicator here, just normal text');
  eq(r, 'No series indicator here, just normal text', 'no indicator leaves body unchanged');
}

{
  eq(stripSeriesIndicator(null), null, 'null body returns null');
  eq(stripSeriesIndicator(''), '', 'empty body returns empty');
}

// ═══════════════════════════════════════════
// Doc Command Parsing
// ═══════════════════════════════════════════
console.log('\n--- Doc Command Parsing ---');

{
  const r = parseDocCommand('makenew starkiller\nHere are my notes on the character...');
  eq(r.command, 'makenew', 'makenew command detected');
  eq(r.docTag, 'starkiller', 'docTag = starkiller');
  assert(r.cleanBody.includes('Here are my notes'), 'cleanBody has content without first line');
  assert(!r.cleanBody.includes('makenew'), 'cleanBody does not contain command');
}

{
  const r = parseDocCommand('makeupdate scribe\nNew chapter notes...');
  eq(r.command, 'makeupdate', 'makeupdate command detected');
  eq(r.docTag, 'scribe', 'docTag = scribe');
}

{
  const r = parseDocCommand('makefull scribe\nPlease write the full document');
  eq(r.command, 'makefull', 'makefull command detected');
  eq(r.docTag, 'scribe', 'makefull docTag = scribe');
}

{
  const r = parseDocCommand('makeupdate warrior 2/5\nPart two content');
  eq(r.command, 'makeupdate', 'makeupdate with batch detected');
  eq(r.batch.part, 2, 'batch part = 2');
  eq(r.batch.total, 5, 'batch total = 5');
}

{
  const r = parseDocCommand('Hey Dennis, just writing to say hello');
  eq(r.command, null, 'no command in normal message');
  eq(r.docTag, null, 'no docTag in normal message');
  assert(r.cleanBody.includes('Hey Dennis'), 'cleanBody is full body for non-command');
}

{
  const r = parseDocCommand('');
  eq(r.command, null, 'empty body has no command');
}

{
  const r = parseDocCommand(null);
  eq(r.command, null, 'null body has no command');
}

// ═══════════════════════════════════════════
// Doc Acknowledgment
// ═══════════════════════════════════════════
console.log('\n--- Doc Acknowledgment ---');

{
  const r = docAcknowledgment('makenew', 'starkiller');
  assert(r.includes('Starkiller'), 'makenew ack capitalizes tag');
  assert(r.includes('started a new'), 'makenew ack has correct wording');
}

{
  const r = docAcknowledgment('makefull', 'scribe');
  assert(r.includes('full'), 'makefull ack mentions full document');
  assert(r.includes('split'), 'makefull ack mentions splitting');
}

{
  const r = docAcknowledgment('makeupdate', 'warrior', { total: 3 });
  assert(r.includes('3 parts'), 'batch ack mentions part count');
}

{
  const r = docAcknowledgment(null, null);
  eq(r, '', 'null command returns empty string');
}

// ═══════════════════════════════════════════
// Split For Send
// ═══════════════════════════════════════════
console.log('\n--- Split For Send ---');

{
  const parts = splitForSend('RE: Test', 'Short reply');
  eq(parts.length, 1, 'short message = 1 part');
  eq(parts[0].subject, 'RE: Test', 'single part keeps original subject');
  eq(parts[0].body, 'Short reply', 'single part body unchanged');
}

{
  const longBody = 'A'.repeat(19950);
  const parts = splitForSend('RE: Test', longBody);
  eq(parts.length, 1, '19950 chars + short subject fits in 1 part');
}

{
  const longBody = 'word '.repeat(4500);
  const parts = splitForSend('RE: Test', longBody);
  assert(parts.length >= 2, 'very long body splits into 2+ parts');
  assert(parts[0].subject === 'RE: Test', 'first part keeps original subject');
  assert(parts[1].subject.includes('pt 2'), 'second part subject has (pt 2)');
  for (const p of parts) {
    assert(p.subject.length + p.body.length <= 20000, `part fits in 20k limit: ${p.subject.length + p.body.length}`);
  }
}

{
  const body = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
  const parts = splitForSend('RE: Test', body);
  eq(parts.length, 1, 'short multi-paragraph fits in 1 part');
}

// ═══════════════════════════════════════════
// Escalation Detection
// ═══════════════════════════════════════════
console.log('\n--- Escalation Detection ---');

{
  assert(shouldEscalate('I need help now please'), 'detects "i need help now"');
  assert(shouldEscalate('CALL 911 PLEASE'), 'detects "call 911" (case insensitive)');
  assert(shouldEscalate('they taken to the hospital yesterday'), 'detects "taken to the hospital"');
  assert(shouldEscalate('this is an emergency Dennis'), 'detects "this is an emergency"');
  assert(shouldEscalate('This is urgent man'), 'detects "this is urgent"');
}

{
  assert(!shouldEscalate('Hey Dennis how are you doing'), 'normal message is NOT escalation');
  assert(!shouldEscalate('I need help with my story'), 'partial phrase "help" alone not escalation');
  assert(!shouldEscalate(''), 'empty body is not escalation');
  assert(!shouldEscalate(null), 'null body is not escalation');
}

// ═══════════════════════════════════════════
// Results
// ═══════════════════════════════════════════
console.log('\n═══════════════════════════════════');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All tests passed.');

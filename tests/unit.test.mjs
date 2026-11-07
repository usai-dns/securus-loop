import { detectSeriesIndicator, stripSeriesIndicator, messageSignature, isNearDuplicate } from '../src/db/series.mjs';
import { parseDocCommand, docAcknowledgment } from '../src/docs/commands.mjs';
import { splitForSend, shouldEscalate } from '../src/ai/responder.mjs';
import { docTitle, changeNoteFor } from '../src/db/documents.mjs';
import { parseReferenceDirectives, parseImageCommand, parseInlineImage, mentionedTags } from '../src/docs/commands.mjs';
import { estimateCost } from '../src/db/usage.mjs';
import { contactIdForSender } from '../src/db/contacts.mjs';
import { safeSubject, getPartImageIds, chunkImageIds, MAX_ATTACHMENTS_PER_MESSAGE } from '../src/db/send_queue.mjs';
import { parseImageDirectives, normalizeModelHint } from '../src/docs/commands.mjs';
import { IMAGE_MODELS, resolveImageModel, DEFAULT_IMAGE_MODEL } from '../src/ai/images.mjs';
import { imageFilename } from '../src/db/images.mjs';
import { normalizeAttachments } from '../src/securus/compose.mjs';

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
// Content Duplicate Detection
// ═══════════════════════════════════════════
console.log('\n--- Content Duplicate Detection ---');

{
  const a = 'MakeUpdate RAFDraft #2\n\nDont doubt the powers of a Kashic Master. Who are we, mere mortals, to question the flow of the universe.';
  const b = 'MakeUpdate RAFDraft #2\n\nDont doubt the powers of a Kashic Master. Who are we, mere mortals, to question the flow of the universe!'; // 1-char diff
  assert(isNearDuplicate(a, b), 'detects near-duplicate with trailing punctuation diff');
}

{
  const a = 'Hey Dennis, here are my thoughts on the parole manual project and how we should structure it.';
  const b = 'Hey Dennis, here are my thoughts on the parole manual project and how we should structure it.';
  assert(isNearDuplicate(a, b), 'detects exact duplicate');
}

{
  const a = 'Can you help me write a letter to the parole board about my rehabilitation progress.';
  const b = 'Can you help me research effective parole policies in other states for comparison.';
  assert(!isNearDuplicate(a, b), 'different messages are not duplicates');
}

{
  assert(!isNearDuplicate('', 'something'), 'empty body is not a duplicate');
  assert(!isNearDuplicate(null, 'something'), 'null body is not a duplicate');
  assert(!isNearDuplicate('something', null), 'null other is not a duplicate');
}

{
  const a = '  Message   with    irregular\n\n whitespace   here  ';
  const b = 'Message with irregular whitespace here';
  assert(isNearDuplicate(a, b), 'whitespace-normalized bodies match');
}

{
  const sig = messageSignature('Hello world this is a test message');
  assert(typeof sig === 'string' && sig.length > 0, 'signature is a non-empty string');
  eq(messageSignature(''), '', 'empty body signature is empty');
}

// ═══════════════════════════════════════════
// Governing Documents
// ═══════════════════════════════════════════
console.log('\n--- Governing Documents ---');

{
  eq(docTitle('parole'), 'Parole — working document', 'docTitle capitalizes tag');
  eq(docTitle('rafdraft'), 'Rafdraft — working document', 'docTitle handles lowercase tag');
}

{
  assert(changeNoteFor('makenew', 0, 5000).includes('created'), 'makenew note says created');
  assert(changeNoteFor('makenew', 0, 5000).includes('5,000'), 'makenew note has char count');
  const upd = changeNoteFor('makeupdate', 5000, 6200);
  assert(upd.includes('+1,200'), 'makeupdate note shows positive delta');
  assert(upd.includes('6,200'), 'makeupdate note shows new total');
  const shrink = changeNoteFor('makeupdate', 6000, 5800);
  assert(shrink.includes('-200'), 'makeupdate note shows negative delta');
}

// ═══════════════════════════════════════════
// Contact Attribution (multi-tenant boundary)
// ═══════════════════════════════════════════
console.log('\n--- Contact Attribution ---');

{
  const contacts = [
    { id: 'sam', match_names: 'SAMUEL,MULLIKIN' },
    { id: 'ricardo', match_names: 'RICARDO,CHALCHISEVILLA' },
  ];
  eq(contactIdForSender('SAMUEL MULLIKIN', contacts), 'sam', 'attributes Sam by full name');
  eq(contactIdForSender('MULLIKIN, SAMUEL', contacts), 'sam', 'attributes Sam last-first');
  eq(contactIdForSender('RICARDO CHALCHISEVILLA', contacts), 'ricardo', 'attributes Ricardo');
  eq(contactIdForSender('ricardo chalchisevilla', contacts), 'ricardo', 'case-insensitive attribution');
  eq(contactIdForSender('JOHN DOE', contacts), null, 'unknown sender attributes to nobody');
  eq(contactIdForSender('', contacts), null, 'empty sender attributes to nobody');
  eq(contactIdForSender(null, contacts), null, 'null sender attributes to nobody');
  eq(contactIdForSender('SAMUEL MULLIKIN', [{ id: 'x', match_names: '' }]), null, 'empty match_names never matches');
}

// ═══════════════════════════════════════════
// MakeReference Parsing (fuzzy by design)
// ═══════════════════════════════════════════
console.log('\n--- MakeReference Parsing ---');

{
  let r = parseReferenceDirectives('MakeReference Swarm\nActual message text');
  eq(JSON.stringify(r.refs), '["swarm"]', 'MakeReference Swarm parses');
  eq(r.cleanBody, 'Actual message text', 'directive line stripped');

  r = parseReferenceDirectives('make reference swarm, monday\nbody');
  eq(JSON.stringify(r.refs), '["swarm","monday"]', 'spaced + comma list parses');

  r = parseReferenceDirectives('Reference: Monday\nbody');
  eq(JSON.stringify(r.refs), '["monday"]', 'Reference: form parses');

  r = parseReferenceDirectives('makeref scribe\nbody');
  eq(JSON.stringify(r.refs), '["scribe"]', 'makeref shorthand parses');

  r = parseReferenceDirectives('MakeUpdate Monday\nmake reference swarm\nSession notes here');
  eq(JSON.stringify(r.refs), '["swarm"]', 'ref on line 2 under a doc command');
  assert(r.cleanBody.includes('Session notes here') && !/make reference/i.test(r.cleanBody), 'body keeps content, drops directive');

  r = parseReferenceDirectives('I want to reference the swarm project in general prose here');
  eq(JSON.stringify(r.refs), '[]', 'prose containing the word reference mid-line does NOT trigger');

  r = parseReferenceDirectives('make reference swarm and monday\nbody');
  eq(JSON.stringify(r.refs), '["swarm","monday"]', '"and" separator handled');

  r = parseReferenceDirectives(null);
  eq(JSON.stringify(r.refs), '[]', 'null body safe');
}

// ═══════════════════════════════════════════
// Image Command Grammar v2
// ═══════════════════════════════════════════
console.log('\n--- Image Command Grammar ---');

{
  let r = parseImageCommand('MakeImage swarm\na drone over mountains');
  assert(r.isImage && r.project === 'swarm' && r.intent === 'a drone over mountains', 'project + intent on next line');

  r = parseImageCommand('MakeImage swarm a drone over mountains');
  assert(r.isImage && r.project === 'swarm' && r.intent === 'a drone over mountains', 'project + same-line intent');

  r = parseImageCommand('MakeImage a sunset over the ocean');
  assert(r.isImage && r.project === null && /sunset/.test(r.intent), 'standalone (article blocks project token)');

  r = parseImageCommand('MakeImage swarm again\nmake it darker');
  assert(r.isImage && r.project === 'swarm' && r.iterate && /darker/.test(r.intent), 'iteration form');

  r = parseImageCommand('Just a normal message about images');
  assert(!r.isImage, 'prose does not trigger');

  let i = parseInlineImage('MakeUpdate swarm\nmakeimage "a logo for the swarm army"\nAlso update the doc with this.');
  eq(i.imagePrompt, 'a logo for the swarm army', 'inline quoted prompt extracted');
  assert(/Also update/.test(i.cleanBody) && !/makeimage/i.test(i.cleanBody), 'inline directive stripped');

  i = parseInlineImage('MakeUpdate swarm\nmake image (a drone squadron at dawn)');
  eq(i.imagePrompt, 'a drone squadron at dawn', 'parenthesized prompt extracted');

  i = parseInlineImage('MakeUpdate monday\nsession notes only');
  eq(i.imagePrompt, null, 'no inline directive → null');

  i = parseInlineImage('makeimage "never on line zero"\nbody');
  eq(i.imagePrompt, null, 'line 0 reserved for the doc/first-line command');
}

// ═══════════════════════════════════════════
// Usage Cost Estimation
// ═══════════════════════════════════════════
console.log('\n--- Usage Cost Estimation ---');

{
  // sonnet-4-6: $3/1M input, $15/1M output
  const c = estimateCost('claude-sonnet-4-6', 1_000_000, 0, 0);
  assert(Math.abs(c - 3.0) < 1e-9, 'input-only cost = $3 per 1M input tokens');
  const c2 = estimateCost('claude-sonnet-4-6', 0, 1_000_000, 0);
  assert(Math.abs(c2 - 15.0) < 1e-9, 'output-only cost = $15 per 1M output tokens');
  const c3 = estimateCost('claude-sonnet-4-6', 10000, 2000, 0);
  assert(Math.abs(c3 - (0.00003 * 1000 + 0.000015 * 2000 / 1)) > -1, 'mixed cost computes');
  assert(c3 > 0, 'mixed input+output cost is positive');
}

{
  // cache reads bill at 0.1x input rate
  const full = estimateCost('claude-sonnet-4-6', 1_000_000, 0, 0);
  const cached = estimateCost('claude-sonnet-4-6', 0, 0, 1_000_000);
  assert(Math.abs(cached - full * 0.1) < 1e-9, 'cache-read tokens bill at 0.1x input rate');
}

{
  // unknown model falls back to sonnet pricing, never throws
  const c = estimateCost('some-unknown-model', 1_000_000, 0, 0);
  assert(c === 3.0, 'unknown model falls back to sonnet input pricing');
  eq(estimateCost('claude-sonnet-4-6', 0, 0, 0), 0, 'zero tokens = zero cost');
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
// Mentioned Tags (plain-language reference prefilter)
// ═══════════════════════════════════════════
console.log('\n--- Mentioned Tags ---');

{
  const tags = ['monday', 'swarm', 'parole', 'qualia'];
  assert(JSON.stringify(mentionedTags('Design a logo based on my values in Monday', tags)) === '["monday"]', 'finds one tag case-insensitively');
  assert(mentionedTags('use swarm and parole for this', tags).length === 2, 'finds multiple tags');
  assert(mentionedTags('mondays are rough', tags).length === 0, 'no match inside a longer word');
  assert(mentionedTags('nothing relevant here', tags).length === 0, 'no tags mentioned');
  assert(mentionedTags('', tags).length === 0, 'empty body');
  assert(mentionedTags('monday', null).length === 0, 'null tag list');
  assert(JSON.stringify(mentionedTags('see you monday!', tags)) === '["monday"]', 'punctuation boundary still matches (resolver filters intent)');
}

// ═══════════════════════════════════════════
// Safe Subject (Securus compose rejects long subjects)
// ═══════════════════════════════════════════
console.log('\n--- Safe Subject ---');

{
  assert(safeSubject('Hey Joe — good to hear from you, and here is how this works').length <= 40, 'caps at 40 chars');
  assert(!safeSubject('a — b – c').includes('—') && !safeSubject('a — b – c').includes('–'), 'em/en dashes become hyphens');
  assert(safeSubject('a — b') === 'a - b', 'dash replacement exact');
  assert(safeSubject('  spaced   out  ') === 'spaced out', 'whitespace collapsed and trimmed');
  assert(safeSubject('') === 'Message', 'empty falls back');
  assert(safeSubject(null) === 'Message', 'null falls back');
  assert(safeSubject('RE: Short') === 'RE: Short', 'short subjects unchanged');
}

// ═══════════════════════════════════════════
// Images v2 — directive grammar (Sam's real messages, Oct–Nov 2026)
// ═══════════════════════════════════════════
console.log('\n--- Image Directives v2 ---');

{
  // #498: two labelled directives, blank-line separated, both with a model hint
  const r = parseImageDirectives(
    'MakeImage - Saga2: Graphic novel illustration, Fiona Staples Saga aesthetic - a figure pressed against a wall, indie comic warmth even in tense moment.   (Run this prompt on Seedream 5.0)\n\n' +
    'MakeImage - Wytches2: Graphic novel illustration, Jock and Matt Hollingsworth Wytches aesthetic, things in the trees you cannot see.  (Run this prompt on Seedream 5.0)');
  eq(r.images.length, 2, '#498 → two directives');
  eq(r.images.map(i => i.label), ['Saga2', 'Wytches2'], '#498 labels');
  eq(r.images.map(i => i.modelHint), ['seedream', 'seedream'], '#498 model hint seedream');
  assert(r.images[0].prompt.startsWith('Graphic novel illustration, Fiona Staples Saga aesthetic - a figure'), '#498 prompt keeps the inner " - " and starts after the label');
  assert(!/run this prompt/i.test(r.images[0].prompt) && !/\.\s*$/.test(r.images[0].prompt + 'x'), '#498 model hint stripped from prompt');
  assert(/cannot see$/.test(r.images[1].prompt), '#498 second prompt ends cleanly');
  eq(r.cleanBody, '', '#498 cleanBody empty when the message is only directives');
}

{
  // skeleton cupcake: no label, no model
  const r = parseImageDirectives('MakeImage - Portrait illustration of a skeleton holding a cupcake, pastel palette');
  eq(r.images.length, 1, 'unlabelled directive → one image');
  eq(r.images[0].label, null, 'unlabelled directive → label null');
  eq(r.images[0].modelHint, null, 'no model hint → null');
  assert(r.images[0].prompt.startsWith('Portrait illustration'), 'unlabelled prompt intact');
}

{
  // #446: one directive asking for four views — the parser must NOT split it
  const r = parseImageDirectives('MakeImage - I want to get four separate pictures of the prototype drone. (1) exploded view (2) top view (3) side view (4) front view');
  eq(r.images.length, 1, '#446 numbered multi-view ask stays ONE directive');
  assert(/\(4\) front view$/.test(r.images[0].prompt), '#446 prompt keeps all four items');
}

{
  // list items after blank lines continue the directive; prose does not
  const r = parseImageDirectives('MakeImage - Drone views:\n\n(1) exploded view of the drone\n\n(2) top-down view\n\nThanks Dennis, more later.');
  eq(r.images.length, 1, 'blank-line-separated list items stay in one directive');
  eq(r.images[0].label, 'Drone views', 'label before a trailing colon');
  assert(/\(1\) exploded view of the drone \(2\) top-down view$/.test(r.images[0].prompt), 'list items joined into the prompt');
  eq(r.cleanBody, 'Thanks Dennis, more later.', 'trailing prose stays in cleanBody');
}

{
  // after a doc command, mixed spellings, trailing model variants
  const r = parseImageDirectives(
    'MakeUpdate swarm\nSome notes about the swarm.\n\n' +
    'MakeImage: a drone squadron at dawn (use warm colors)\n\n' +
    'Make Image - Logo: minimalist swarm logo (run on GPT Image 2.5 Flare)\n\n' +
    'makeimage a sketch of the hangar (Run this prompt on Nano Banana Pro)\n\n' +
    'MakeImg - Soul test: moody portrait, Soul v2\n\n' +
    'More notes here.');
  eq(r.images.length, 4, 'four directives under a MakeUpdate line, mixed spellings');
  eq(r.images[0].prompt, 'a drone squadron at dawn (use warm colors)', 'parenthetical that is not a model stays in the prompt');
  eq(r.images[0].modelHint, null, 'non-model parenthetical → no hint');
  eq(r.images[1].label, 'Logo', 'Make Image - Label: form');
  eq(r.images[1].modelHint, 'gpt-image', '"run on GPT Image 2.5 Flare" → gpt-image');
  eq(r.images[1].prompt, 'minimalist swarm logo', 'model parenthetical stripped');
  eq(r.images[2].label, null, 'lowercase makeimage, no separator, no label');
  eq(r.images[2].modelHint, 'nano-banana', 'Nano Banana Pro → nano-banana');
  eq(r.images[2].modelHintRaw, 'Nano Banana Pro', 'raw hint text preserved for the footer');
  eq(r.images[3].label, 'Soul test', 'MakeImg spelling with a two-word label');
  eq(r.images[3].prompt, 'moody portrait, Soul v2', 'a model name without the run/use marker is left in the prompt');
  eq(r.cleanBody, 'MakeUpdate swarm\nSome notes about the swarm.\n\nMore notes here.', 'cleanBody keeps the doc command and notes only');
}

{
  const legacy = parseImageDirectives('MakeImage swarm\na drone over mountains');
  eq(legacy.images.length, 0, 'line-0 project form (no separator) is left to parseImageCommand');
  eq(legacy.cleanBody, 'MakeImage swarm\na drone over mountains', 'legacy body untouched');

  const none = parseImageDirectives('Just a normal message that mentions images and MakeUpdate');
  eq(none.images.length, 0, 'body with no directives → none');
  eq(none.cleanBody, 'Just a normal message that mentions images and MakeUpdate', 'no-directive body unchanged');

  eq(parseImageDirectives('').images.length, 0, 'empty body safe');
  eq(parseImageDirectives(null).images.length, 0, 'null body safe');
  eq(parseImageDirectives('MakeImage -').images.length, 0, 'directive with no prompt is dropped');

  const multiline = parseImageDirectives('MakeImage - Cover: a lighthouse at night,\nstorm clouds, oil painting\n(Run this prompt on Seedream)\n\nSee you Monday.');
  eq(multiline.images.length, 1, 'prompt wrapped over lines is one directive');
  eq(multiline.images[0].prompt, 'a lighthouse at night, storm clouds, oil painting', 'wrapped lines joined, hint on its own line stripped');
  eq(multiline.images[0].modelHint, 'seedream', 'hint on its own line parsed');
  eq(multiline.cleanBody, 'See you Monday.', 'wrapped directive removed from cleanBody');

  // the legacy parsers are untouched
  assert(parseImageCommand('MakeImage swarm a drone').isImage, 'parseImageCommand still works');
  eq(parseInlineImage('MakeUpdate swarm\nmakeimage "x"').imagePrompt, 'x', 'parseInlineImage still works');
}

// ═══════════════════════════════════════════
// Images v2 — model hints + registry
// ═══════════════════════════════════════════
console.log('\n--- Model Hints + Registry ---');

{
  eq(normalizeModelHint('Seedream 5.0'), 'seedream', 'Seedream 5.0 → seedream');
  eq(normalizeModelHint('seedream'), 'seedream', 'bare seedream');
  eq(normalizeModelHint('GPT Image 2.5 Flare'), 'gpt-image', 'GPT Image 2.5 Flare → gpt-image');
  eq(normalizeModelHint('GPT Image'), 'gpt-image', 'GPT Image → gpt-image');
  eq(normalizeModelHint('gpt-image'), 'gpt-image', 'gpt-image id passes through');
  eq(normalizeModelHint('Nano Banana Pro'), 'nano-banana', 'Nano Banana Pro → nano-banana');
  eq(normalizeModelHint('nano banana'), 'nano-banana', 'Nano Banana → nano-banana');
  eq(normalizeModelHint('Soul'), 'soul', 'Soul → soul');
  eq(normalizeModelHint('Soul v2'), 'soul', 'Soul v2 → soul');
  eq(normalizeModelHint('Midjourney'), null, 'unknown model → null');
  eq(normalizeModelHint(''), null, 'empty → null');
  eq(normalizeModelHint(null), null, 'null → null');
}

{
  eq(DEFAULT_IMAGE_MODEL, 'soul', 'default model is soul');
  for (const [id, m] of Object.entries(IMAGE_MODELS)) {
    assert(m.id === id && typeof m.label === 'string' && m.path.startsWith('/') && typeof m.buildBody === 'function' && typeof m.cost === 'number', `registry entry ${id} is well-formed`);
    const body = m.buildBody('a test prompt', { aspectRatio: '1:1' });
    eq(body.prompt, 'a test prompt', `${id} buildBody carries the prompt`);
    eq(body.aspect_ratio, '1:1', `${id} buildBody carries aspect_ratio`);
  }
  eq(IMAGE_MODELS.soul.path, '/higgsfield-ai/soul/v2/standard', 'soul path unchanged');
  eq(IMAGE_MODELS.soul.buildBody('p'), { prompt: 'p', aspect_ratio: '1:1', resolution: '720p' }, 'soul body = {prompt, aspect_ratio, resolution}');
  eq(IMAGE_MODELS.soul.buildBody('p', { aspectRatio: '7:9' }).aspect_ratio, '1:1', 'unsupported ratio falls back to 1:1');
  eq(IMAGE_MODELS['gpt-image'].path, '/marketing-studio/image/flare', 'gpt-image → Marketing Studio Image 2.5 Flare path');
  eq(IMAGE_MODELS['gpt-image'].buildBody('p').enhance_prompt, false, 'flare body disables enhance_prompt (it would require preset_id + image_urls)');
  assert(!('seedream' in IMAGE_MODELS) && !('nano-banana' in IMAGE_MODELS), 'unverified models are NOT registered');

  eq(resolveImageModel('soul'), { model: IMAGE_MODELS.soul, fallback: false }, 'resolve soul');
  eq(resolveImageModel('GPT-Image').model.id, 'gpt-image', 'resolve is case-insensitive');
  eq(resolveImageModel(undefined).fallback, false, 'undefined → default, not a fallback');
  const sd = resolveImageModel('seedream');
  assert(sd.model.id === 'soul' && sd.fallback === true, 'seedream → soul with fallback=true');
  assert(resolveImageModel('nonsense').fallback === true, 'unknown → soul with fallback=true');
}

// ═══════════════════════════════════════════
// Images v2 — send_queue image_ids helpers + filenames
// ═══════════════════════════════════════════
console.log('\n--- Part Image Ids ---');

{
  eq(getPartImageIds({ image_ids: '[3,4,5]', image_id: 3 }), [3, 4, 5], 'image_ids JSON wins');
  eq(getPartImageIds({ image_ids: null, image_id: 7 }), [7], 'falls back to image_id');
  eq(getPartImageIds({ image_id: 7 }), [7], 'works when the image_ids column does not exist yet');
  eq(getPartImageIds({ image_ids: null, image_id: null }), [], 'neither → []');
  eq(getPartImageIds({}), [], 'empty row → []');
  eq(getPartImageIds(null), [], 'null row → []');
  eq(getPartImageIds({ image_ids: 'not json', image_id: 9 }), [9], 'bad JSON falls back to image_id');
  eq(getPartImageIds({ image_ids: '[]', image_id: 9 }), [9], 'empty JSON array falls back to image_id');
  eq(getPartImageIds({ image_ids: '[2,"2",0,-1,"x",5]' }), [2, 5], 'dedupes and drops non-positive / non-numeric ids');
  eq(getPartImageIds({ image_ids: [11, 12] }), [11, 12], 'already-parsed array accepted');
}

{
  eq(MAX_ATTACHMENTS_PER_MESSAGE, 5, 'Securus attachment cap is 5');
  eq(chunkImageIds([1, 2, 3, 4, 5, 6, 7]), [[1, 2, 3, 4, 5], [6, 7]], 'seven ids → 5 + 2');
  eq(chunkImageIds([1, 2]), [[1, 2]], 'under the cap → one batch');
  eq(chunkImageIds([]), [], 'no ids → no batches');
  eq(chunkImageIds([1, 2, 3], 2), [[1, 2], [3]], 'custom batch size');
}

{
  const one = normalizeAttachments({ attachment: { filename: 'a.jpg', mime: 'image/png', bytesB64: 'QUJD' } });
  eq(one, [{ filename: 'a.jpg', mime: 'image/png', bytesB64: 'QUJD', label: null }], 'legacy single attachment is wrapped');
  const many = normalizeAttachments({ attachment: { bytesB64: 'ignored' }, attachments: [{ bytesB64: 'y', label: 'Saga2' }, { bytesB64: '' }, null] });
  eq(many.length, 1, 'attachments list wins over attachment; empty/null entries dropped');
  eq(many[0], { filename: 'image-1.jpg', mime: 'image/jpeg', bytesB64: 'y', label: 'Saga2' }, 'defaults filled, label kept');
  eq(normalizeAttachments({}), [], 'no attachments → []');
  eq(normalizeAttachments(), [], 'undefined → []');
}

{
  eq(imageFilename({ id: 12, label: 'Saga2', doc_tag: 'qualia' }), 'saga2-12.jpg', 'filename from label');
  eq(imageFilename({ id: 13, label: null, doc_tag: 'swarm' }), 'swarm-13.jpg', 'filename from doc_tag when no label');
  eq(imageFilename({ id: 14, label: 'Drone views / top!', doc_tag: 'x' }), 'drone-views-top-14.jpg', 'filename is ASCII-safe');
  eq(imageFilename({ id: 15 }), 'image-15.jpg', 'filename fallback');
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

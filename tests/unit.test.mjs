import { detectSeriesIndicator, stripSeriesIndicator, messageSignature, isNearDuplicate } from '../src/db/series.mjs';
import { parseDocCommand, docAcknowledgment } from '../src/docs/commands.mjs';
import { splitForSend, shouldEscalate, cleanReplyText, voiceViolations, planParts, budgetReply, parseBudgetJson, stampNotice, replyFooter, applyStreamEvent, newStreamAcc } from '../src/ai/responder.mjs';
import { buildSystemPrompt } from '../src/ai/prompt.mjs';
import { docTitle, changeNoteFor } from '../src/db/documents.mjs';
import { parseReferenceDirectives, parseImageCommand, parseInlineImage, mentionedTags } from '../src/docs/commands.mjs';
import { estimateCost } from '../src/db/usage.mjs';
import { contactIdForSender } from '../src/db/contacts.mjs';
import { safeSubject } from '../src/db/send_queue.mjs';

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
// Reply Hygiene (tool preamble must never reach Sam)
// ═══════════════════════════════════════════
console.log('\n--- Reply Hygiene ---');

{
  // exact shape of the msg #438 incident
  const blocks = [
    { type: 'text', text: "I'll search all the key areas of the Sign document that would benefit from current data before writing back to Sam." },
    { type: 'server_tool_use', text: '' },
    { type: 'web_search_tool_result', text: '' },
    { type: 'text', text: 'Sam,\n\nGood call on this. The ASL program details you asked about check out, and I pulled the current numbers.' },
  ];
  const out = cleanReplyText(blocks);
  assert(out.startsWith('Sam,'), 'Sign-document incident: output starts with "Sam,"');
  assert(!out.includes("I'll search"), 'Sign-document incident: preamble removed');
  assert(!out.includes('Sam.Sam'), 'Sign-document incident: no glued greeting');
}

{
  const long = 'Sam,\n\n' + 'Here is the real letter with plenty of substance. '.repeat(12);
  const blocks = [
    { type: 'text', text: 'Let me look up the current parole statutes...' },
    { type: 'server_tool_use', text: '' },
    { type: 'web_search_tool_result', text: '' },
    { type: 'text', text: 'Let me also check one more source.' },
    { type: 'server_tool_use', text: '' },
    { type: 'web_search_tool_result', text: '' },
    { type: 'text', text: long },
  ];
  const out = cleanReplyText(blocks);
  eq(out, long.trim(), 'substantial trailing text (≥400) after last tool block is the whole reply');
}

{
  const blocks = [
    { type: 'text', text: 'Sam, great question — a lot of this rides on the current rules.' },
    { type: 'server_tool_use', text: '' },
    { type: 'web_search_tool_result', text: '' },
    { type: 'text', text: 'Short answer: yes, the window is still 30 days.' },
  ];
  const out = cleanReplyText(blocks);
  assert(out.startsWith('Sam, great question'), 'non-preamble leading text kept when trailing text is short');
  assert(out.includes('\n\nShort answer'), 'kept text blocks joined with a paragraph break');
}

{
  const blocks = [
    { type: 'text', text: 'Quick note on the dates first.' },
    { type: 'text', text: 'Checking the court calendar now...' },
    { type: 'server_tool_use', text: '' },
    { type: 'web_search_tool_result', text: '' },
    { type: 'text', text: 'Sam,\n\nThe hearing is on the 14th.' },
  ];
  const out = cleanReplyText(blocks);
  assert(!out.includes('Checking the court'), 'short "..." block before a tool call is dropped');
  assert(out.includes('Quick note on the dates first.'), 'short non-ellipsis block is kept');
}

{
  const tooled = pre => [
    { type: 'text', text: pre },
    { type: 'server_tool_use', text: '' },
    { type: 'web_search_tool_result', text: '' },
    { type: 'text', text: 'Sam,\n\nShort.' },
  ];
  eq(cleanReplyText(tooled('Good question, let me search.')), 'Sam,\n\nShort.', 'short lead-in + preamble clause dropped');
  eq(cleanReplyText(tooled('Sam, before I answer I want to verify one thing:')), 'Sam,\n\nShort.', 'short block ending with ":" before a tool call dropped');
  eq(cleanReplyText(tooled('I’m going to look that up for you.')), 'Sam,\n\nShort.', 'curly-apostrophe "I’m going to look" dropped');
  eq(cleanReplyText(tooled('I will go ahead and pull the latest numbers.')), 'Sam,\n\nShort.', '"I will go ahead and pull" dropped');
  const realOpener = 'Sam, the short version is that the program still exists and you still qualify.';
  assert(cleanReplyText(tooled(realOpener)).startsWith(realOpener), 'short real opener (no preamble cue) kept');
}

{
  const plain = [{ type: 'text', text: "I'll check in with my mom about the visit and let you know what she says.\n\nMiss you, man." }];
  eq(cleanReplyText(plain), plain[0].text, 'no tool blocks: preamble-looking opener is NOT stripped');
  eq(cleanReplyText([]), '', 'empty block list → empty string');
  eq(cleanReplyText(null), '', 'null → empty string');
}

{
  eq(cleanReplyText([{ type: 'text', text: 'Sam,\n\nSam,\n\nGood to hear from you.' }]), 'Sam,\n\nGood to hear from you.', 'duplicated greeting lines collapse to one');
  const glued = cleanReplyText([{ type: 'text', text: "I'll search the Sign document before writing back to Sam.Sam,\n\nGood call." }]);
  eq(glued, 'Sam,\n\nGood call.', 'glued "Sam.Sam," with preamble prefix → preamble dropped');
  const gluedReal = cleanReplyText([{ type: 'text', text: 'Thanks for checking in on Sam.Sam, you were right.' }]);
  eq(gluedReal, 'Thanks for checking in on Sam.\n\nSam, you were right.', 'glued greeting without preamble gets a line break, nothing lost');
  const okay = 'Hey man. Sam, I owe you a letter.';
  eq(cleanReplyText([{ type: 'text', text: okay }]), okay, 'ordinary "Word. Name," text untouched');
}

{
  // only the text after the last tool block counts, even when preamble sits between
  const blocks = [
    { type: 'text', text: 'I will pull the latest numbers.' },
    { type: 'server_tool_use', text: '' },
    { type: 'web_search_tool_result', text: '' },
    { type: 'text', text: 'Here you go.' },
  ];
  eq(cleanReplyText(blocks), 'Here you go.', 'all preambles before tools dropped when trailer is short');
  const allPreamble = [
    { type: 'text', text: "I'll search for that." },
    { type: 'server_tool_use', text: '' },
    { type: 'web_search_tool_result', text: '' },
  ];
  eq(cleanReplyText(allPreamble), "I'll search for that.", 'never returns empty when some text existed');
}

// ═══════════════════════════════════════════
// Stream Block Tracking
// ═══════════════════════════════════════════
console.log('\n--- Stream Block Tracking ---');

{
  const acc = newStreamAcc();
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 1200, cache_read_input_tokens: 300 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: "I'll search " } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'for that.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'x', name: 'web_search' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', content: [] } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'Sam,\n\nHere it is.' } },
    { type: 'message_delta', usage: { output_tokens: 88, server_tool_use: { web_search_requests: 1 } } },
  ];
  for (const e of events) applyStreamEvent(acc, e);
  eq(acc.blocks.map(b => b.type), ['text', 'server_tool_use', 'web_search_tool_result', 'text'], 'block types tracked in order');
  eq(acc.blocks[0].text, "I'll search for that.", 'text deltas accumulate per block');
  eq(acc.blocks[3].text, 'Sam,\n\nHere it is.', 'later text block kept separate');
  eq(acc.blocks[1].text, '', 'input_json_delta does not pollute text');
  eq([acc.inputTokens, acc.cacheReadTokens, acc.outputTokens, acc.webSearches], [1200, 300, 88, 1], 'usage fields captured');
  eq(cleanReplyText(acc.blocks), 'Sam,\n\nHere it is.', 'tracked blocks clean to the reply');
}

{
  const acc = newStreamAcc();
  applyStreamEvent(acc, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'no start event' } });
  eq(acc.blocks[0].text, 'no start event', 'delta without content_block_start still lands in a text block');
  applyStreamEvent(acc, { type: 'error', error: { message: 'overloaded' } });
  eq(acc.error, 'overloaded', 'error event captured');
  applyStreamEvent(acc, null);
  assert(acc.blocks.length === 1, 'null event ignored');
}

// ═══════════════════════════════════════════
// Voice Check (first person, "you" — never "Sam has")
// ═══════════════════════════════════════════
console.log('\n--- Voice Check ---');

{
  assert(voiceViolations('Sam has been working on the Swarm doc for weeks.', 'Sam').length === 1, 'detects "Sam has been"');
  assert(voiceViolations("I read Sam's message twice.", 'Sam').length === 1, 'detects "Sam\'s message"');
  assert(voiceViolations('Sam asked about the parole window.', 'Sam').length === 1, 'detects "Sam asked"');
  assert(voiceViolations('The user wants four images.', 'Sam').length === 1, 'detects "the user"');
  assert(voiceViolations("I'll write back to Sam once I know more.", 'Sam').length === 1, 'detects "back to Sam"');
  const v = voiceViolations('Sam has been busy.', 'Sam');
  assert(typeof v[0] === 'string' && v[0].startsWith('Sam has'), 'returns the offending snippet');
}

{
  eq(voiceViolations('Sam,\n\nGood to hear from you. You asked about the dates — here they are.', 'Sam'), [], 'direct address "Sam," at line start passes');
  eq(voiceViolations('Sam — you were right about the tone.', 'Sam'), [], 'direct address "Sam —" passes');
  eq(voiceViolations('Thanks, Sam. Take care, Sam!', 'Sam'), [], 'closing vocatives pass');
  eq(voiceViolations('You wrote "Sam has been slacking" and honestly, fair.', 'Sam'), [], 'quoted speech ignored');
  eq(voiceViolations('> Sam asked for four images\n\nYes — all four are attached.', 'Sam'), [], 'quoted (>) lines ignored');
  eq(voiceViolations('', 'Sam'), [], 'empty text → no violations');
  eq(voiceViolations(null, 'Sam'), [], 'null text → no violations');
  eq(voiceViolations('Samantha has been great; Samuel is a different person.', 'Sam'), [], 'name matches whole words only');
}

{
  assert(voiceViolations('SAMUEL MULLIKIN has been clear about this.', 'SAMUEL MULLIKIN').length === 1, 'full legal name works (first token)');
  assert(voiceViolations('Samuel asked about it.', ['sam', 'SAMUEL MULLIKIN']).length === 1, 'array of names accepted');
  eq(voiceViolations('Nothing about anyone here.', null), [], 'no name → only generic patterns, none hit');
  assert(voiceViolations('The sender requested a redraw.', null).length === 1, 'generic "the sender" caught without a name');
}

// ═══════════════════════════════════════════
// Capability Manifest + Contact Profile (prompt slots)
// ═══════════════════════════════════════════
console.log('\n--- Capability Manifest ---');

{
  const base = buildSystemPrompt([], [], 20, [], 'swarm', { contactNick: 'sam', currentDocument: 'DOC BODY' });
  assert(!base.includes('<capability_manifest>'), 'no manifest → no manifest block');
  assert(!base.includes('<contact_profile>'), 'no profile → no profile block');
  assert(base.includes("note you'll continue in a follow-up message"), 'no manifest → legacy overflow wording intact');
  assert(base.includes('<current_document>') && base.includes('DOC BODY'), 'current_document block intact');
}

{
  const manifest = {
    attachments: [{ label: 'Saga2', model: 'Seedream' }, { label: 'Wytches2', model: 'Seedream' }],
    failed: [{ label: 'Saga3', reason: 'content flagged' }],
    openRequests: [{ label: 'Wytches3', kind: 'image' }],
    carriedOver: [{ label: 'Tuesday parole question' }],
    stampsLeft: 6,
    batchSiblings: [{ subject: 'MakeUpdate Monday' }, { subject: 'Documentary idea' }],
  };
  const p = buildSystemPrompt([], [], 20, [], 'swarm', { contactNick: 'sam', currentDocument: 'DOC BODY', profile: 'PROFILE BODY', manifest });
  assert(p.includes('<capability_manifest>'), 'manifest block rendered');
  assert(p.includes('1) Saga2 — Seedream') && p.includes('2) Wytches2 — Seedream'), 'attachments listed with labels + models');
  assert(p.includes('Saga3 — content flagged'), 'failed items listed with reason');
  assert(p.includes('Wytches3 (image)'), 'open requests listed with kind');
  assert(p.includes('Tuesday parole question'), 'carried-over items listed');
  assert(p.includes('MakeUpdate Monday') && p.includes('Documentary idea'), 'batch siblings listed');
  assert(p.includes('Stamps left after this message: 6'), 'stamp line present when ≤ 10');
  assert(p.includes('Never say you cannot attach or generate images.'), 'rules: never deny images');
  assert(p.includes('Never describe, name, or count an image that is not listed under attachments.'), 'rules: no phantom images');
  assert(p.includes('Do not promise follow-up messages'), 'rules: no promises');
  assert(p.includes("address sam as 'you'"), 'rules: first person, address as you');
  assert(p.includes('Do not re-announce that several messages arrived; answer this one.'), 'rules: no batch re-announce');
  assert(!p.includes("note you'll continue in a follow-up message"), 'manifest → legacy follow-up wording replaced');
  assert(p.includes('<contact_profile>') && p.includes('PROFILE BODY'), 'profile block rendered');
  assert(p.indexOf('<contact_profile>') < p.indexOf('<current_document>'), 'profile precedes current_document');
  assert(p.indexOf('<knowledge_base>') < p.indexOf('<capability_manifest>') && p.indexOf('<capability_manifest>') < p.indexOf('<boundaries>'), 'manifest sits between knowledge_base and boundaries');
}

{
  const p = buildSystemPrompt([], [], 20, [], null, { contactNick: 'sam', manifest: { attachments: [], stampsLeft: 42 } });
  assert(p.includes('ATTACHED TO THIS MESSAGE: nothing'), 'empty attachments → explicit "nothing attached"');
  assert(!p.includes('Stamps left after this message'), 'stamps > 10 → no stamp line');
  assert(!p.includes('COULD NOT BE PRODUCED') && !p.includes('OPEN REQUESTS') && !p.includes('SAME BATCH'), 'empty sections omitted');
}

{
  const big = 'P'.repeat(9000);
  const p = buildSystemPrompt([], [], 20, [], null, { contactNick: 'sam', profile: big });
  const block = p.slice(p.indexOf('<contact_profile>'), p.indexOf('</contact_profile>'));
  assert((block.match(/P/g) || []).length <= 8000 + 20, 'profile capped at 8,000 chars (head)');
  assert(block.includes('profile truncated'), 'profile truncation marker present');
}

{
  const es = buildSystemPrompt([], [], 20, [], null, { contactNick: 'ricardo', contactName: 'RICARDO CHALCHISEVILLA', language: 'es', manifest: { attachments: [] }, referenceDocs: [{ name: 'monday', content: 'REF' }] });
  assert(es.includes('<language>') && es.includes('SPANISH'), 'language block intact alongside manifest');
  assert(es.includes('<reference_document name="Monday">'), 'reference_document block intact alongside manifest');
  assert(es.includes('NEVER mention, reference, or reveal anything about any other person'), 'isolation boundary intact');
}

// ═══════════════════════════════════════════
// Plan Parts / Part Cap
// ═══════════════════════════════════════════
console.log('\n--- Plan Parts ---');

{
  const fits = planParts('RE: Test', 'Short reply', 3);
  eq(fits.parts.length, 1, 'short body plans to 1 part');
  eq(fits.truncated, false, 'short body not truncated');
  eq(fits.overflowText, '', 'short body has no overflow');
}

{
  const body = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}. ` + 'word '.repeat(3200)).join('\n\n'); // ~96K
  const unbounded = splitForSend('RE: Test', body);
  assert(unbounded.length >= 5, `uncapped splitForSend still splits everything (${unbounded.length} parts)`);
  const plan = planParts('RE: Test', body, 3);
  eq(plan.parts.length, 3, 'planParts caps at 3');
  eq(plan.truncated, true, 'planParts reports truncation');
  assert(plan.overflowText.length > 0, 'overflowText carries the dropped remainder');
  eq(plan.parts.map(p => p.body).join('').length + plan.overflowText.replace(/\n\n/g, '').length <= body.length, true, 'kept + overflow never exceed the source');
  eq(plan.parts[1].subject, 'RE: Test (pt 2)', 'part subjects numbered');
  const capped = splitForSend('RE: Test', body, { maxParts: 2 });
  eq(capped.length, 2, 'splitForSend honours maxParts when given');
  eq(capped[0].body, plan.parts[0].body, 'capped split matches the plan');
  for (const p of capped) assert(p.subject.length + p.body.length <= 20000, 'capped parts fit the 20k limit');
}

{
  eq(planParts('RE: X', '', 3).parts.length, 1, 'empty body plans to one empty part');
  eq(planParts('RE: X', 'word '.repeat(9000), 0).parts.length, 1, 'maxParts 0 is treated as 1');
}

// ═══════════════════════════════════════════
// Budget Reply (offline paths) + JSON parsing
// ═══════════════════════════════════════════
console.log('\n--- Budget Reply ---');

{
  const parsed = parseBudgetJson('Here you go:\n```json\n{"text": "Sam,\\n\\nShort version.", "overflow_items": ["Swarm chapter 3 feedback", " ", 7]}\n```');
  eq(parsed.text, 'Sam,\n\nShort version.', 'parseBudgetJson extracts text (fenced)');
  eq(parsed.overflowItems, ['Swarm chapter 3 feedback', '7'], 'parseBudgetJson normalizes overflow items');
  eq(parseBudgetJson('{"text": "ok"}').overflowItems, [], 'missing overflow_items → []');
  eq(parseBudgetJson('{"overflow_items": []}'), null, 'no text → null');
  eq(parseBudgetJson('not json at all'), null, 'garbage → null');
  eq(parseBudgetJson(''), null, 'empty → null');
}

{
  const draft = 'Sam,\n\nFits fine.';
  const r = await budgetReply({}, draft, { subject: 'RE: Test', maxParts: 3 });
  eq(r.text, draft, 'fitting draft returned unchanged');
  eq(r.overflowItems, [], 'fitting draft has no overflow items');
  eq(r.compressed, false, 'fitting draft not compressed');
}

{
  const draft = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}. ` + 'word '.repeat(3200)).join('\n\n');
  const r = await budgetReply({}, draft, { subject: 'RE: Test', maxParts: 3 }); // no API key → hard cut
  const plan = planParts('RE: Test', r.text, 3);
  eq(plan.truncated, false, 'no-API fallback: result fits in 3 parts');
  eq(r.overflowItems.length, 1, 'no-API fallback: one overflow item names the remainder');
  assert(/remainder of the reply/.test(r.overflowItems[0]), 'no-API fallback: overflow item wording');
  eq(r.truncated, true, 'no-API fallback flagged truncated');
  const r2 = await budgetReply({}, draft, { subjectLength: 8, maxParts: 3 });
  eq(planParts('x'.repeat(8), r2.text, 3).truncated, false, 'subjectLength form also works');
}

// ═══════════════════════════════════════════
// Stamp Notice
// ═══════════════════════════════════════════
console.log('\n--- Stamp Notice ---');

{
  eq(stampNotice(10), 'Stamps left after this message: 10', 'threshold 10');
  eq(stampNotice(5), 'Stamps left after this message: 5', 'threshold 5');
  eq(stampNotice(3), 'Stamps left after this message: 3', 'threshold 3');
  eq(stampNotice(2), 'Stamps left after this message: 2', 'threshold 2');
  eq(stampNotice(1), 'Stamps left after this message: 1', 'threshold 1');
  eq(stampNotice(0), "Stamps left after this message: 0 — I can't send again until Dennis adds stamps", 'zero → out-of-stamps wording');
  eq(stampNotice(-1), "Stamps left after this message: 0 — I can't send again until Dennis adds stamps", 'negative clamps to zero wording');
  eq(stampNotice(11), null, '11 → null');
  eq(stampNotice(61), null, 'plenty → null');
  eq(stampNotice(null), null, 'null → null');
  eq(stampNotice(undefined), null, 'undefined → null');
  eq(stampNotice('7'), 'Stamps left after this message: 7', 'numeric string accepted (state values are strings)');
  eq(stampNotice('abc'), null, 'non-numeric string → null');
}

// ═══════════════════════════════════════════
// Reply Footer (pipeline-appended, never model-written)
// ═══════════════════════════════════════════
console.log('\n--- Reply Footer ---');

{
  const f = replyFooter({
    attachments: [{ label: 'Saga2', model: 'Seedream' }, { label: 'Wytches2', model: 'Seedream' }],
    failed: [{ label: 'Saga3', reason: 'content flagged' }],
    openRequests: [{ label: 'Wytches3', kind: 'image' }, { label: 'Parole timeline', kind: 'answer' }],
    stampsLeft: 6,
  });
  const lines = f.split('\n');
  eq(lines[0], 'Attached: 1) Saga2 — Seedream · 2) Wytches2 — Seedream', 'attached line format');
  eq(lines[1], "Couldn't produce: Saga3 (content flagged)", 'could-not-produce line format');
  eq(lines[2], 'Still working on: Wytches3, Parole timeline — coming in a later message', 'still-working line format');
  eq(lines[3], 'Stamps left after this message: 6', 'stamp notice appended');
  eq(lines.length, 4, 'exactly four lines');
}

{
  eq(replyFooter({}), '', 'empty manifest → empty footer');
  eq(replyFooter(null), '', 'null manifest → empty footer');
  eq(replyFooter({ attachments: [], failed: [], openRequests: [], stampsLeft: 40 }), '', 'nothing to say → empty footer');
  eq(replyFooter({ attachments: [{ label: 'Logo' }] }), 'Attached: 1) Logo', 'attachment without model omits the dash');
  eq(replyFooter({ failed: [{ label: 'X' }] }), "Couldn't produce: X", 'failure without reason omits parens');
  eq(replyFooter({ stampsLeft: 0 }), "Stamps left after this message: 0 — I can't send again until Dennis adds stamps", 'stamps-only footer');
  eq(replyFooter({ carriedOver: [{ label: 'old item' }] }), '', 'carriedOver alone adds no footer line');
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

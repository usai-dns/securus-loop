import { mulawDecode, mulawEncode, twilioToGemini, geminiToTwilio } from '../src/audio.js';

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
// Mu-law Codec
// ═══════════════════════════════════════════
console.log('\n--- Mu-law Codec ---');

{
  // Silence in mu-law is 0xFF (127 unsigned)
  const silence = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
  const pcm = mulawDecode(silence);
  eq(pcm.length, 4, 'decode produces same number of samples');
  assert(Math.abs(pcm[0]) <= 1, 'silence decodes to near-zero PCM');
}

{
  // Roundtrip: encode then decode should approximate original
  const original = new Int16Array([0, 1000, -1000, 5000, -5000, 16000, -16000, 32000, -32000]);
  const encoded = mulawEncode(original);
  const decoded = mulawDecode(encoded);
  eq(decoded.length, original.length, 'roundtrip preserves sample count');

  // Mu-law is lossy but should be close
  for (let i = 0; i < original.length; i++) {
    const error = Math.abs(decoded[i] - original[i]);
    const tolerance = Math.max(Math.abs(original[i]) * 0.1, 100);
    assert(error <= tolerance, `roundtrip sample ${i}: orig=${original[i]}, got=${decoded[i]}, error=${error}`);
  }
}

{
  // Encode output should be 8-bit unsigned
  const pcm = new Int16Array([0, 1000, -1000]);
  const mulaw = mulawEncode(pcm);
  assert(mulaw instanceof Uint8Array, 'encode returns Uint8Array');
  eq(mulaw.length, 3, 'encode preserves sample count');
  for (let i = 0; i < mulaw.length; i++) {
    assert(mulaw[i] >= 0 && mulaw[i] <= 255, `mulaw byte ${i} in range: ${mulaw[i]}`);
  }
}

// ═══════════════════════════════════════════
// Twilio <-> Gemini Transcoding
// ═══════════════════════════════════════════
console.log('\n--- Twilio <-> Gemini Transcoding ---');

{
  // twilioToGemini: mulaw base64 -> PCM 16kHz base64
  const silence = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
  let binary = '';
  for (let i = 0; i < silence.length; i++) binary += String.fromCharCode(silence[i]);
  const b64 = btoa(binary);

  const result = twilioToGemini(b64);
  assert(typeof result === 'string', 'twilioToGemini returns base64 string');
  assert(result.length > 0, 'twilioToGemini produces output');

  // 4 samples at 8kHz -> 8 samples at 16kHz (2x upsample)
  const decoded = atob(result);
  const pcmBytes = decoded.length;
  eq(pcmBytes / 2, 8, '4 mulaw samples at 8kHz -> 8 PCM samples at 16kHz');
}

{
  // geminiToTwilio: PCM 24kHz base64 -> mulaw 8kHz base64
  // 6 PCM samples at 24kHz -> 2 mulaw samples at 8kHz (3x downsample)
  const pcm24k = new Int16Array([0, 500, 1000, 500, 0, -500]);
  const pcmBytes = new Uint8Array(pcm24k.buffer, pcm24k.byteOffset, pcm24k.byteLength);
  let binary = '';
  for (let i = 0; i < pcmBytes.length; i++) binary += String.fromCharCode(pcmBytes[i]);
  const b64 = btoa(binary);

  const result = geminiToTwilio(b64);
  assert(typeof result === 'string', 'geminiToTwilio returns base64 string');
  assert(result.length > 0, 'geminiToTwilio produces output');

  const decoded = atob(result);
  eq(decoded.length, 2, '6 PCM samples at 24kHz -> 2 mulaw samples at 8kHz');
}

{
  // Empty input handling
  const emptyB64 = btoa('');
  try {
    twilioToGemini(emptyB64);
    assert(true, 'twilioToGemini handles empty input without crash');
  } catch (e) {
    assert(false, `twilioToGemini crashed on empty: ${e.message}`);
  }
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

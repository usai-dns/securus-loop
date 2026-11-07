// Drives attachAll against a stub compose page: every page.evaluate the real
// code performs is answered by inspecting the function it was handed. Catches
// return-shape / undefined-identifier bugs the pipeline harness (no browser)
// cannot — e.g. `sentName` vs `sendName` (live send failure, 2026-11-07).
import { attachAll, normalizeAttachments } from '../src/securus/compose.mjs';

let passed = 0, failed = 0; const failures = [];
function assert(c, name) { if (c) passed++; else { failed++; failures.push(name); console.log(`  ✗ ${name}`); } }

// collapse the human-pacing delays
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...a) => realSetTimeout(fn, 0, ...a);

function stubPage({ registered = null, injectFails = false } = {}) {
  const calls = [];
  return {
    calls,
    async evaluate(fn, ...args) {
      const src = fn.toString();
      calls.push(src.substring(0, 40));
      if (/querySelectorAll\('a, button, label'\)/.test(src)) return true;                 // Attachments control click
      if (/toDataURL/.test(src)) return { ok: true, b64: 'c21hbGw=', w: 10, h: 10 };        // in-page downscale
      if (/DataTransfer/.test(src)) return injectFails ? 'err: no input' : true;           // file injection
      if (/innerText/.test(src) && /remove\|attached/.test(src)) return true;             // confirmation
      return registered;                                                                   // countRegisteredAttachments
    },
    async waitForSelector() { return {}; },
  };
}

console.log('\n--- attachAll: stub page ---');
{
  const page = stubPage({ registered: 2 });
  const files = normalizeAttachments({ attachments: [
    { filename: 'saga2-7.png', mime: 'image/png', bytesB64: 'x'.repeat(10), label: 'Saga2' },
    { filename: 'sample-8.jpg', mime: 'image/jpeg', bytesB64: 'y'.repeat(10), label: 'Sample' },
  ] });
  const r = await attachAll(page, files);
  assert(r.ok === true && r.attached === 2, `two files attach (${JSON.stringify(r)})`);
  assert(Array.isArray(r.names) && r.names.length === 2 && r.names.every(n => typeof n === 'string' && n.length), `names are strings, never undefined (${JSON.stringify(r.names)})`);
  assert(r.names[0] === 'saga2-7.jpg', 'PNG downscaled → .jpg name reported');
  assert(r.names[1] === 'sample-8.jpg', 'small JPEG keeps its name');
  assert(r.registered === 2, 'registered count passed through');
}
{
  const page = stubPage({ injectFails: true });
  const r = await attachAll(page, normalizeAttachments({ attachment: { filename: 'a.jpg', mime: 'image/jpeg', bytesB64: 'zz' } }));
  assert(r.ok === false && r.index === 0 && /injection failed/.test(r.reason), `injection failure aborts before Send (${JSON.stringify(r)})`);
}
{
  const r = await attachAll(stubPage(), []);
  assert(r.ok === true && r.attached === 0, 'no files → ok with nothing attached');
}

globalThis.setTimeout = realSetTimeout;
console.log(`\nAttach: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }

// puppeteer helpers for cloudflare browser rendering

export async function humanDelay(min = 500, max = 2000) {
  const ms = Math.floor(Math.random() * (max - min) + min);
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function fillField(page, selector, value) {
  // focus and clear
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');

  if (value.length < 300) {
    // short values: type normally (Angular-safe)
    await page.type(selector, value, { delay: 5 });
  } else {
    // long values: type first 10 chars to activate Angular binding,
    // then set full value via JS and re-trigger input event
    await page.type(selector, value.substring(0, 10), { delay: 5 });
    await page.evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if (el) {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selector, value);
    // type one more char at the end to ensure Angular picks up the final value
    await page.keyboard.press('End');
    // press and release a key Angular sees
    await page.keyboard.press('Space');
    await page.keyboard.press('Backspace');
  }
}

export async function waitForHash(page, hashFragment, timeout = 15000) {
  // wait for Angular hash route to change
  await page.waitForFunction(
    (fragment) => window.location.hash.includes(fragment),
    { timeout },
    hashFragment
  );
}

export async function safeTextContent(page, selector) {
  try {
    return await page.$eval(selector, el => el.textContent?.trim() || '');
  } catch {
    return null;
  }
}

export async function safeGoto(page, url, options = {}, retries = 3) {
  const opts = { waitUntil: 'domcontentloaded', timeout: 45000, ...options };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await page.goto(url, opts);
    } catch (err) {
      log('NAV', `goto attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) throw err;
      await humanDelay(2000, 4000);
    }
  }
}

export function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

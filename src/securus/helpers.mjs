// puppeteer helpers for cloudflare browser rendering

export async function humanDelay(min = 500, max = 2000) {
  const ms = Math.floor(Math.random() * (max - min) + min);
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function fillField(page, selector, value) {
  // clear field and type new value — works with Angular reactive forms
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, selector);
  await humanDelay(100, 200);
  await page.type(selector, value, { delay: 15 });
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

export function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

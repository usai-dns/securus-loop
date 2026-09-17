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
  // Sept 2026: Securus migrated from hash routing (#/path) to real paths WITH
  // real page navigations, so poll page.url() (CDP-side, never touches the
  // page's JS context — immune to reloads and detached frames).
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (page.url().includes(hashFragment)) return; } catch { /* mid-navigation */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`URL never contained "${hashFragment}" within ${timeout}ms`);
}

// absorb a real navigation that an in-page click may have triggered (cookie
// accept and login submit cause full reloads on the post-Sept-2026 site)
export async function absorbNavigation(page, timeout = 6000) {
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }).catch(() => {});
  await humanDelay(400, 800);
}

// Sept 2026 site: /products/emessage/* deep links bounce to /my-account unless
// the messaging app has been "launched" (the LAUNCH tile boots product
// context). Click it like a human, then in-app routing works.
export async function launchMessaging(page, urls) {
  if (page.url().includes('/products/emessage')) return true;
  await safeGoto(page, urls.myAccount);
  await humanDelay(1500, 2500);
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('a')]
      .find(a => (a.getAttribute('href') || '').includes('/products/emessage/inbox'));
    if (el) { el.click(); return true; }
    return false;
  }).catch(() => false);
  if (!clicked) { log('NAV', 'LAUNCH link not found on my-account'); return false; }
  await absorbNavigation(page);
  await humanDelay(1500, 2500);
  log('NAV', `launched messaging app → ${page.url()}`);
  return page.url().includes('/products/emessage');
}

export async function safeTextContent(page, selector) {
  try {
    return await page.$eval(selector, el => el.textContent?.trim() || '');
  } catch {
    return null;
  }
}

export async function safeGoto(page, url, options = {}, retries = 2) {
  const opts = { waitUntil: 'domcontentloaded', timeout: 30000, ...options };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await page.goto(url, opts);
    } catch (err) {
      log('NAV', `goto attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) throw err;
      await humanDelay(1000, 2000);
    }
  }
}

export function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

// Navigate INSIDE the launched messaging app by clicking a nav control whose
// text (or href) matches — never by goto, which reboots the app and bounces
// to /my-account (Sept 2026). Ensures the app is launched first.
export async function inAppNav(page, urls, matcher) {
  if (!page.url().includes('/products/emessage')) {
    const ok = await launchMessaging(page, urls);
    if (!ok) return false;
  }
  const re = new RegExp(matcher, 'i');
  const clicked = await page.evaluate((src) => {
    const re2 = new RegExp(src, 'i');
    const el = [...document.querySelectorAll('a, button')].find(e =>
      re2.test((e.textContent || '').trim()) || re2.test(e.getAttribute('href') || ''));
    if (el) { el.click(); return true; }
    return false;
  }, matcher).catch(() => false);
  if (!clicked) { log('NAV', `in-app nav control /${matcher}/ not found at ${page.url()}`); return false; }
  await absorbNavigation(page, 2500);
  await humanDelay(1200, 2000);
  log('NAV', `in-app nav /${matcher}/ → ${page.url()}`);
  return true;
}

// securus login flow for cloudflare worker (puppeteer)

import { login as sel, urls } from './selectors.mjs';
import { humanDelay, fillField, waitForHash, safeGoto, log } from './helpers.mjs';

// Securus periodically presents amended Terms & Conditions in a reveal modal
// that blocks login/navigation until accepted (first seen: v3.1, June 2026).
export async function acceptPendingTerms(page) {
  const accepted = await page.evaluate(() => {
    const overlays = [...document.querySelectorAll('.reveal-overlay, .reveal')];
    for (const o of overlays) {
      const visible = !!(o.offsetWidth || o.offsetHeight);
      if (!visible) continue;
      const text = (o.innerText || '').toUpperCase();
      if (!text.includes('TERMS')) continue;
      const btn = [...o.querySelectorAll('button, a.button')]
        .find(b => (b.textContent || '').trim().toLowerCase() === 'accept');
      if (btn) { btn.click(); return true; }
    }
    return false;
  }).catch(() => false);
  if (accepted) {
    log('AUTH', 'accepted updated Terms & Conditions modal');
    await humanDelay(1500, 2500);
  }
  return accepted;
}

// Dismiss visible overlay modals that are NOT the T&C modal (chat banner,
// promo popups) — they can intercept clicks on the submit button, making login
// silently fail (same failure mode as the old Send-button interception).
async function dismissNonTermsOverlays(page) {
  const removed = await page.evaluate(() => {
    let n = 0;
    for (const o of document.querySelectorAll('.reveal-overlay, .reveal, [class*="modal"]')) {
      const visible = !!(o.offsetWidth || o.offsetHeight);
      if (!visible) continue;
      const text = (o.innerText || '').toUpperCase();
      if (text.includes('TERMS')) continue; // T&C must be Accepted, not removed
      o.remove(); n++;
    }
    return n;
  }).catch(() => 0);
  if (removed) log('AUTH', `dismissed ${removed} overlay(s) before submit`);
  return removed;
}

export async function loginToSecurus(page, env) {
  log('AUTH', 'navigating to login page...');
  await safeGoto(page, urls.login);
  await humanDelay(1000, 2000);

  // wait for Angular to render the login form — the SPA is sometimes slow;
  // reload and re-wait rather than giving up at the first 15s (issue #13).
  log('AUTH', 'waiting for login form...');
  let formReady = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.waitForSelector(sel.emailField, { visible: true, timeout: 20000 });
      formReady = true;
      break;
    } catch {
      log('AUTH', `login form not rendered (attempt ${attempt}/3), reloading...`);
      if (attempt < 3) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await humanDelay(3000, 5000);
      }
    }
  }
  if (!formReady) {
    log('AUTH', 'login form never rendered after 3 attempts');
    return false;
  }

  await dismissNonTermsOverlays(page);

  log('AUTH', 'filling credentials...');
  await fillField(page, sel.emailField, env.SECURUS_LOGIN_EMAIL);
  await humanDelay(200, 400);
  await fillField(page, sel.passwordField, env.SECURUS_LOGIN_PASS);
  await humanDelay(200, 400);

  // submit via DOM click so an overlay can't intercept it; fall back to Enter
  log('AUTH', 'submitting...');
  const domClicked = await page.evaluate((btnSel) => {
    const btn = document.querySelector(btnSel);
    if (btn) { btn.click(); return true; }
    return false;
  }, sel.submitButton).catch(() => false);
  if (!domClicked) {
    await page.focus(sel.passwordField).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
  await humanDelay(2000, 3000);

  // amended T&C modal blocks the redirect until accepted
  const acceptedTerms = await acceptPendingTerms(page);

  // wait for redirect to my-account (angular hash routing)
  await waitForHash(page, '#/my-account', 15000).catch(() => {
    log('AUTH', 'warning: did not detect my-account redirect');
  });
  await humanDelay(500, 1000);

  let url = page.url();
  let success = url.includes('my-account');

  if (!success && acceptedTerms) {
    // session may already be authenticated but stuck on login — go directly
    log('AUTH', 'terms accepted but still on login, navigating to my-account...');
    await safeGoto(page, urls.myAccount);
    await humanDelay(1000, 2000);
    url = page.url();
    success = url.includes('my-account');
  }

  if (!success) {
    // one retry: dismiss any overlay that appeared, re-fill, submit via Enter
    // (a different path than the click, in case the click is being swallowed)
    const formPresent = await page.$(sel.emailField).catch(() => null);
    if (formPresent) {
      log('AUTH', 'retrying login submit (keyboard path)...');
      await dismissNonTermsOverlays(page);
      await fillField(page, sel.emailField, env.SECURUS_LOGIN_EMAIL);
      await humanDelay(200, 400);
      await fillField(page, sel.passwordField, env.SECURUS_LOGIN_PASS);
      await humanDelay(200, 400);
      await page.focus(sel.passwordField).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await humanDelay(2000, 3000);
      await acceptPendingTerms(page);
      await waitForHash(page, '#/my-account', 15000).catch(() => {});
      await humanDelay(500, 1000);
      url = page.url();
      success = url.includes('my-account');

      if (!success) {
        // last resort: the session may be authenticated without redirecting
        await safeGoto(page, urls.myAccount);
        await humanDelay(1500, 2500);
        url = page.url();
        success = url.includes('my-account');
      }
    }
  }

  log('AUTH', success ? `logged in → ${url}` : `login may have failed → ${url}`);
  return success;
}

export async function logout(page) {
  log('AUTH', 'signing out...');
  await safeGoto(page, urls.login, { timeout: 15000 });
  await humanDelay(500, 1000);
  log('AUTH', 'signed out');
}

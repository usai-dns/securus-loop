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

export async function loginToSecurus(page, env) {
  log('AUTH', 'navigating to login page...');
  await safeGoto(page, urls.login);
  await humanDelay(1000, 2000);

  // wait for Angular to render the login form
  log('AUTH', 'waiting for login form...');
  await page.waitForSelector(sel.emailField, { visible: true, timeout: 15000 });

  log('AUTH', 'filling credentials...');
  await fillField(page, sel.emailField, env.SECURUS_LOGIN_EMAIL);
  await humanDelay(200, 400);
  await fillField(page, sel.passwordField, env.SECURUS_LOGIN_PASS);
  await humanDelay(200, 400);

  log('AUTH', 'submitting...');
  await page.click(sel.submitButton);
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
    // one retry: re-fill and resubmit (terms modal may have eaten the first submit)
    const formPresent = await page.$(sel.emailField).catch(() => null);
    if (formPresent) {
      log('AUTH', 'retrying login submit...');
      await fillField(page, sel.emailField, env.SECURUS_LOGIN_EMAIL);
      await humanDelay(200, 400);
      await fillField(page, sel.passwordField, env.SECURUS_LOGIN_PASS);
      await humanDelay(200, 400);
      await page.click(sel.submitButton);
      await humanDelay(2000, 3000);
      await acceptPendingTerms(page);
      await waitForHash(page, '#/my-account', 15000).catch(() => {});
      await humanDelay(500, 1000);
      url = page.url();
      success = url.includes('my-account');
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

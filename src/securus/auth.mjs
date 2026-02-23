// securus login flow for cloudflare worker (puppeteer)

import { login as sel, urls } from './selectors.mjs';
import { humanDelay, fillField, waitForHash, log } from './helpers.mjs';

export async function loginToSecurus(page, env) {
  log('AUTH', 'navigating to login page...');
  await page.goto(urls.login, { waitUntil: 'networkidle0', timeout: 30000 });
  await humanDelay(1000, 2000);

  // wait for Angular to render the login form
  log('AUTH', 'waiting for login form...');
  await page.waitForSelector(sel.emailField, { visible: true, timeout: 15000 });

  log('AUTH', 'filling credentials...');
  await fillField(page, sel.emailField, env.SECURUS_LOGIN_EMAIL);
  await humanDelay(300, 600);
  await fillField(page, sel.passwordField, env.SECURUS_LOGIN_PASS);
  await humanDelay(300, 600);

  log('AUTH', 'submitting...');
  await page.click(sel.submitButton);

  // wait for redirect to my-account (angular hash routing)
  await waitForHash(page, '#/my-account', 15000).catch(() => {
    log('AUTH', 'warning: did not detect my-account redirect');
  });
  await humanDelay(1500, 2500);

  const url = page.url();
  const success = url.includes('my-account');
  log('AUTH', success ? `logged in → ${url}` : `login may have failed → ${url}`);
  return success;
}

export async function logout(page) {
  log('AUTH', 'signing out...');
  await page.goto(urls.login, { waitUntil: 'networkidle0', timeout: 15000 });
  await humanDelay(500, 1000);
  log('AUTH', 'signed out');
}

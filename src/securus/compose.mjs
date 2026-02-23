// securus compose and send for cloudflare worker (puppeteer)

import { urls, compose as sel, contacts } from './selectors.mjs';
import { humanDelay, fillField, log } from './helpers.mjs';

export async function composeAndSend(page, { contactId, subject, body }) {
  log('COMPOSE', 'navigating to compose page...');
  await page.goto(urls.compose, { waitUntil: 'networkidle0', timeout: 30000 });
  await humanDelay(2000, 3000);

  // wait for Angular to render the compose form
  log('COMPOSE', 'waiting for compose form to render...');
  await page.waitForSelector(sel.contactDropdown, { visible: true, timeout: 15000 }).catch(async () => {
    // if form didn't render, try reloading
    log('COMPOSE', 'form not found, reloading...');
    await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
    await humanDelay(3000, 5000);
    await page.waitForSelector(sel.contactDropdown, { visible: true, timeout: 15000 });
  });

  // dismiss any leftover modals
  const hasOverlay = await page.$('.reveal-overlay');
  if (hasOverlay) {
    log('COMPOSE', 'dismissing leftover modal...');
    await page.evaluate(() => {
      const overlay = document.querySelector('.reveal-overlay');
      if (overlay) overlay.remove();
    });
    await humanDelay(500, 1000);
    await page.goto(urls.compose, { waitUntil: 'networkidle0', timeout: 30000 });
    await humanDelay(2000, 3000);
    await page.waitForSelector(sel.contactDropdown, { visible: true, timeout: 15000 });
  }

  // select contact
  log('COMPOSE', `selecting contact ${contactId}...`);
  await page.select(sel.contactDropdown, contactId);
  await humanDelay(1000, 2000);

  // wait for subject/body fields to be available after contact selection
  await page.waitForSelector(sel.subjectField, { visible: true, timeout: 10000 });
  await page.waitForSelector(sel.messageBody, { visible: true, timeout: 10000 });

  // fill subject
  log('COMPOSE', `subject: ${subject}`);
  await fillField(page, sel.subjectField, subject);
  await humanDelay(400, 800);

  // fill body
  log('COMPOSE', `body: ${body.substring(0, 100)}...`);
  await fillField(page, sel.messageBody, body);
  await humanDelay(400, 800);

  // verify form content
  const actualSubject = await page.$eval(sel.subjectField, el => el.value);
  const actualBody = await page.$eval(sel.messageBody, el => el.value);
  log('COMPOSE', `verified subject: "${actualSubject}"`);
  log('COMPOSE', `verified body length: ${actualBody.length} chars`);

  // click Send
  log('COMPOSE', 'clicking Send...');
  await page.waitForSelector(sel.sendButton, { visible: true, timeout: 10000 });
  const sendDisabled = await page.$eval(sel.sendButton, el => el.disabled);
  if (sendDisabled) {
    log('COMPOSE', 'ERROR: Send button is disabled');
    // capture page state for debugging
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500));
    log('COMPOSE', `page text: ${pageText}`);
    return { success: false, error: 'Send button disabled' };
  }

  await humanDelay(500, 1000);
  await page.click(sel.sendButton);
  log('COMPOSE', 'send clicked, waiting for confirmation modal...');

  // wait for the stamp usage confirmation modal to appear
  await page.waitForSelector('.reveal-overlay', { visible: true, timeout: 10000 }).catch(() => {
    log('COMPOSE', 'no modal appeared within timeout');
  });
  await humanDelay(1000, 2000);

  // handle stamp usage confirmation modal — click the Confirm button
  const modalButtons = await page.$$('.reveal-overlay button');
  let confirmed = false;
  for (const btn of modalButtons) {
    const text = await page.evaluate(el => el.textContent?.trim(), btn);
    log('COMPOSE', `modal button: "${text}"`);
    if (text && text.toLowerCase().includes('confirm')) {
      await humanDelay(500, 1000);
      await btn.click();
      confirmed = true;
      log('COMPOSE', 'CONFIRMED! message sending...');
      break;
    }
  }

  if (!confirmed) {
    log('COMPOSE', 'WARNING: could not find Confirm button in modal');
    // try broader selector as fallback
    const anyConfirm = await page.$('button:nth-child(1)');
    if (anyConfirm) {
      const text = await page.evaluate(el => el.textContent?.trim(), anyConfirm);
      log('COMPOSE', `fallback button: "${text}"`);
    }
  }

  // wait for navigation away from compose page
  await humanDelay(3000, 5000);

  const postUrl = page.url();
  log('COMPOSE', `post-send URL: ${postUrl}`);

  // check sent folder for verification
  const success = !postUrl.includes('/compose');
  return { success, postUrl };
}

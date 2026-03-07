// securus compose and send for cloudflare worker (puppeteer)

import { urls, compose as sel, contacts } from './selectors.mjs';
import { humanDelay, fillField, safeGoto, log } from './helpers.mjs';

export async function composeAndSend(page, { contactId, subject, body }) {
  log('COMPOSE', 'navigating to compose page...');
  await safeGoto(page, urls.compose);
  await humanDelay(1500, 2500);

  // wait for Angular to render the compose form
  log('COMPOSE', 'waiting for compose form to render...');
  await page.waitForSelector(sel.contactDropdown, { visible: true, timeout: 15000 }).catch(async () => {
    // if form didn't render, try reloading
    log('COMPOSE', 'form not found, reloading...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(1000, 2000);
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
    await humanDelay(300, 500);
    await safeGoto(page, urls.compose);
    await humanDelay(500, 1000);
    await page.waitForSelector(sel.contactDropdown, { visible: true, timeout: 15000 });
  }

  // select contact
  log('COMPOSE', `selecting contact ${contactId}...`);
  await page.select(sel.contactDropdown, contactId);
  await humanDelay(500, 1000);

  // wait for subject/body fields to be available after contact selection
  await page.waitForSelector(sel.subjectField, { visible: true, timeout: 10000 });
  await page.waitForSelector(sel.messageBody, { visible: true, timeout: 10000 });

  // fill subject
  log('COMPOSE', `subject: ${subject}`);
  await fillField(page, sel.subjectField, subject);
  await humanDelay(200, 400);

  // fill body
  log('COMPOSE', `body: ${body.substring(0, 100)}...`);
  await fillField(page, sel.messageBody, body);
  await humanDelay(200, 400);

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
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500));
    log('COMPOSE', `page text: ${pageText}`);
    return { success: false, error: 'Send button disabled' };
  }

  await humanDelay(300, 500);
  await page.click(sel.sendButton);
  log('COMPOSE', 'send clicked, waiting for confirmation modal...');

  // wait for the stamp usage confirmation modal to appear
  await page.waitForSelector('.reveal-overlay', { visible: true, timeout: 10000 }).catch(() => {
    log('COMPOSE', 'no modal appeared within timeout');
  });
  await humanDelay(500, 1000);

  // handle stamp usage confirmation modal — click the Confirm button
  const modalButtons = await page.$$('.reveal-overlay button');
  let confirmed = false;
  for (const btn of modalButtons) {
    const text = await page.evaluate(el => el.textContent?.trim(), btn);
    log('COMPOSE', `modal button: "${text}"`);
    if (text && text.toLowerCase().includes('confirm')) {
      await humanDelay(300, 500);
      await btn.click();
      confirmed = true;
      log('COMPOSE', 'CONFIRMED! message sending...');
      break;
    }
  }

  if (!confirmed) {
    log('COMPOSE', 'WARNING: could not find Confirm button in modal');
    const anyConfirm = await page.$('button:nth-child(1)');
    if (anyConfirm) {
      const text = await page.evaluate(el => el.textContent?.trim(), anyConfirm);
      log('COMPOSE', `fallback button: "${text}"`);
    }
  }

  // wait for navigation away from compose page
  await humanDelay(1500, 2500);

  const postUrl = page.url();
  log('COMPOSE', `post-send URL: ${postUrl}`);

  // verify by checking sent folder for matching subject
  log('COMPOSE', 'verifying send — checking sent folder...');
  await safeGoto(page, urls.sent);
  await humanDelay(1500, 2500);

  const verified = await page.evaluate((subj) => {
    const rows = document.querySelectorAll('table tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const rowSubject = cells[1]?.textContent?.trim() || '';
        if (rowSubject.includes(subj.substring(0, 30))) {
          return true;
        }
      }
    }
    return false;
  }, subject);

  if (verified) {
    log('COMPOSE', 'VERIFIED: message found in sent folder');
  } else {
    log('COMPOSE', 'WARNING: message NOT found in sent folder');
  }

  return { success: verified, postUrl, verified };
}

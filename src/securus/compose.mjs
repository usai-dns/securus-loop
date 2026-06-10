// securus compose and send for cloudflare worker (puppeteer)

import { urls, compose as sel, contacts } from './selectors.mjs';
import { humanDelay, fillField, safeGoto, log } from './helpers.mjs';
import { acceptPendingTerms } from './auth.mjs';

export async function composeAndSend(page, { contactId, subject, body }) {
  log('COMPOSE', 'navigating to compose page...');

  // navigate to my-account first to reset Angular SPA state, then to compose
  await safeGoto(page, urls.myAccount);
  await humanDelay(1000, 1500);
  await safeGoto(page, urls.compose);
  await humanDelay(2000, 3000);

  // wait for Angular to render the compose form
  log('COMPOSE', 'waiting for compose form to render...');
  let formReady = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.waitForSelector(sel.contactDropdown, { visible: true, timeout: 15000 });
      formReady = true;
      break;
    } catch {
      log('COMPOSE', `form not found (attempt ${attempt}/3), retrying...`);
      if (attempt < 3) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay(3000, 5000);
      }
    }
  }
  if (!formReady) {
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
    log('COMPOSE', `form never rendered. Page text: ${pageText}`);
    return { success: false, error: 'Compose form did not render after 3 attempts' };
  }

  // dismiss any leftover modals (accept T&C properly — removing it just makes it reappear)
  const acceptedTerms = await acceptPendingTerms(page);
  const hasOverlay = await page.$('.reveal-overlay');
  if (hasOverlay || acceptedTerms) {
    if (hasOverlay && !acceptedTerms) {
      log('COMPOSE', 'dismissing leftover modal...');
      await page.evaluate(() => {
        const overlay = document.querySelector('.reveal-overlay');
        if (overlay) overlay.remove();
      });
    }
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
  let modalAppeared = false;
  try {
    await page.waitForSelector('.reveal-overlay', { visible: true, timeout: 10000 });
    modalAppeared = true;
  } catch {
    log('COMPOSE', 'no confirmation modal appeared — send may have failed');
  }
  await humanDelay(500, 1000);

  if (!modalAppeared) {
    const pageState = await page.evaluate(() => ({
      url: window.location.hash,
      text: document.body?.innerText?.substring(0, 500) || '',
      hasForm: !!document.querySelector('textarea#message'),
    }));
    log('COMPOSE', `no modal state: url=${pageState.url}, hasForm=${pageState.hasForm}, text=${pageState.text.substring(0, 200)}`);
    return { success: false, error: 'No confirmation modal appeared after clicking Send', pageState };
  }

  // handle stamp usage confirmation modal — click the Confirm button
  // (the T&C modal is also a .reveal-overlay; accept it and retry if it's in the way)
  let confirmed = false;
  for (let pass = 1; pass <= 2 && !confirmed; pass++) {
    const modalButtons = await page.$$('.reveal-overlay button');
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

    if (!confirmed && pass === 1) {
      const acceptedMidSend = await acceptPendingTerms(page);
      if (!acceptedMidSend) break;
      log('COMPOSE', 'T&C modal was blocking — accepted, re-checking for confirm modal...');
      await page.waitForSelector('.reveal-overlay', { visible: true, timeout: 10000 }).catch(() => {});
      await humanDelay(500, 1000);
    }
  }

  if (!confirmed) {
    const modalText = await page.evaluate(() => {
      const overlay = document.querySelector('.reveal-overlay');
      return overlay?.innerText?.substring(0, 500) || 'no overlay text';
    });

    if (/insufficient stamps/i.test(modalText)) {
      log('COMPOSE', 'ERROR: insufficient stamps — purchase required before sending');
      // dismiss via Cancel so the session stays clean
      await page.evaluate(() => {
        const overlay = document.querySelector('.reveal-overlay');
        const cancel = overlay && [...overlay.querySelectorAll('button, a.button')]
          .find(b => /cancel/i.test(b.textContent || ''));
        if (cancel) cancel.click();
      }).catch(() => {});
      return { success: false, error: 'Insufficient stamps — purchase stamps to resume sending', insufficientStamps: true, modalText };
    }

    log('COMPOSE', 'ERROR: could not find Confirm button in modal');
    log('COMPOSE', `modal content: ${modalText}`);
    return { success: false, error: 'Confirm button not found in modal', modalText };
  }

  // wait for page to process send
  await humanDelay(2000, 3000);

  const postUrl = page.url();
  const postSendState = await page.evaluate(() => {
    const overlay = document.querySelector('.reveal-overlay');
    const composeForm = document.querySelector('textarea#message');
    return {
      hasOverlay: !!overlay,
      hasComposeForm: !!composeForm,
      url: window.location.hash,
      bodyText: document.body?.innerText?.substring(0, 500) || '',
    };
  });
  log('COMPOSE', `post-send state: url=${postSendState.url}, overlay=${postSendState.hasOverlay}, form=${postSendState.hasComposeForm}`);

  // if compose form is gone or URL changed from compose, likely success
  const leftCompose = !postSendState.url.includes('/compose') || !postSendState.hasComposeForm;

  // verify by checking FIRST ROW in sent folder (most recent) matches our exact subject
  log('COMPOSE', 'verifying send — checking sent folder...');
  await safeGoto(page, urls.sent);
  await humanDelay(1500, 2500);

  const verification = await page.evaluate((subj) => {
    const rows = document.querySelectorAll('table tr');
    if (rows.length < 2) return { verified: false, reason: 'no rows in sent', topSubject: null };
    const firstDataRow = rows[1];
    const cells = firstDataRow.querySelectorAll('td');
    if (cells.length < 2) return { verified: false, reason: 'no cells in first row', topSubject: null };
    const topSubject = cells[1]?.textContent?.trim() || '';
    const match = topSubject.includes(subj.substring(0, 30));
    return { verified: match, topSubject, totalRows: rows.length - 1 };
  }, subject);

  log('COMPOSE', `sent folder: top="${verification.topSubject}", match=${verification.verified}, rows=${verification.totalRows}`);

  const verified = verification.verified && leftCompose;

  if (verified) {
    log('COMPOSE', 'VERIFIED: message confirmed in sent folder');
  } else if (verification.verified && !leftCompose) {
    log('COMPOSE', 'WARNING: found in sent but compose form still present — possible stale match');
  } else {
    log('COMPOSE', 'FAILED: message NOT found as most recent in sent folder');
  }

  return { success: verified, postUrl, verified, leftCompose, sentVerification: verification };
}

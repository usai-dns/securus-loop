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

  // scrape stamp balance (shown after contact selection)
  const stampBalance = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const m = text.match(/(\d+)\s*Stamps?\s*Available/i);
    return m ? parseInt(m[1], 10) : null;
  }).catch(() => null);
  if (stampBalance !== null) log('COMPOSE', `stamp balance: ${stampBalance}`);

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

  // dismiss chat assistant popup if present
  await page.evaluate(() => {
    const banners = document.querySelectorAll('.modal-title.banner, [class*="popup-close"]');
    for (const b of banners) {
      const close = b.querySelector('.close-button, .popup-close-button') || b;
      if (close && /×/.test(close.textContent || '')) { close.click(); }
    }
  }).catch(() => {});
  await humanDelay(200, 400);

  // click Send
  log('COMPOSE', 'clicking Send...');
  await page.waitForSelector(sel.sendButton, { visible: true, timeout: 10000 });

  // poll for the Send button to become enabled — Angular runs async form
  // validation, and the button can lag behind (or never catch up to) a
  // programmatic fill. Nudge with REAL keystrokes in the body field: Angular's
  // validators key on ng-touched/ng-dirty, which only synthetic DOM events set
  // reliably — a focused space+backspace forces a genuine input cycle.
  let sendDisabled = await page.$eval(sel.sendButton, el => el.disabled);
  for (let attempt = 1; attempt <= 6 && sendDisabled; attempt++) {
    log('COMPOSE', `Send disabled, re-triggering form validation (attempt ${attempt}/6)...`);
    try {
      await page.focus(sel.messageBody);
      await page.keyboard.press('End');
      await page.keyboard.type(' ', { delay: 20 });
      await page.keyboard.press('Backspace');
      await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (el) el.dispatchEvent(new Event('blur', { bubbles: true }));
      }, sel.messageBody);
    } catch { /* field may have re-rendered; fall through to re-check */ }
    await humanDelay(700, 1100);
    sendDisabled = await page.$eval(sel.sendButton, el => el.disabled).catch(() => true);
  }

  if (sendDisabled) {
    log('COMPOSE', 'ERROR: Send button is disabled');
    const diag = await page.evaluate((bodySel, subjSel, dropSel) => {
      const body = document.querySelector(bodySel);
      const subj = document.querySelector(subjSel);
      const drop = document.querySelector(dropSel);
      return {
        text: document.body?.innerText?.substring(0, 500) || '',
        bodyLen: body?.value?.length ?? null,
        subjLen: subj?.value?.length ?? null,
        contactValue: drop?.value ?? null,
      };
    }, sel.messageBody, sel.subjectField, sel.contactDropdown);
    log('COMPOSE', `page text: ${diag.text}`);
    log('COMPOSE', `field state: body=${diag.bodyLen} subj=${diag.subjLen} contact=${diag.contactValue}`);
    return { success: false, error: 'Send button disabled', diag };
  }

  await humanDelay(300, 500);
  // use evaluate to click the specific send button (avoids chat popup intercepting)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button[type="submit"]')]
      .find(b => /^send$/i.test((b.textContent || '').trim()));
    if (btn) btn.click();
  });
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
      buttons: [...document.querySelectorAll('button, input[type="submit"]')].map(b => ({
        text: (b.textContent || b.value || '').trim().substring(0, 40),
        type: b.type || '',
        disabled: b.disabled,
        visible: !!(b.offsetWidth || b.offsetHeight),
      })).filter(b => b.text),
      overlays: [...document.querySelectorAll('.reveal-overlay, .reveal, [class*="modal"]')].map(m => ({
        cls: (m.className || '').substring(0, 60),
        visible: !!(m.offsetWidth || m.offsetHeight),
        text: (m.innerText || '').substring(0, 200),
      })),
      charCount: document.querySelector('.char-count, [class*="char"], [class*="count"]')?.textContent || null,
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

  // verify by scanning the TOP ROWS of the sent folder for our subject.
  // A verification miss when the message actually sent is worse than a false
  // failure looks: the part gets marked failed, the inbound stays unresponded,
  // and a retry would double-send. So scan 5 rows, and reload once on a miss.
  log('COMPOSE', 'verifying send — checking sent folder...');
  let verification = { verified: false, reason: 'not checked', topSubject: null };
  for (let attempt = 1; attempt <= 2; attempt++) {
    await safeGoto(page, urls.sent);
    await humanDelay(1500, 2500);

    verification = await page.evaluate((subj) => {
      const rows = document.querySelectorAll('table tr');
      if (rows.length < 2) return { verified: false, reason: 'no rows in sent', topSubject: null };
      const topSubjects = [];
      for (let i = 1; i < Math.min(rows.length, 6); i++) {
        const cells = rows[i].querySelectorAll('td');
        if (cells.length >= 2) topSubjects.push(cells[i === 0 ? 1 : 1]?.textContent?.trim() || '');
      }
      const needle = subj.substring(0, 30);
      const matchIndex = topSubjects.findIndex(s => s.includes(needle));
      return {
        verified: matchIndex !== -1,
        matchRow: matchIndex,
        topSubject: topSubjects[0] || null,
        topSubjects,
        totalRows: rows.length - 1,
      };
    }, subject);

    if (verification.verified) break;
    log('COMPOSE', `verification miss (attempt ${attempt}/2): top="${verification.topSubject}" — ${attempt === 1 ? 'reloading sent folder...' : 'giving up'}`);
  }

  log('COMPOSE', `sent folder: match=${verification.verified} (row ${verification.matchRow}), top="${verification.topSubject}", rows=${verification.totalRows}`);

  const verified = verification.verified && leftCompose;

  if (verified) {
    log('COMPOSE', 'VERIFIED: message confirmed in sent folder');
  } else if (verification.verified && !leftCompose) {
    log('COMPOSE', 'WARNING: found in sent but compose form still present — possible stale match');
  } else {
    log('COMPOSE', 'FAILED: message NOT found in top of sent folder');
  }

  return { success: verified, postUrl, verified, leftCompose, sentVerification: verification, stampBalance };
}

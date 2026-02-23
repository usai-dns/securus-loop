require('dotenv').config();
const { launchBrowser, screenshot, humanDelay } = require('./utils/browser');
const selectors = require('./utils/selectors');

const LOGIN_URL = process.env.SECURUS_LOGIN_URL;
const EMAIL = process.env.SECURUS_LOGIN_EMAIL;
const PASSWORD = process.env.SECURUS_LOGIN_PASS;

const SUBJECT = process.argv[2] || 'test message';
const BODY = process.argv[3] || 'this is a test message';

async function sendAuto() {
  console.log('=== SECURUS AUTO SEND ===\n');
  console.log(`to:      SAMUEL MULLIKIN`);
  console.log(`subject: ${SUBJECT}`);
  console.log(`body:    ${BODY}\n`);

  const { browser, page } = await launchBrowser(false);

  try {
    // === LOGIN ===
    console.log('[1] logging in...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await humanDelay(800, 1500);
    await page.fill(selectors.login.emailField, EMAIL);
    await humanDelay(200, 400);
    await page.fill(selectors.login.passwordField, PASSWORD);
    await humanDelay(200, 400);
    await page.click(selectors.login.submitButton);
    await page.waitForURL('**/my-account**', { timeout: 15000 }).catch(() => {});
    await humanDelay(1500, 2500);
    console.log('  logged in:', page.url());

    // === NAVIGATE TO COMPOSE ===
    console.log('\n[2] opening compose...');
    await page.goto(selectors.urls.compose, { waitUntil: 'networkidle', timeout: 15000 });
    await humanDelay(1500, 2500);

    // dismiss any leftover modals/overlays
    const overlay = await page.$('.reveal-overlay');
    if (overlay) {
      console.log('  dismissing leftover modal...');
      const closeBtn = await page.$('.reveal-overlay button.close-button, .reveal-overlay .close-btn, .reveal-overlay button:has-text("Cancel"), .reveal-overlay a:has-text("Cancel"), .reveal-overlay a:has-text("CANCEL")');
      if (closeBtn) {
        await closeBtn.click();
      } else {
        // click outside the modal to dismiss
        await page.evaluate(() => {
          document.querySelector('.reveal-overlay')?.remove();
        });
      }
      await humanDelay(500, 1000);
      // reload compose page clean
      await page.goto(selectors.urls.compose, { waitUntil: 'networkidle', timeout: 15000 });
      await humanDelay(1500, 2500);
    }

    // select Samuel
    await page.selectOption(selectors.compose.contactDropdown, selectors.contacts.samuelMullikin);
    await humanDelay(800, 1500);
    console.log('  recipient: SAMUEL MULLIKIN');

    // fill subject
    await page.fill(selectors.compose.subjectField, SUBJECT);
    await humanDelay(300, 600);

    // fill message body
    await page.fill(selectors.compose.messageBody, BODY);
    await humanDelay(300, 600);

    await screenshot(page, 'auto-01-composed');

    // verify form content
    const actualSubject = await page.$eval(selectors.compose.subjectField, e => e.value);
    const actualBody = await page.$eval(selectors.compose.messageBody, e => e.value);
    console.log(`  subject: "${actualSubject}"`);
    console.log(`  body:    "${actualBody}"`);

    // === CLICK SEND ===
    console.log('\n[3] clicking send...');
    const sendBtn = await page.$('button[type="submit"]:has-text("Send")');
    if (!sendBtn) {
      console.log('  ERROR: Send button not found');
      return;
    }

    const disabled = await sendBtn.evaluate(e => e.disabled);
    if (disabled) {
      console.log('  ERROR: Send button disabled');
      return;
    }

    await humanDelay(500, 1000);
    await sendBtn.click();
    console.log('  send clicked, waiting for confirmation modal...');

    // === HANDLE STAMP USAGE CONFIRMATION MODAL ===
    await humanDelay(1000, 2000);
    await screenshot(page, 'auto-02-confirmation-modal');

    // find the CONFIRM button in the modal
    const confirmBtn = await page.$('button:has-text("Confirm"), button:has-text("CONFIRM"), a:has-text("Confirm"), a:has-text("CONFIRM")');
    if (confirmBtn) {
      const btnText = await confirmBtn.evaluate(e => e.textContent?.trim());
      console.log(`  found confirmation button: "${btnText}"`);
      await humanDelay(500, 1000);
      await confirmBtn.click();
      console.log('  confirmed! waiting for send to complete...');
    } else {
      console.log('  no confirmation modal found, checking for other buttons...');
      const allBtns = await page.$$eval('button, a[role="button"]', els => els.map(e => ({
        text: e.textContent?.trim().substring(0, 40),
        cls: e.className?.substring(0, 60),
        visible: e.offsetParent !== null,
      })).filter(b => b.visible));
      console.log('  visible buttons:', JSON.stringify(allBtns));
    }

    // wait for navigation or page update
    await page.waitForURL(url => !url.toString().includes('/compose'), { timeout: 15000 }).catch(() => {
      console.log('  (still on compose page)');
    });
    await humanDelay(3000, 5000);

    const postUrl = page.url();
    console.log(`\n  post-send URL: ${postUrl}`);
    await screenshot(page, 'auto-03-post-send');

    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500));
    console.log(`  page text: ${pageText?.substring(0, 300)}`);

    // === CHECK SENT FOLDER ===
    console.log('\n[4] verifying in sent folder...');
    await page.goto('https://securustech.online/#/products/emessage/sent', { waitUntil: 'networkidle', timeout: 15000 });
    await humanDelay(2000, 3000);
    await screenshot(page, 'auto-04-sent-folder');

    // check first row of sent table
    const firstSentRow = await page.$('table tr:nth-child(2)');
    if (firstSentRow) {
      const cells = await firstSentRow.$$('td');
      const to = cells[0] ? await cells[0].evaluate(e => e.textContent?.trim()) : '';
      const subject = cells[1] ? await cells[1].evaluate(e => e.textContent?.trim()) : '';
      const date = cells[2] ? await cells[2].evaluate(e => e.textContent?.trim()) : '';
      console.log(`  most recent sent: to="${to}" subject="${subject}" date="${date}"`);

      if (subject.toLowerCase().includes('sam cycle 3')) {
        console.log('\n  CONFIRMED: "sam cycle 3" appears in sent folder!');
      } else {
        console.log('\n  WARNING: "sam cycle 3" not found as most recent sent message.');
      }
    }

    console.log('\n=== DONE ===');
    console.log(`time: ${new Date().toISOString()}`);

    console.log('\n  browser staying open 15s...');
    await new Promise(resolve => setTimeout(resolve, 15000));

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    try { await screenshot(page, 'auto-error'); } catch (_) {}
  } finally {
    await browser.close();
    console.log('\nbrowser closed.');
  }
}

sendAuto();

require('dotenv').config();
const { launchBrowser, screenshot, humanDelay } = require('./utils/browser');

const LOGIN_URL = process.env.SECURUS_LOGIN_URL;
const EMAIL = process.env.SECURUS_LOGIN_EMAIL;
const PASSWORD = process.env.SECURUS_LOGIN_PASS;

async function verifyCompose2() {
  console.log('=== SECURUS COMPOSE VERIFICATION (FOCUSED) ===\n');

  const { browser, page } = await launchBrowser(false);

  try {
    // === LOGIN ===
    console.log('[1] logging in...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await humanDelay(1000, 2000);
    await page.fill('input[type="email"]', EMAIL);
    await humanDelay(300, 600);
    await page.fill('input[type="password"]', PASSWORD);
    await humanDelay(300, 600);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/my-account**', { timeout: 15000 }).catch(() => {});
    await humanDelay(2000, 3000);

    // === GO TO COMPOSE ===
    console.log('\n[2] navigating to compose...');
    await page.goto('https://securustech.online/#/products/emessage/compose', { waitUntil: 'networkidle', timeout: 15000 });
    await humanDelay(2000, 3000);
    console.log('  at:', page.url());
    await screenshot(page, 'compose2-01-page');

    // === SELECT SAMUEL MULLIKIN ===
    console.log('\n[3] selecting Samuel Mullikin...');
    const contactDropdown = await page.$('select#select-inmate');
    if (!contactDropdown) {
      console.log('  ERROR: contact dropdown not found');
      // try name-based
      const byName = await page.$('select[name="selectInmate"]');
      if (byName) {
        console.log('  found by name attribute');
        await byName.selectOption('65651103');
      }
    } else {
      await contactDropdown.selectOption('65651103'); // SAMUEL MULLIKIN
    }
    await humanDelay(1000, 2000);
    console.log('  selected Samuel');
    await screenshot(page, 'compose2-02-contact-selected');

    // check if the page changed after contact selection
    const pageTextAfterSelect = await page.evaluate(() => document.body?.innerText?.substring(0, 2000));
    console.log(`\n  page after contact selection:\n  ---\n${pageTextAfterSelect?.substring(0, 800)}\n  ---`);

    // === FILL SUBJECT ===
    console.log('\n[4] filling subject...');
    const subjectField = await page.$('input[name="subject"]');
    if (subjectField) {
      const maxLen = await subjectField.evaluate(e => e.maxLength);
      console.log(`  subject maxLength: ${maxLen}`);
      await subjectField.fill('Test subject - verification only');
      await humanDelay(500, 1000);
    } else {
      console.log('  no subject field found');
    }

    // === FILL MESSAGE BODY ===
    console.log('\n[5] filling message body...');
    const textarea = await page.$('textarea#message, textarea[name="message"]');
    if (textarea) {
      const maxLen = await textarea.evaluate(e => e.maxLength);
      const rows = await textarea.evaluate(e => e.rows);
      console.log(`  textarea: maxLength=${maxLen} rows=${rows}`);
      await textarea.fill('This is a test message for verification purposes only. DO NOT SEND.');
      await humanDelay(500, 1000);

      // check for character counter
      const allText = await page.evaluate(() => document.body?.innerText);
      const charMatch = allText?.match(/(\d+)\s*\/\s*(\d+)/);
      if (charMatch) {
        console.log(`  character counter detected: ${charMatch[0]}`);
      }

      // look for any counter/limit elements near the textarea
      const nearbyElements = await page.$$eval('textarea#message ~ *, textarea[name="message"] ~ *', els => els.map(e => ({
        tag: e.tagName,
        text: e.textContent?.trim().substring(0, 100),
        cls: e.className?.substring(0, 80),
      })));
      console.log('  elements after textarea:', JSON.stringify(nearbyElements.slice(0, 5)));
    }

    await screenshot(page, 'compose2-03-form-filled');

    // === CHECK ATTACHMENTS SECTION ===
    console.log('\n[6] checking attachments...');
    const attachEls = await page.$$('[class*="attach"], input[type="file"], [class*="upload"]');
    for (const el of attachEls) {
      const tag = await el.evaluate(e => e.tagName);
      const text = await el.evaluate(e => e.textContent?.trim().substring(0, 60));
      const cls = await el.evaluate(e => e.className);
      console.log(`  ${tag}: "${text}" class="${cls}"`);
    }

    // === CHECK SEND BUTTON STATE ===
    console.log('\n[7] checking send button state...');
    const sendBtn = await page.$('button[type="submit"]:has-text("Send")');
    if (sendBtn) {
      const disabled = await sendBtn.evaluate(e => e.disabled);
      const cls = await sendBtn.evaluate(e => e.className);
      console.log(`  Send button: disabled=${disabled} class="${cls}"`);
    }

    // also check cancel button
    const cancelBtn = await page.$('a:has-text("Cancel"), button:has-text("Cancel"), a:has-text("CANCEL")');
    if (cancelBtn) {
      const text = await cancelBtn.evaluate(e => e.textContent?.trim());
      const href = await cancelBtn.evaluate(e => e.href || '');
      console.log(`  Cancel: "${text}" href="${href}"`);
    }

    await screenshot(page, 'compose2-04-ready-to-send');

    // === DO NOT SEND - CLEAR THE FORM ===
    console.log('\n[8] clearing form (NOT sending)...');
    if (textarea) await textarea.fill('');
    if (subjectField) await subjectField.fill('');

    // === CHECK STAMP COST ===
    console.log('\n[9] checking stamp information...');
    const stampText = await page.evaluate(() => {
      const body = document.body?.innerText;
      const lines = body?.split('\n').filter(l => l.toLowerCase().includes('stamp'));
      return lines;
    });
    console.log('  stamp-related text:', stampText);

    // === FULL COMPOSE FLOW SUMMARY ===
    console.log('\n=== COMPOSE FLOW SUMMARY ===');
    console.log('URL:            #/products/emessage/compose');
    console.log('Contact select: select#select-inmate (name="selectInmate")');
    console.log('  Sam value:    65651103');
    console.log('  Ricardo val:  67887839');
    console.log('Subject:        input[name="subject"]');
    console.log('Message:        textarea#message (name="message")');
    console.log('Send:           button[type="submit"]:has-text("Send")');
    console.log('NOTE: Send button starts disabled, enables after form filled');
    console.log('============================\n');

    // keep open
    console.log('  browser staying open 30s...');
    await new Promise(resolve => setTimeout(resolve, 30000));

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    await screenshot(page, 'compose2-error');
  } finally {
    await browser.close();
    console.log('\nbrowser closed. done.');
  }
}

verifyCompose2();

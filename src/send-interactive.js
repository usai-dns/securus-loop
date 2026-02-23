require('dotenv').config();
const { launchBrowser, screenshot, humanDelay } = require('./utils/browser');
const selectors = require('./utils/selectors');
const readline = require('readline');

const LOGIN_URL = process.env.SECURUS_LOGIN_URL;
const EMAIL = process.env.SECURUS_LOGIN_EMAIL;
const PASSWORD = process.env.SECURUS_LOGIN_PASS;

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function sendInteractive() {
  console.log('=== SECURUS INTERACTIVE SEND ===\n');

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
    console.log('  logged in.');

    // === NAVIGATE TO COMPOSE ===
    console.log('\n[2] opening compose...');
    await page.goto(selectors.urls.compose, { waitUntil: 'networkidle', timeout: 15000 });
    await humanDelay(1500, 2500);

    // select Samuel
    await page.selectOption(selectors.compose.contactDropdown, selectors.contacts.samuelMullikin);
    await humanDelay(800, 1500);
    console.log('  Samuel Mullikin selected as recipient.');
    await screenshot(page, 'send-01-compose-ready');

    // === WAIT FOR USER TO COMPOSE ===
    console.log('\n============================================');
    console.log('  BROWSER IS OPEN — write your message now.');
    console.log('  Fill in the Subject and Message fields.');
    console.log('============================================\n');

    let ready = '';
    while (ready !== 'send') {
      ready = await prompt('type "send" when ready, or "cancel" to abort: ');
      if (ready === 'cancel') {
        console.log('\naborted. no message sent.');
        await screenshot(page, 'send-cancelled');
        return;
      }
      if (ready !== 'send') {
        console.log('  (type "send" or "cancel")');
      }
    }

    // === CAPTURE WHAT USER TYPED ===
    await screenshot(page, 'send-02-pre-send');

    const subject = await page.$eval(selectors.compose.subjectField, e => e.value).catch(() => '');
    const body = await page.$eval(selectors.compose.messageBody, e => e.value).catch(() => '');

    console.log(`\n  subject: "${subject}"`);
    console.log(`  body (${body.length} chars): "${body.substring(0, 200)}${body.length > 200 ? '...' : ''}"`);

    if (!subject && !body) {
      console.log('\n  ERROR: both subject and body are empty. aborting.');
      return;
    }

    // === SEND ===
    console.log('\n[3] clicking send...');

    // use specific text match to avoid hitting the chatbot "Let's Chat" submit button
    let sendBtn = await page.$('button[type="submit"]:has-text("Send")');
    if (!sendBtn) {
      // fallback: find all submit buttons and pick the one with "Send" text
      const allSubmits = await page.$$('button[type="submit"]');
      for (const btn of allSubmits) {
        const text = await btn.evaluate(e => e.textContent?.trim());
        if (text === 'Send') {
          sendBtn = btn;
          break;
        }
      }
    }

    if (!sendBtn) {
      console.log('  ERROR: could not find Send button');
      await screenshot(page, 'send-03-no-button');
      return;
    }

    const disabled = await sendBtn.evaluate(e => e.disabled);
    const btnText = await sendBtn.evaluate(e => e.textContent?.trim());
    console.log(`  found button: "${btnText}" disabled=${disabled}`);

    if (disabled) {
      console.log('  ERROR: send button is disabled. check the form.');
      await screenshot(page, 'send-03-disabled');
      return;
    }

    // listen for dialogs (confirmation popups)
    page.on('dialog', async dialog => {
      console.log(`  dialog appeared: "${dialog.message()}"`);
      await dialog.accept();
      console.log('  dialog accepted.');
    });

    await sendBtn.click();
    console.log('  send clicked, waiting for response...');

    // wait for navigation or content change
    await page.waitForURL(url => !url.toString().includes('/compose'), { timeout: 15000 }).catch(() => {
      console.log('  no URL navigation detected (may still be on compose)');
    });
    await humanDelay(2000, 3000);

    const postUrl = page.url();
    console.log(`  post-send URL: ${postUrl}`);
    await screenshot(page, 'send-03-post-send');

    // capture confirmation state
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 1000));
    console.log(`  post-send page preview:\n  ---\n${pageText?.substring(0, 400)}\n  ---`);

    // check for success indicators
    if (postUrl.includes('sent') || postUrl.includes('inbox')) {
      console.log('\n  MESSAGE SENT SUCCESSFULLY.');
    } else if (pageText?.includes('sent') || pageText?.includes('success')) {
      console.log('\n  MESSAGE APPEARS SENT (confirmation text detected).');
    } else {
      console.log('\n  check browser to confirm send status.');
      // take another screenshot after more time
      await humanDelay(2000, 3000);
      await screenshot(page, 'send-04-delayed-check');
    }

    // log the sent message for reference
    console.log('\n=== SENT MESSAGE LOG ===');
    console.log(`to:      SAMUEL MULLIKIN (${selectors.contacts.samuelMullikin})`);
    console.log(`subject: ${subject}`);
    console.log(`body:    ${body}`);
    console.log(`time:    ${new Date().toISOString()}`);
    console.log('========================\n');

    // keep open to inspect
    console.log('  browser staying open 15s...');
    await new Promise(resolve => setTimeout(resolve, 15000));

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    await screenshot(page, 'send-error');
  } finally {
    await browser.close();
    console.log('\nbrowser closed. done.');
  }
}

sendInteractive();

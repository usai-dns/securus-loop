require('dotenv').config();
const { launchBrowser, screenshot, humanDelay } = require('./utils/browser');
const selectors = require('./utils/selectors');

const LOGIN_URL = process.env.SECURUS_LOGIN_URL;
const EMAIL = process.env.SECURUS_LOGIN_EMAIL;
const PASSWORD = process.env.SECURUS_LOGIN_PASS;

// set to true to actually send a message (costs 1 stamp)
const ACTUALLY_SEND = process.argv.includes('--send');

async function fullLoop() {
  const startTime = Date.now();
  console.log('=== SECURUS FULL LOOP VERIFICATION ===');
  console.log(`mode: ${ACTUALLY_SEND ? 'LIVE SEND' : 'DRY RUN (pass --send to actually send)'}\n`);

  const { browser, page } = await launchBrowser(false);

  try {
    // === STEP 1: LOGIN ===
    const t1 = Date.now();
    console.log('[1] LOGIN...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await humanDelay(800, 1500);
    await page.fill(selectors.login.emailField, EMAIL);
    await humanDelay(200, 400);
    await page.fill(selectors.login.passwordField, PASSWORD);
    await humanDelay(200, 400);
    await page.click(selectors.login.submitButton);
    await page.waitForURL('**/my-account**', { timeout: 15000 }).catch(() => {});
    await humanDelay(1500, 2500);
    console.log(`  done (${Date.now() - t1}ms) → ${page.url()}`);
    await screenshot(page, 'loop-01-logged-in');

    // === STEP 2: NAVIGATE TO INBOX ===
    const t2 = Date.now();
    console.log('\n[2] INBOX NAVIGATION...');
    await page.click(selectors.postLogin.launchInbox);
    await page.waitForURL('**/emessage/inbox**', { timeout: 15000 }).catch(() => {});
    await humanDelay(1500, 2500);
    console.log(`  done (${Date.now() - t2}ms) → ${page.url()}`);
    await screenshot(page, 'loop-02-inbox');

    // === STEP 3: READ INBOX — ENUMERATE MESSAGES ===
    const t3 = Date.now();
    console.log('\n[3] READ INBOX...');

    const rows = await page.$$('table tr:nth-child(n+2)');
    console.log(`  message rows: ${rows.length}`);

    const messages = [];
    for (let i = 0; i < rows.length; i++) {
      const cells = await rows[i].$$('td');
      if (cells.length >= 3) {
        const sender = await cells[0].evaluate(e => e.textContent?.trim());
        const subject = await cells[1].evaluate(e => e.querySelector('.hide-for-small-only')?.textContent?.trim() || e.textContent?.trim());
        const date = await cells[2].evaluate(e => e.textContent?.trim());
        messages.push({ index: i, sender, subject, date });
        console.log(`  [${i}] ${sender} | ${subject?.substring(0, 50)} | ${date}`);
      }
    }

    // find newest message from Samuel
    const samMessage = messages.find(m => m.sender?.includes('SAMUEL'));
    if (!samMessage) {
      console.log('  no message from Samuel found');
      return;
    }
    console.log(`\n  newest from Sam: [${samMessage.index}] "${samMessage.subject?.substring(0, 60)}" (${samMessage.date})`);
    console.log(`  done (${Date.now() - t3}ms)`);

    // === STEP 4: OPEN AND READ MESSAGE ===
    const t4 = Date.now();
    console.log('\n[4] READ MESSAGE...');

    // click subject cell of sam's message
    const targetRow = rows[samMessage.index];
    const subjectCell = await targetRow.$('td:nth-child(2)');
    await humanDelay(500, 1000);
    await subjectCell.click();
    await humanDelay(2000, 3000);

    const msgUrl = page.url();
    const messageIdMatch = msgUrl.match(/messageId=(\d+)/);
    const messageId = messageIdMatch ? messageIdMatch[1] : 'unknown';
    console.log(`  message URL: ${msgUrl}`);
    console.log(`  message ID: ${messageId}`);

    // extract message content
    const messageBody = await page.$eval(selectors.messageView.messageBody, e => e.textContent?.trim()).catch(() => null);
    const senderName = await page.$eval(selectors.messageView.senderName, e => e.textContent?.trim()).catch(() => null);

    console.log(`  from: ${senderName}`);
    console.log(`  body (first 300 chars): ${messageBody?.substring(0, 300)}`);
    console.log(`  body length: ${messageBody?.length} chars`);
    console.log(`  done (${Date.now() - t4}ms)`);
    await screenshot(page, 'loop-03-message-read');

    // === STEP 5: NAVIGATE TO COMPOSE ===
    const t5 = Date.now();
    console.log('\n[5] COMPOSE REPLY...');

    await page.goto(selectors.urls.compose, { waitUntil: 'networkidle', timeout: 15000 });
    await humanDelay(1500, 2500);
    console.log(`  at compose: ${page.url()}`);

    // select Samuel as recipient
    await page.selectOption(selectors.compose.contactDropdown, selectors.contacts.samuelMullikin);
    await humanDelay(800, 1500);
    console.log('  selected Samuel Mullikin');

    // fill subject
    const replySubject = `RE: ${samMessage.subject?.substring(0, 60) || 'your message'}`;
    await page.fill(selectors.compose.subjectField, replySubject);
    await humanDelay(300, 600);
    console.log(`  subject: ${replySubject}`);

    // fill message body
    const replyBody = `Hey Sam, this is a test of the automated messaging system. Just verifying the full loop works end to end. Talk soon.`;
    await page.fill(selectors.compose.messageBody, replyBody);
    await humanDelay(300, 600);
    console.log(`  body: ${replyBody}`);

    await screenshot(page, 'loop-04-composed');
    console.log(`  done (${Date.now() - t5}ms)`);

    // === STEP 6: SEND (or not) ===
    const t6 = Date.now();
    if (ACTUALLY_SEND) {
      console.log('\n[6] SENDING MESSAGE...');
      const sendBtn = await page.$(selectors.compose.sendButton);
      const disabled = await sendBtn.evaluate(e => e.disabled);
      if (disabled) {
        console.log('  ERROR: send button is disabled');
        await screenshot(page, 'loop-05-send-disabled');
      } else {
        await humanDelay(500, 1000);
        await sendBtn.click();
        await humanDelay(3000, 5000);
        console.log(`  post-send URL: ${page.url()}`);
        await screenshot(page, 'loop-05-sent');

        // check for confirmation
        const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500));
        console.log(`  post-send page: ${pageText?.substring(0, 200)}`);
      }
      console.log(`  done (${Date.now() - t6}ms)`);
    } else {
      console.log('\n[6] SKIPPING SEND (dry run)');
      console.log('  run with --send to actually send');
    }

    // === STEP 7: SIGN OUT ===
    const t7 = Date.now();
    console.log('\n[7] SIGN OUT...');
    await page.goto('https://securustech.online/#/login', { waitUntil: 'networkidle', timeout: 15000 });
    await humanDelay(1000, 2000);
    console.log(`  signed out: ${page.url()}`);
    await screenshot(page, 'loop-06-signed-out');
    console.log(`  done (${Date.now() - t7}ms)`);

    // === TIMING SUMMARY ===
    const totalTime = Date.now() - startTime;
    console.log('\n=== TIMING SUMMARY ===');
    console.log(`total elapsed:  ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`);
    console.log(`cf timeout:     60,000ms`);
    console.log(`within budget:  ${totalTime < 60000 ? 'YES' : 'NO — need keep_alive'}`);
    console.log(`message ID:     ${messageId}`);
    console.log(`site ID:        ${selectors.siteId}`);
    console.log(`stamps remain:  check manually`);
    console.log('======================\n');

    // keep open briefly
    console.log('  browser staying open 15s...');
    await new Promise(resolve => setTimeout(resolve, 15000));

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    await screenshot(page, 'loop-error');
  } finally {
    await browser.close();
    console.log('\nbrowser closed. done.');
  }
}

fullLoop();

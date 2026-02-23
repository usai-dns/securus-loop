// securus-agent cloudflare worker — main entry point
import puppeteer from '@cloudflare/puppeteer';
import { loginToSecurus, logout } from './securus/auth.mjs';
import { navigateToInbox, enumerateMessages, findSamMessages } from './securus/inbox.mjs';
import { openMessage, extractMessage, navigateBackToInbox } from './securus/read.mjs';
import { composeAndSend } from './securus/compose.mjs';
import { messageExists, saveMessage, markResponded, getRecentMessages } from './db/messages.mjs';
import { getState, setState, incrementCounter } from './db/state.mjs';
import { notifyDennis } from './notify/sms.mjs';
import { generateResponse, shouldEscalate } from './ai/responder.mjs';

// === TEST MESSAGE ===
const TEST_SUBJECT = 'story elements are in the cloud mk1';
const TEST_BODY = 'SAM! once this message arrives we are officially writing stories in the cloud. cant wait to bring this story to life brother!';

// === SEND TEST MESSAGE ===
async function sendTestMessage(env) {
  console.log('=== SEND TEST MESSAGE ===');
  const browser = await puppeteer.launch(env.BROWSER);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // login
    const loggedIn = await loginToSecurus(page, env);
    if (!loggedIn) {
      return { success: false, error: 'Login failed' };
    }

    // compose and send test message
    const result = await composeAndSend(page, {
      contactId: env.SAM_CONTACT_ID,
      subject: TEST_SUBJECT,
      body: TEST_BODY,
    });

    // log to D1
    if (result.success) {
      await saveMessage(env.DB, {
        direction: 'outbound',
        sender: 'DENNIS HANSON',
        subject: TEST_SUBJECT,
        body: TEST_BODY,
        timestamp: new Date().toISOString(),
      });
      await incrementCounter(env.DB, 'total_messages_sent');
      console.log('test message saved to D1');
    }

    // sign out
    await logout(page);

    return result;
  } catch (err) {
    console.error('test message error:', err.message, err.stack);
    return { success: false, error: err.message, stack: err.stack };
  } finally {
    await browser.close();
  }
}

// === FULL CHECK LOOP (for cron) ===
async function checkAndRespond(env) {
  console.log('=== CHECK AND RESPOND ===');
  const browser = await puppeteer.launch(env.BROWSER);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // login
    const loggedIn = await loginToSecurus(page, env);
    if (!loggedIn) {
      await setState(env.DB, 'last_error', `login failed at ${new Date().toISOString()}`);
      await notifyDennis(env, 'securus-agent: login failed');
      return { success: false, error: 'Login failed' };
    }

    // navigate to inbox
    await navigateToInbox(page);

    // enumerate messages
    const allMessages = await enumerateMessages(page);
    const samMessages = findSamMessages(allMessages);
    console.log(`found ${samMessages.length} messages from Sam`);

    // process new messages from Sam
    let newMessageCount = 0;
    for (const msg of samMessages) {
      // open the message to get its ID
      const messageId = await openMessage(page, msg.index);

      if (!messageId) {
        console.log(`skipping message at index ${msg.index} — no messageId`);
        await navigateBackToInbox(page);
        continue;
      }

      // check if already processed
      const exists = await messageExists(env.DB, messageId);
      if (exists) {
        console.log(`message ${messageId} already processed, skipping`);
        await navigateBackToInbox(page);
        continue;
      }

      // extract message content
      const { sender, body } = await extractMessage(page);
      console.log(`new message from ${sender}: "${body?.substring(0, 100)}..."`);

      // save inbound message
      const inboundId = await saveMessage(env.DB, {
        externalId: messageId,
        direction: 'inbound',
        sender: sender || 'SAMUEL MULLIKIN',
        subject: msg.subject,
        body: body || '',
        timestamp: new Date().toISOString(),
      });

      newMessageCount++;

      // notify dennis via SMS
      await notifyDennis(env, `securus: new message from ${sender}\n\n${body?.substring(0, 160)}`);

      // check for escalation
      if (shouldEscalate(body)) {
        console.log('ESCALATION: message flagged for manual review');
        await notifyDennis(env, `⚠ ESCALATION: message from ${sender} needs manual review:\n\n${body?.substring(0, 300)}`);
        await navigateBackToInbox(page);
        continue;
      }

      // generate AI response
      const history = await getRecentMessages(env.DB, 20);
      const aiResponse = await generateResponse(env, body, history, []);

      if (aiResponse) {
        // navigate back to compose and send response
        await navigateBackToInbox(page);

        const replySubject = `RE: ${msg.subject?.substring(0, 80) || 'your message'}`;
        const sendResult = await composeAndSend(page, {
          contactId: env.SAM_CONTACT_ID,
          subject: replySubject,
          body: aiResponse,
        });

        if (sendResult.success) {
          const outboundId = await saveMessage(env.DB, {
            direction: 'outbound',
            sender: 'DENNIS HANSON',
            subject: replySubject,
            body: aiResponse,
            timestamp: new Date().toISOString(),
          });
          await markResponded(env.DB, inboundId, outboundId);
          await incrementCounter(env.DB, 'total_messages_sent');
          console.log(`reply sent for message ${messageId}`);
        } else {
          console.log(`failed to send reply: ${sendResult.error}`);
          await notifyDennis(env, `securus-agent: failed to send reply to ${sender}`);
        }
      } else {
        console.log('no AI response generated');
        await navigateBackToInbox(page);
      }
    }

    // update state
    await setState(env.DB, 'last_check', new Date().toISOString());
    await incrementCounter(env.DB, 'total_checks');

    // sign out
    await logout(page);

    console.log(`=== done: ${newMessageCount} new messages processed ===`);
    return { success: true, newMessages: newMessageCount };

  } catch (err) {
    console.error('check loop error:', err.message, err.stack);
    await setState(env.DB, 'last_error', `${err.message} at ${new Date().toISOString()}`);
    await notifyDennis(env, `securus-agent error: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// === WORKER EXPORT ===
export default {
  // HTTP handler — for manual triggers and dashboard
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/test') {
      const result = await sendTestMessage(env);
      return Response.json(result);
    }

    if (url.pathname === '/check') {
      const result = await checkAndRespond(env);
      return Response.json(result);
    }

    if (url.pathname === '/status') {
      const lastCheck = await getState(env.DB, 'last_check');
      const totalChecks = await getState(env.DB, 'total_checks');
      const totalSent = await getState(env.DB, 'total_messages_sent');
      const lastError = await getState(env.DB, 'last_error');
      const recentMessages = await getRecentMessages(env.DB, 10);

      return Response.json({
        lastCheck,
        totalChecks,
        totalMessagesSent: totalSent,
        lastError,
        recentMessages,
      });
    }

    return new Response(JSON.stringify({
      service: 'securus-agent',
      routes: ['/test', '/check', '/status'],
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // cron handler — scheduled execution
  async scheduled(event, env, ctx) {
    // random delay 0-15 minutes to vary login timing
    const jitterMs = Math.floor(Math.random() * 15 * 60 * 1000);
    console.log(`cron triggered, jitter: ${jitterMs}ms (${(jitterMs / 60000).toFixed(1)} min)`);
    await new Promise(resolve => setTimeout(resolve, jitterMs));

    ctx.waitUntil(checkAndRespond(env));
  },
};

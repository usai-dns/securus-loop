// securus-agent cloudflare worker — main entry point
import puppeteer from '@cloudflare/puppeteer';
import { loginToSecurus, logout } from './securus/auth.mjs';
import { navigateToInbox, enumerateMessages, findSamMessages } from './securus/inbox.mjs';
import { openMessage, extractMessage, navigateBackToInbox } from './securus/read.mjs';
import { composeAndSend } from './securus/compose.mjs';
import { messageExists, getMessageByExternalId, saveMessage, markResponded, getRecentMessages, getUnrespondedInbound } from './db/messages.mjs';
import { getState, setState, incrementCounter } from './db/state.mjs';
import { notifyDennis } from './notify/sms.mjs';
import { generateResponse, splitForSend, shouldEscalate } from './ai/responder.mjs';

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

    // phase 1: scan inbox for brand-new messages not yet in D1
    let newMessageCount = 0;
    for (const msg of samMessages) {
      const messageId = await openMessage(page, msg.index);

      if (!messageId) {
        console.log(`skipping message at index ${msg.index} — no messageId`);
        await navigateBackToInbox(page);
        continue;
      }

      // only skip if already responded — NOT just if it exists in D1
      const existing = await getMessageByExternalId(env.DB, messageId);
      if (existing && existing.responded_at) {
        console.log(`message ${messageId} already responded, skipping`);
        await navigateBackToInbox(page);
        continue;
      }

      if (existing && !existing.responded_at) {
        // saved from a previous run but response failed — will handle in phase 2
        console.log(`message ${messageId} saved but not responded, will retry in phase 2`);
        await navigateBackToInbox(page);
        continue;
      }

      // brand new message — extract and save
      const { sender, body } = await extractMessage(page);
      console.log(`new message from ${sender}: "${body?.substring(0, 100)}..."`);

      await saveMessage(env.DB, {
        externalId: messageId,
        direction: 'inbound',
        sender: sender || 'SAMUEL MULLIKIN',
        subject: msg.subject,
        body: body || '',
        timestamp: new Date().toISOString(),
      });

      newMessageCount++;
      await notifyDennis(env, `securus: new message from ${sender}\n\n${body?.substring(0, 160)}`);
      await navigateBackToInbox(page);
    }

    console.log(`phase 1 done: ${newMessageCount} new messages saved`);

    // phase 2: respond to all unresponded inbound messages from D1
    const unresponded = await getUnrespondedInbound(env.DB);
    console.log(`phase 2: ${unresponded.length} unresponded messages to process`);

    for (const msg of unresponded) {
      console.log(`responding to message ${msg.id} (${msg.external_id}): "${msg.subject?.substring(0, 60)}"`);

      if (shouldEscalate(msg.body)) {
        console.log('ESCALATION: message flagged for manual review');
        await notifyDennis(env, `⚠ ESCALATION: message from ${msg.sender} needs manual review:\n\n${msg.body?.substring(0, 300)}`);
        continue;
      }

      // generate AI response using saved body from D1
      const history = await getRecentMessages(env.DB, 20);
      const replySubject = `RE: ${msg.subject?.substring(0, 80) || 'your message'}`;
      const aiResponse = await generateResponse(env, msg.body, history, [], replySubject.length);

      if (!aiResponse) {
        console.log(`no AI response generated for message ${msg.id}`);
        continue;
      }

      // split and send
      const parts = splitForSend(replySubject, aiResponse);
      console.log(`sending ${parts.length} message(s) for reply to message ${msg.id}`);

      let firstOutboundId = null;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        console.log(`sending part ${i + 1}/${parts.length} (${part.subject.length + part.body.length} chars)`);

        const sendResult = await composeAndSend(page, {
          contactId: env.SAM_CONTACT_ID,
          subject: part.subject,
          body: part.body,
        });

        if (sendResult.success) {
          const outboundId = await saveMessage(env.DB, {
            direction: 'outbound',
            sender: 'DENNIS HANSON',
            subject: part.subject,
            body: part.body,
            timestamp: new Date().toISOString(),
          });
          if (i === 0) firstOutboundId = outboundId;
          await incrementCounter(env.DB, 'total_messages_sent');
          console.log(`part ${i + 1} sent for message ${msg.id}`);
        } else {
          console.log(`failed to send part ${i + 1}: ${sendResult.error}`);
          await notifyDennis(env, `securus-agent: failed to send reply part ${i + 1} to ${msg.sender}`);
          break;
        }
      }

      if (firstOutboundId) {
        await markResponded(env.DB, msg.id, firstOutboundId);
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

// === RESPOND TO D1 BACKLOG (no inbox scan, just respond to saved unresponded messages) ===
async function respondToBacklog(env) {
  console.log('=== RESPOND TO BACKLOG ===');

  const unresponded = await getUnrespondedInbound(env.DB);
  if (unresponded.length === 0) {
    console.log('no unresponded messages in D1');
    return { success: true, processed: 0, message: 'no unresponded messages' };
  }

  console.log(`${unresponded.length} unresponded messages to process`);
  const browser = await puppeteer.launch(env.BROWSER);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const loggedIn = await loginToSecurus(page, env);
    if (!loggedIn) {
      return { success: false, error: 'Login failed' };
    }

    let processed = 0;
    const results = [];

    for (const msg of unresponded) {
      console.log(`responding to message ${msg.id}: "${msg.subject?.substring(0, 60)}"`);

      if (shouldEscalate(msg.body)) {
        console.log(`ESCALATION: message ${msg.id} flagged`);
        results.push({ id: msg.id, status: 'escalated' });
        continue;
      }

      const history = await getRecentMessages(env.DB, 20);
      const replySubject = `RE: ${msg.subject?.substring(0, 80) || 'your message'}`;
      const aiResponse = await generateResponse(env, msg.body, history, [], replySubject.length);

      if (!aiResponse) {
        console.log(`no AI response for message ${msg.id}`);
        results.push({ id: msg.id, status: 'no_response' });
        continue;
      }

      const parts = splitForSend(replySubject, aiResponse);
      let firstOutboundId = null;
      let allSent = true;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const sendResult = await composeAndSend(page, {
          contactId: env.SAM_CONTACT_ID,
          subject: part.subject,
          body: part.body,
        });

        if (sendResult.success) {
          const outboundId = await saveMessage(env.DB, {
            direction: 'outbound',
            sender: 'DENNIS HANSON',
            subject: part.subject,
            body: part.body,
            timestamp: new Date().toISOString(),
          });
          if (i === 0) firstOutboundId = outboundId;
          await incrementCounter(env.DB, 'total_messages_sent');
        } else {
          allSent = false;
          results.push({ id: msg.id, status: 'send_failed', part: i + 1, error: sendResult.error });
          break;
        }
      }

      if (firstOutboundId) {
        await markResponded(env.DB, msg.id, firstOutboundId);
        processed++;
        results.push({ id: msg.id, status: 'sent', parts: parts.length });
      }
    }

    await logout(page);
    return { success: true, processed, total: unresponded.length, results };

  } catch (err) {
    console.error('backlog error:', err.message, err.stack);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// === GENERATE ONLY (no browser, just AI) ===
async function generateOnly(env) {
  console.log('=== GENERATE ONLY ===');

  const unresponded = await getUnrespondedInbound(env.DB);
  if (unresponded.length === 0) {
    return { success: true, generated: 0, message: 'no unresponded messages' };
  }

  const results = [];
  for (const msg of unresponded) {
    console.log(`generating for message ${msg.id}: "${msg.subject?.substring(0, 60)}"`);

    if (shouldEscalate(msg.body)) {
      results.push({ id: msg.id, status: 'escalated' });
      continue;
    }

    const history = await getRecentMessages(env.DB, 20);
    const replySubject = `RE: ${msg.subject?.substring(0, 80) || 'your message'}`;
    const aiResponse = await generateResponse(env, msg.body, history, [], replySubject.length);

    if (!aiResponse) {
      results.push({ id: msg.id, status: 'no_response' });
      continue;
    }

    const parts = splitForSend(replySubject, aiResponse);

    // store draft in system_state as JSON
    await setState(env.DB, `draft_${msg.id}`, JSON.stringify({
      messageId: msg.id,
      parts,
      generatedAt: new Date().toISOString(),
    }));

    results.push({ id: msg.id, status: 'generated', parts: parts.length, chars: aiResponse.length });
  }

  return { success: true, generated: results.filter(r => r.status === 'generated').length, results };
}

// === SEND DRAFTS ONLY (browser only, no AI) ===
async function sendDrafts(env) {
  console.log('=== SEND DRAFTS ===');

  const unresponded = await getUnrespondedInbound(env.DB);
  if (unresponded.length === 0) {
    return { success: true, sent: 0, message: 'no unresponded messages' };
  }

  // find messages that have drafts ready
  const toSend = [];
  for (const msg of unresponded) {
    const draftJson = await getState(env.DB, `draft_${msg.id}`);
    if (draftJson) {
      toSend.push({ msg, draft: JSON.parse(draftJson) });
    }
  }

  if (toSend.length === 0) {
    return { success: true, sent: 0, message: 'no drafts ready — run /generate first' };
  }

  console.log(`${toSend.length} drafts ready to send`);
  const browser = await puppeteer.launch(env.BROWSER);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const loggedIn = await loginToSecurus(page, env);
    if (!loggedIn) {
      return { success: false, error: 'Login failed' };
    }

    let sent = 0;
    const results = [];

    for (const { msg, draft } of toSend) {
      console.log(`sending draft for message ${msg.id} (${draft.parts.length} parts)`);
      let firstOutboundId = null;
      let allSent = true;

      for (let i = 0; i < draft.parts.length; i++) {
        const part = draft.parts[i];
        const sendResult = await composeAndSend(page, {
          contactId: env.SAM_CONTACT_ID,
          subject: part.subject,
          body: part.body,
        });

        if (sendResult.success) {
          const outboundId = await saveMessage(env.DB, {
            direction: 'outbound',
            sender: 'DENNIS HANSON',
            subject: part.subject,
            body: part.body,
            timestamp: new Date().toISOString(),
          });
          if (i === 0) firstOutboundId = outboundId;
          await incrementCounter(env.DB, 'total_messages_sent');
        } else {
          allSent = false;
          results.push({ id: msg.id, status: 'send_failed', part: i + 1, error: sendResult.error });
          break;
        }
      }

      if (firstOutboundId) {
        await markResponded(env.DB, msg.id, firstOutboundId);
        // clean up draft
        await setState(env.DB, `draft_${msg.id}`, '');
        sent++;
        results.push({ id: msg.id, status: 'sent', parts: draft.parts.length });
      }
    }

    await logout(page);
    return { success: true, sent, total: toSend.length, results };

  } catch (err) {
    console.error('send drafts error:', err.message, err.stack);
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

    if (url.pathname === '/respond') {
      const result = await respondToBacklog(env);
      return Response.json(result);
    }

    if (url.pathname === '/generate') {
      const result = await generateOnly(env);
      return Response.json(result);
    }

    if (url.pathname === '/send') {
      try {
        const result = await sendDrafts(env);
        return Response.json(result);
      } catch (err) {
        return Response.json({ success: false, error: err.message, stack: err.stack?.substring(0, 500) });
      }
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
      routes: ['/test', '/check', '/respond', '/generate', '/send', '/status'],
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

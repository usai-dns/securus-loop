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

// clean up reply subject — strip duplicate RE: prefixes, trailing ..., limit length
function makeReplySubject(originalSubject) {
  let s = (originalSubject || 'your message').replace(/\.{2,}$/, '').trim();
  // strip any existing RE: prefix(es)
  s = s.replace(/^(RE:\s*)+/i, '').trim();
  // truncate to fit (subject shares 20k limit with body, keep subject short)
  s = s.substring(0, 60);
  return `RE: ${s}`;
}

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

// === AUTONOMOUS CRON LOOP ===
// Two-pass design to stay within CF time limits:
//   Pass 1 (no browser): generate AI responses for any unresponded messages, store as drafts
//   Pass 2 (browser): scan inbox for new messages + send any ready drafts — one browser session
async function cronLoop(env) {
  console.log('=== CRON LOOP START ===');

  // --- PASS 1: generate drafts (no browser needed) ---
  const unresponded = await getUnrespondedInbound(env.DB);
  let generated = 0;

  for (const msg of unresponded) {
    // skip if draft already exists
    const existingDraft = await getState(env.DB, `draft_${msg.id}`);
    if (existingDraft) {
      console.log(`draft already exists for message ${msg.id}, skipping generation`);
      continue;
    }

    if (shouldEscalate(msg.body)) {
      console.log(`ESCALATION: message ${msg.id} flagged for manual review`);
      await notifyDennis(env, `⚠ ESCALATION: message from ${msg.sender} needs manual review:\n\n${msg.body?.substring(0, 300)}`);
      continue;
    }

    console.log(`generating response for message ${msg.id}`);
    const history = await getRecentMessages(env.DB, 20);
    const replySubject = makeReplySubject(msg.subject);
    const aiResponse = await generateResponse(env, msg.body, history, [], replySubject.length);

    if (!aiResponse) {
      console.log(`no AI response for message ${msg.id}`);
      continue;
    }

    const parts = splitForSend(replySubject, aiResponse);
    await setState(env.DB, `draft_${msg.id}`, JSON.stringify({
      messageId: msg.id,
      parts,
      generatedAt: new Date().toISOString(),
    }));
    generated++;
    console.log(`draft saved for message ${msg.id} (${parts.length} parts, ${aiResponse.length} chars)`);
  }

  console.log(`pass 1 done: ${generated} drafts generated`);

  // --- PASS 2: browser session — scan inbox + send drafts ---
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
  } catch (err) {
    if (err.message?.includes('429') || err.message?.includes('Rate limit')) {
      console.log('browser rate limited — skipping browser pass, will retry next hour');
      await setState(env.DB, 'last_error', `browser rate limited at ${new Date().toISOString()}`);
      await setState(env.DB, 'last_check', new Date().toISOString());
      await incrementCounter(env.DB, 'total_checks');
      return { success: true, generated, browserSkipped: true, reason: 'rate_limited' };
    }
    throw err;
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const loggedIn = await loginToSecurus(page, env);
    if (!loggedIn) {
      await setState(env.DB, 'last_error', `login failed at ${new Date().toISOString()}`);
      await notifyDennis(env, 'securus-agent: login failed');
      return { success: false, error: 'Login failed' };
    }

    // --- 2a: scan inbox for new messages ---
    await navigateToInbox(page);
    const allMessages = await enumerateMessages(page);
    const samMessages = findSamMessages(allMessages);
    console.log(`found ${samMessages.length} messages from Sam`);

    let newMessageCount = 0;
    for (const msg of samMessages) {
      const messageId = await openMessage(page, msg.index);

      if (!messageId) {
        console.log(`skipping message at index ${msg.index} — no messageId`);
        await navigateBackToInbox(page);
        continue;
      }

      const existing = await getMessageByExternalId(env.DB, messageId);
      if (existing) {
        console.log(`message ${messageId} already in D1 — stopping scan (inbox is newest-first)`);
        await navigateBackToInbox(page);
        break;  // early exit: all remaining messages are older and already processed
      }

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

    console.log(`inbox scan done: ${newMessageCount} new messages`);

    // --- 2b: send any ready drafts ---
    const allUnresponded = await getUnrespondedInbound(env.DB);
    let sent = 0;

    for (const msg of allUnresponded) {
      const draftJson = await getState(env.DB, `draft_${msg.id}`);
      if (!draftJson) continue;

      const draft = JSON.parse(draftJson);
      console.log(`sending draft for message ${msg.id} (${draft.parts.length} parts)`);

      let firstOutboundId = null;
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
          console.log(`part ${i + 1} sent for message ${msg.id}`);
        } else {
          console.log(`failed to send part ${i + 1}: ${sendResult.error}`);
          await notifyDennis(env, `securus-agent: failed to send reply part ${i + 1}`);
          break;
        }
      }

      if (firstOutboundId) {
        await markResponded(env.DB, msg.id, firstOutboundId);
        await setState(env.DB, `draft_${msg.id}`, '');
        sent++;
      }
    }

    // update state
    await setState(env.DB, 'last_check', new Date().toISOString());
    await incrementCounter(env.DB, 'total_checks');
    await logout(page);

    console.log(`=== CRON DONE: ${newMessageCount} new, ${generated} generated, ${sent} sent ===`);
    return { success: true, newMessages: newMessageCount, generated, sent };

  } catch (err) {
    console.error('cron loop error:', err.message, err.stack);
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
      const replySubject = makeReplySubject(msg.subject);
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
    const replySubject = makeReplySubject(msg.subject);
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/ping') {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        const title = await page.title();
        await browser.close();
        return Response.json({ success: true, title, ts: Date.now() });
      } catch (err) {
        return Response.json({ success: false, error: err.message });
      }
    }

    // debug: login, go to compose, fill form, take screenshot — does NOT send
    if (url.pathname === '/debug-compose') {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        const loggedIn = await loginToSecurus(page, env);
        if (!loggedIn) {
          await browser.close();
          return Response.json({ success: false, error: 'Login failed' });
        }
        // navigate to compose
        await page.goto('https://securustech.online/#/products/emessage/compose', {
          waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await new Promise(r => setTimeout(r, 2000));
        // screenshot before fill
        const before = await page.screenshot({ encoding: 'base64' });
        // select contact
        const { compose: sel } = await import('./securus/selectors.mjs');
        await page.waitForSelector(sel.contactDropdown, { visible: true, timeout: 15000 });
        await page.select(sel.contactDropdown, env.SAM_CONTACT_ID);
        await new Promise(r => setTimeout(r, 1500));
        await page.waitForSelector(sel.subjectField, { visible: true, timeout: 10000 });
        await page.waitForSelector(sel.messageBody, { visible: true, timeout: 10000 });
        // test: simple subject + actual draft body (isolate which field causes disabled)
        const { fillField } = await import('./securus/helpers.mjs');
        const draftJson = await getState(env.DB, 'draft_10');
        const draft = draftJson ? JSON.parse(draftJson) : null;
        const testBody = draft ? draft.parts[0].body : 'x'.repeat(4000);
        await fillField(page, sel.subjectField, 'test subject');
        await new Promise(r => setTimeout(r, 300));
        await fillField(page, sel.messageBody, testBody);
        await new Promise(r => setTimeout(r, 500));
        // check form state
        const formState = await page.evaluate((selectors) => {
          const subject = document.querySelector(selectors.subjectField)?.value;
          const body = document.querySelector(selectors.messageBody)?.value;
          const sendBtn = document.querySelector(selectors.sendButton);
          return {
            subjectValue: subject,
            bodyValue: body,
            sendButtonDisabled: sendBtn?.disabled,
            sendButtonText: sendBtn?.textContent?.trim(),
            pageText: document.body?.innerText?.substring(0, 1000),
          };
        }, sel);
        // screenshot after fill
        const after = await page.screenshot({ encoding: 'base64' });
        await browser.close();
        return new Response(JSON.stringify({
          success: true,
          formState,
          screenshots: { before: before.substring(0, 100) + '...', after: after.substring(0, 100) + '...' },
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return Response.json({ success: false, error: err.message, stack: err.stack?.substring(0, 500) });
      }
    }

    if (url.pathname === '/test') {
      const result = await sendTestMessage(env);
      return Response.json(result);
    }

    if (url.pathname === '/check') {
      const result = await cronLoop(env);
      return Response.json(result);
    }

    // fire-and-forget cron trigger — returns immediately, runs loop in background
    if (url.pathname === '/cron') {
      ctx.waitUntil(cronLoop(env));
      return Response.json({ triggered: true, ts: new Date().toISOString() });
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

    if (url.pathname === '/draft') {
      const unresponded = await getUnrespondedInbound(env.DB);
      const drafts = [];
      for (const msg of unresponded) {
        const draftJson = await getState(env.DB, `draft_${msg.id}`);
        if (draftJson) {
          const draft = JSON.parse(draftJson);
          drafts.push({
            msgId: msg.id,
            parts: draft.parts.map(p => ({
              subject: p.subject,
              bodyLength: p.body.length,
              bodyPreview: p.body.substring(0, 200),
              bodyEnd: p.body.substring(p.body.length - 100),
            })),
          });
        }
      }
      return Response.json({ drafts, unrespondedCount: unresponded.length });
    }

    // diagnostic: login, scan inbox, report what we see — no changes made
    if (url.pathname === '/scan') {
      const steps = [];
      let browser;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        // step 1: login
        const loggedIn = await loginToSecurus(page, env);
        const postLoginUrl = page.url();
        const postLoginText = await page.evaluate(() => document.body?.innerText?.substring(0, 1500) || '');
        steps.push({ step: 'login', success: loggedIn, url: postLoginUrl, bodyText: postLoginText });
        if (!loggedIn) {
          await browser.close();
          return Response.json({ success: false, error: 'Login failed', steps });
        }

        // step 2: navigate to inbox
        await navigateToInbox(page);
        const inboxUrl = page.url();
        const inboxText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '');
        const inboxHtml = await page.evaluate(() => {
          const table = document.querySelector('table');
          return table ? table.outerHTML.substring(0, 3000) : 'NO TABLE FOUND';
        });
        const allSelectors = await page.evaluate(() => {
          return {
            tables: document.querySelectorAll('table').length,
            trs: document.querySelectorAll('table tr').length,
            tds: document.querySelectorAll('table td').length,
            links: [...document.querySelectorAll('a')].slice(0, 10).map(a => ({ href: a.href, text: a.textContent?.trim()?.substring(0, 50) })),
            h1s: [...document.querySelectorAll('h1,h2,h3')].map(h => h.textContent?.trim()?.substring(0, 50)),
          };
        });
        steps.push({ step: 'inbox', url: inboxUrl, selectors: allSelectors, tableHtml: inboxHtml, bodyText: inboxText });

        // step 3: enumerate messages
        const allMessages = await enumerateMessages(page);
        const samMessages = findSamMessages(allMessages);
        steps.push({ step: 'enumerate', total: allMessages.length, samCount: samMessages.length, messages: allMessages });

        // step 4: if 0 messages, try alternative approaches
        if (allMessages.length === 0) {
          // maybe the page needs more time — wait and retry
          await new Promise(r => setTimeout(r, 5000));
          const retryText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '');
          const retryHtml = await page.evaluate(() => {
            const table = document.querySelector('table');
            return table ? table.outerHTML.substring(0, 3000) : 'NO TABLE FOUND';
          });
          const retryMessages = await enumerateMessages(page);

          // also try direct navigation
          await page.goto('https://securustech.online/#/products/emessage/inbox', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await new Promise(r => setTimeout(r, 5000));
          const directUrl = page.url();
          const directText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '');
          const directHtml = await page.evaluate(() => {
            const table = document.querySelector('table');
            return table ? table.outerHTML.substring(0, 3000) : 'NO TABLE FOUND';
          });
          const directMessages = await enumerateMessages(page);

          steps.push({
            step: 'retry',
            afterWait: { bodyText: retryText, tableHtml: retryHtml, count: retryMessages.length },
            afterDirectNav: { url: directUrl, bodyText: directText, tableHtml: directHtml, count: directMessages.length, messages: directMessages },
          });
        }

        await logout(page);
        await browser.close();
        return Response.json({ success: true, total: allMessages.length, samCount: samMessages.length, steps });
      } catch (err) {
        if (browser) await browser.close().catch(() => {});
        return Response.json({ success: false, error: err.message, stack: err.stack?.substring(0, 500), steps });
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
      routes: ['/test', '/check', '/cron', '/respond', '/generate', '/send', '/status'],
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // cron handler — scheduled execution
  async scheduled(event, env, ctx) {
    // small jitter (0-2 min) to vary login timing without wasting execution budget
    const jitterMs = Math.floor(Math.random() * 30 * 1000);
    console.log(`cron triggered, jitter: ${jitterMs}ms (${(jitterMs / 1000).toFixed(0)}s)`);
    await new Promise(resolve => setTimeout(resolve, jitterMs));

    ctx.waitUntil(cronLoop(env));
  },
};

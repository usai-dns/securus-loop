// securus-agent cloudflare worker — three-phase cron architecture
// Phase 1: SCAN — browser reads inbox, saves to D1
// Phase 2: GENERATE — AI creates responses, saves drafts
// Phase 3: SEND — browser sends drafts, verifies in sent folder, marks confirmed
import puppeteer from '@cloudflare/puppeteer';
import { loginToSecurus, logout, acceptPendingTerms } from './securus/auth.mjs';
import { navigateToInbox, enumerateMessages, enumerateAllPages, findSamMessages } from './securus/inbox.mjs';
import { openMessage, extractMessage, navigateBackToInbox } from './securus/read.mjs';
import { composeAndSend } from './securus/compose.mjs';
import { urls, compose as composeSel } from './securus/selectors.mjs';
import { humanDelay, safeGoto } from './securus/helpers.mjs';
import { messageExists, getMessageByExternalId, saveMessage, markResponded, markConfirmedSent, getUnconfirmedOutbound, resetResponse, getRecentMessages, getUnrespondedInbound, getMessagesByDocTag, getAllDocTags, getAllMessages } from './db/messages.mjs';
import { parseDocCommand, docAcknowledgment } from './docs/commands.mjs';
import { getState, setState, incrementCounter } from './db/state.mjs';
import { notifyDennis } from './notify/sms.mjs';
import { generateResponse, splitForSend, shouldEscalate, buildDocument } from './ai/responder.mjs';
import { getDocument, saveDocument, docTitle, changeNoteFor, getDocumentVersions } from './db/documents.mjs';
import { getUsageSnapshot } from './db/usage.mjs';
import { getContacts, getContact, contactIdForSender, DEFAULT_CONTACT } from './db/contacts.mjs';
import { getAutobuyConfig, autobuyGuard, purchaseStamps, recordPurchaseAttempt, getPurchaseLog, AUTOBUY_DEFAULTS } from './securus/stamps.mjs';
import { queueOutboundParts, getPendingParts, markPartSent, markPartFailed, getQueueStatus, hasPendingParts, hasQueuedForInbound, resetFailedParts } from './db/send_queue.mjs';
import { detectSeriesIndicator, stripSeriesIndicator, getOrCreateSeries, addSeriesPart, checkSeriesComplete, getCompleteSeries, getSeriesParts, markSeriesProcessed, getSeriesStatus, findDuplicateInbound } from './db/series.mjs';
import { getDashboardData, renderDashboardHTML } from './dashboard.mjs';

function makeReplySubject(originalSubject) {
  let s = (originalSubject || 'your message').replace(/\.{2,}$/, '').trim();
  s = s.replace(/^(RE:\s*)+/i, '').trim();
  s = s.substring(0, 60);
  return `RE: ${s}`;
}

const MAX_SENDS_PER_CYCLE = 4;
const MAX_CONSECUTIVE_KNOWN = 2;
const MAX_TOPIC_CHARS = 50000;

// imported reference content: scoped key is `${contactId}:${tag}_import`;
// sam's pre-multi-tenant data lives at the legacy `${tag}_import` key.
async function getImportContent(db, contactId, tag) {
  const scoped = await getState(db, `${contactId}:${tag}_import`);
  if (scoped) return scoped;
  if (contactId === DEFAULT_CONTACT) return getState(db, `${tag}_import`);
  return null;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 1: SCAN — browser reads inbox, saves new messages to D1
// ═══════════════════════════════════════════════════════════════
async function phaseScan(env) {
  console.log('=== PHASE 1: SCAN ===');
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const loggedIn = await loginToSecurus(page, env);
    if (!loggedIn) {
      await setState(env.DB, 'last_error', `scan: login failed at ${new Date().toISOString()}`);
      return { success: false, error: 'Login failed' };
    }

    await navigateToInbox(page);
    const allMessages = await enumerateMessages(page);

    // attribute each inbox row to a registered contact by sender; process only
    // messages from active contacts. Anything from an unknown sender is ignored.
    const contacts = await getContacts(env.DB, { activeOnly: true });
    const ours = allMessages
      .map(m => ({ ...m, contactId: contactIdForSender(m.sender, contacts) }))
      .filter(m => m.contactId);
    console.log(`inbox: ${allMessages.length} total, ${ours.length} from registered contacts`);

    await setState(env.DB, 'last_scan', JSON.stringify({
      ts: new Date().toISOString(),
      totalRows: allMessages.length,
      ourCount: ours.length,
      pageUrl: page.url(),
      first3: allMessages.slice(0, 3).map(m => ({ sender: m.sender, subject: m.subject?.substring(0, 50) })),
    }));

    let newMessageCount = 0;
    let consecutiveKnown = 0;

    for (const msg of ours) {
      if (consecutiveKnown >= MAX_CONSECUTIVE_KNOWN) {
        console.log(`${consecutiveKnown} consecutive known — stopping scan early`);
        break;
      }

      const messageId = await openMessage(page, msg.index);
      if (!messageId) {
        console.log(`skipping message at index ${msg.index} — no messageId`);
        await navigateBackToInbox(page);
        continue;
      }

      const existing = await getMessageByExternalId(env.DB, messageId);
      if (existing) {
        consecutiveKnown++;
        console.log(`message ${messageId} already in D1 (${consecutiveKnown}/${MAX_CONSECUTIVE_KNOWN} consecutive known)`);
        await navigateBackToInbox(page);
        continue;
      }

      consecutiveKnown = 0;
      const { sender, body } = await extractMessage(page);
      // re-attribute from the opened message's sender (authoritative), fall back
      // to the inbox-row attribution.
      const contactId = contactIdForSender(sender, contacts) || msg.contactId;
      const contact = contacts.find(c => c.id === contactId);
      console.log(`new message from ${sender} → contact "${contactId}": "${body?.substring(0, 80)}..."`);

      const { command: docCmd, docTag } = parseDocCommand(body);
      if (docCmd) console.log(`doc command: ${docCmd} ${docTag}`);

      const newMsgId = await saveMessage(env.DB, {
        externalId: messageId,
        contactId,
        direction: 'inbound',
        sender: sender || contact?.name || 'UNKNOWN',
        subject: msg.subject,
        body: body || '',
        timestamp: new Date().toISOString(),
        docTag: docTag || null,
      });

      const seriesInfo = detectSeriesIndicator(body);
      if (seriesInfo) {
        // scope the series key per contact so two inmates' identical "message
        // 1/3" bodies never collide.
        const scopedKey = `${contactId}:${seriesInfo.seriesKey}`;
        console.log(`series detected: message ${seriesInfo.partNum}/${seriesInfo.totalParts} (key: ${scopedKey})`);
        const series = await getOrCreateSeries(env.DB, {
          contactId,
          seriesKey: scopedKey,
          totalParts: seriesInfo.totalParts,
          docTag: docTag || null,
          docCommand: docCmd || null,
        });
        await addSeriesPart(env.DB, { seriesId: series.id, partNum: seriesInfo.partNum, messageId: newMsgId });
        await env.DB.prepare("UPDATE messages SET responded_at = 'series_collecting' WHERE id = ?").bind(newMsgId).run();
        const isComplete = await checkSeriesComplete(env.DB, series.id);
        if (isComplete) console.log(`series ${scopedKey} COMPLETE`);
      }

      newMessageCount++;
      await notifyDennis(env, `securus: new message from ${sender}\n\n${body?.substring(0, 160)}`);
      await navigateBackToInbox(page);
    }

    // snapshot the compose recipient dropdown into state — onboarding needs the
    // securus_id for new contacts, and manual logins are often throttled while
    // this cron login is already established.
    try {
      await page.goto(urls.compose, { waitUntil: 'networkidle2', timeout: 45000 });
      await new Promise(r => setTimeout(r, 2500));
      await acceptPendingTerms(page).catch(() => {});
      await page.waitForSelector(composeSel.contactDropdown, { visible: true, timeout: 15000 });
      const ddOptions = await page.evaluate((sel) => {
        const dd = document.querySelector(sel);
        return dd ? [...dd.options].map(o => ({ value: o.value, text: (o.textContent || '').trim() })).filter(o => o.value) : [];
      }, composeSel.contactDropdown);
      await setState(env.DB, 'contact_dropdown', JSON.stringify({ ts: new Date().toISOString(), options: ddOptions }));
      console.log(`dropdown snapshot: ${ddOptions.length} contacts`);
    } catch (ddErr) {
      console.log(`dropdown snapshot failed: ${ddErr.message}`);
    }

    // stamp purchase-flow RECON (read-only): map the pages so auto-purchase can
    // be built with verified selectors. Captures structure and options only —
    // NEVER clicks any purchase/confirm control.
    try {
      const links = await page.evaluate(() => {
        return [...document.querySelectorAll('a,button')]
          .filter(el => /stamp/i.test(el.textContent || '') || /stamp/i.test(el.getAttribute('href') || ''))
          .map(el => ({ tag: el.tagName, text: (el.textContent || '').trim().substring(0, 60), href: el.getAttribute('href') }));
      });
      let purchasePage = null;
      const target = links.find(l => l.href && /stamp|purchase/i.test(l.href));
      if (target?.href) {
        const dest = target.href.startsWith('http') ? target.href : `https://securustech.online/${target.href.replace(/^\//, '')}`;
        await page.goto(dest, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
        purchasePage = await page.evaluate(() => ({
          url: location.href,
          bodyText: (document.body?.innerText || '').substring(0, 2500),
          controls: [...document.querySelectorAll('button, input[type="radio"], select, a.button')]
            .map(el => ({ tag: el.tagName, type: el.getAttribute('type'), text: (el.textContent || el.value || '').trim().substring(0, 60) }))
            .filter(c => c.text).slice(0, 40),
        }));
      }
      await setState(env.DB, 'stamp_purchase_recon', JSON.stringify({ ts: new Date().toISOString(), links, purchasePage }));
      console.log(`stamp recon: ${links.length} stamp links found${purchasePage ? ', purchase page captured' : ''}`);
    } catch (reconErr) {
      console.log(`stamp recon failed: ${reconErr.message}`);
    }

    await logout(page);
    console.log(`=== SCAN DONE: ${newMessageCount} new messages ===`);
    return { success: true, newMessages: newMessageCount, total: ours.length };
  } catch (err) {
    console.error('scan error:', err.message, err.stack);
    await setState(env.DB, 'last_error', `scan: ${err.message} at ${new Date().toISOString()}`);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2: GENERATE — AI creates responses, saves as drafts
// ═══════════════════════════════════════════════════════════════
async function phaseGenerate(env) {
  console.log('=== PHASE 2: GENERATE ===');
  let generated = 0;
  const results = [];

  // process complete inbound series first
  const completeSeries = await getCompleteSeries(env.DB);
  for (const series of completeSeries) {
    console.log(`processing complete series: ${series.series_key} (${series.total_parts} parts)`);
    const parts = await getSeriesParts(env.DB, series.id);
    const bodies = parts.map(p => {
      const { cleanBody } = parseDocCommand(p.body);
      return stripSeriesIndicator(cleanBody || p.body);
    });
    const combinedBody = bodies.join('\n\n---\n\n');

    const contactId = series.contact_id || DEFAULT_CONTACT;
    const contact = await getContact(env.DB, contactId);
    const effectiveTag = series.doc_tag;
    const effectiveCmd = series.doc_command;
    const isFullDoc = effectiveCmd === 'makefull';
    const recentHistory = await getRecentMessages(env.DB, 10, contactId);
    let topicHistory = null;
    let knowledgeEntries = [];
    let currentDocument = null;

    if (effectiveTag) {
      const allTopicMsgs = await getMessagesByDocTag(env.DB, contactId, effectiveTag);
      let totalChars = 0;
      topicHistory = [];
      for (let i = allTopicMsgs.length - 1; i >= 0; i--) {
        const bodyLen = (allTopicMsgs[i].body || '').length;
        if (totalChars + bodyLen > MAX_TOPIC_CHARS && topicHistory.length > 0) break;
        topicHistory.unshift(allTopicMsgs[i]);
        totalChars += bodyLen;
      }
      const importContent = await getImportContent(env.DB, contactId, effectiveTag);
      if (importContent) {
        const truncated = importContent.length > 30000 ? importContent.substring(0, 30000) + '\n\n[... truncated ...]' : importContent;
        knowledgeEntries.push({ topic: `${effectiveTag} project reference`, content: truncated });
      }
      const govDoc = await getDocument(env.DB, contactId, effectiveTag);
      if (govDoc?.content) currentDocument = govDoc.content;
    }

    const replySubject = effectiveTag
      ? `RE: ${effectiveTag.charAt(0).toUpperCase() + effectiveTag.slice(1)} Update`
      : makeReplySubject(parts[0].subject);

    try {
      const aiResponse = await generateResponse(env, combinedBody, recentHistory, knowledgeEntries, replySubject.length, topicHistory, effectiveTag, { fullDocument: isFullDoc, currentDocument, language: contact?.language, contactName: contact?.name, contactNick: contactId });
      if (aiResponse) {
        const ack = docAcknowledgment(effectiveCmd, effectiveTag, { total: series.total_parts });
        const finalResponse = ack + aiResponse;
        const outboundParts = splitForSend(replySubject, finalResponse);
        const primaryId = parts[0].message_id;
        await queueOutboundParts(env.DB, { inboundId: primaryId, seriesId: series.id, parts: outboundParts, docTag: effectiveTag, contactId, securusId: contact?.securus_id });
        // maintain the governing document for this contact/topic
        if ((effectiveCmd === 'makenew' || effectiveCmd === 'makeupdate') && effectiveTag) {
          try {
            const existing = await getDocument(env.DB, contactId, effectiveTag);
            const title = existing?.title || docTitle(effectiveTag);
            const newMaterial = `Direction / notes:\n${combinedBody}\n\n─────\n\nDrafted content (integrate this):\n${aiResponse}`;
            const updated = await buildDocument(env, { tag: effectiveTag, title, currentDoc: existing?.content || '', newMaterial, command: effectiveCmd, authorName: contactId, language: contact?.language });
            if (updated) await saveDocument(env.DB, { contactId, tag: effectiveTag, title, content: updated, changeNote: changeNoteFor(effectiveCmd, (existing?.content || '').length, updated.length), messageId: primaryId });
          } catch (docErr) { console.error(`series doc build failed (${contactId}/${effectiveTag}): ${docErr.message}`); }
        }
        await markSeriesProcessed(env.DB, series.id);
        generated++;
        results.push({ id: primaryId, status: 'generated', type: 'series', contact: contactId, parts: outboundParts.length, seriesKey: series.series_key });
        console.log(`series ${series.series_key} response queued (${outboundParts.length} parts, ${finalResponse.length} chars)`);
      }
    } catch (genErr) {
      console.error(`series generation error for ${series.series_key}: ${genErr.message}`);
      results.push({ seriesKey: series.series_key, status: 'error', error: genErr.message });
    }
  }

  // generate for individual (non-series) unresponded messages
  const pending = await getUnrespondedInbound(env.DB);
  for (const msg of pending) {
    // dedup: if already queued or outbound exists, mark responded and skip
    const alreadyQueued = await hasQueuedForInbound(env.DB, msg.id);
    if (alreadyQueued) {
      const firstSent = await env.DB.prepare(
        "SELECT outbound_msg_id FROM send_queue WHERE inbound_id = ? AND status = 'sent' AND outbound_msg_id IS NOT NULL LIMIT 1"
      ).bind(msg.id).first();
      if (firstSent) {
        await markResponded(env.DB, msg.id, firstSent.outbound_msg_id);
        console.log(`dedup: msg ${msg.id} already sent (outbound #${firstSent.outbound_msg_id}), marked responded`);
      } else {
        console.log(`dedup: msg ${msg.id} has queue entries (pending/failed), skipping generation`);
      }
      results.push({ id: msg.id, status: 'already_queued' });
      continue;
    }

    // Crash-recovery dedup: does a reply to THIS message already exist? Scoped
    // by contact_id (isolation) AND by time — a reply can only answer a message
    // it POSTDATES. Without the time bound, a contact who reuses the same first
    // line (e.g. "MakeUpdate Monday") gets new messages silently matched to a
    // days-old reply and never answered (this ate messages #302-304).
    const replySubjectCheck = makeReplySubject(msg.subject);
    const existingOutbound = await env.DB.prepare(
      "SELECT id FROM messages WHERE direction = 'outbound' AND contact_id = ? AND subject = ? AND timestamp >= ? LIMIT 1"
    ).bind(msg.contact_id || DEFAULT_CONTACT, replySubjectCheck, msg.timestamp).first();
    if (existingOutbound) {
      console.log(`dedup: outbound already exists for msg ${msg.id} (outbound #${existingOutbound.id}), marking responded`);
      await markResponded(env.DB, msg.id, existingOutbound.id);
      results.push({ id: msg.id, status: 'dedup_resolved', outboundId: existingOutbound.id });
      continue;
    }

    // content-duplicate guard: Sam occasionally re-sends the same message with
    // a fresh Securus messageId (external_id dedup can't see it). If a recent
    // near-identical inbound was already handled, mirror its response instead
    // of generating a second near-identical reply and burning a stamp.
    const dup = await findDuplicateInbound(env.DB, {
      messageId: msg.id, body: msg.body, sender: msg.sender,
    });
    if (dup) {
      const marker = dup.response_id ? String(dup.response_id) : `duplicate_of_${dup.id}`;
      await env.DB.prepare(
        "UPDATE messages SET responded_at = ?, response_id = ? WHERE id = ?"
      ).bind(dup.responded_at && dup.response_id ? dup.responded_at : `duplicate_of_${dup.id}`, dup.response_id || null, msg.id).run();
      console.log(`dedup(content): msg ${msg.id} is a near-duplicate of ${dup.id}, mirrored response ${marker}`);
      results.push({ id: msg.id, status: 'duplicate', of: dup.id });
      continue;
    }

    if (shouldEscalate(msg.body)) {
      console.log(`ESCALATION: message ${msg.id} flagged for manual review`);
      await notifyDennis(env, `⚠ ESCALATION: message from ${msg.sender} needs manual review:\n\n${msg.body?.substring(0, 300)}`);
      await env.DB.prepare("UPDATE messages SET responded_at = 'escalated' WHERE id = ?").bind(msg.id).run();
      results.push({ id: msg.id, status: 'escalated' });
      continue;
    }

    try {
      const contactId = msg.contact_id || DEFAULT_CONTACT;
      const contact = await getContact(env.DB, contactId);
      console.log(`generating response for message ${msg.id} (contact ${contactId}): "${msg.subject?.substring(0, 60)}"`);
      const { command: docCmd, docTag, cleanBody } = parseDocCommand(msg.body);
      const bodyForAi = cleanBody || msg.body;
      const recentHistory = await getRecentMessages(env.DB, 10, contactId);
      const effectiveTag = msg.doc_tag || docTag;
      const isFullDoc = docCmd === 'makefull';
      let topicHistory = null;
      let knowledgeEntries = [];

      if (effectiveTag) {
        const allTopicMsgs = await getMessagesByDocTag(env.DB, contactId, effectiveTag);
        let totalChars = 0;
        topicHistory = [];
        for (let i = allTopicMsgs.length - 1; i >= 0; i--) {
          const bodyLen = (allTopicMsgs[i].body || '').length;
          if (totalChars + bodyLen > MAX_TOPIC_CHARS && topicHistory.length > 0) break;
          topicHistory.unshift(allTopicMsgs[i]);
          totalChars += bodyLen;
        }
        console.log(`loaded ${topicHistory.length}/${allTopicMsgs.length} messages for topic "${effectiveTag}" (${totalChars} chars)`);
        const importContent = await getImportContent(env.DB, contactId, effectiveTag);
        if (importContent) {
          const truncated = importContent.length > 30000 ? importContent.substring(0, 30000) + '\n\n[... truncated ...]' : importContent;
          knowledgeEntries.push({ topic: `${effectiveTag} project reference`, content: truncated });
          console.log(`loaded ${importContent.length} chars of imported ${effectiveTag} content`);
        }
      }

      // load the current governing document so Dennis responds with the whole
      // combined manuscript in view (not just the message stream), before it's
      // updated with this edit.
      let currentDocument = null;
      if (effectiveTag) {
        const govDoc = await getDocument(env.DB, contactId, effectiveTag);
        if (govDoc?.content) {
          currentDocument = govDoc.content;
          console.log(`loaded governing doc "${contactId}/${effectiveTag}" v${govDoc.version} (${currentDocument.length} chars) into response context`);
        }
      }

      const replySubject = makeReplySubject(msg.subject);

      // makefull: send the CURRENT governing document (not a fresh regeneration).
      if (isFullDoc && effectiveTag) {
        const govDoc = await getDocument(env.DB, contactId, effectiveTag);
        if (govDoc && govDoc.content) {
          const ack = docAcknowledgment('makefull', effectiveTag);
          const parts = splitForSend(replySubject, ack + govDoc.content);
          await queueOutboundParts(env.DB, { inboundId: msg.id, seriesId: null, parts, docTag: effectiveTag, contactId, securusId: contact?.securus_id });
          generated++;
          results.push({ id: msg.id, status: 'sent_full_doc', contact: contactId, tag: effectiveTag, version: govDoc.version, parts: parts.length });
          console.log(`makefull: queued governing "${contactId}/${effectiveTag}" doc v${govDoc.version} (${parts.length} parts)`);
          continue;
        }
        // no stored doc yet → fall through to generate one from history
      }

      const aiResponse = await generateResponse(env, bodyForAi, recentHistory, knowledgeEntries, replySubject.length, topicHistory, effectiveTag, { fullDocument: isFullDoc, currentDocument, language: contact?.language, contactName: contact?.name, contactNick: contactId });

      if (aiResponse) {
        const ack = docAcknowledgment(docCmd, docTag);
        const finalResponse = ack + aiResponse;
        const outboundParts = splitForSend(replySubject, finalResponse);
        await queueOutboundParts(env.DB, { inboundId: msg.id, seriesId: null, parts: outboundParts, docTag: effectiveTag, contactId, securusId: contact?.securus_id });
        generated++;

        // maintain the governing document in place for makenew/makeupdate. This
        // is separate from the reply above — it edits the living artifact.
        let docVersion = null;
        if ((docCmd === 'makenew' || docCmd === 'makeupdate') && effectiveTag) {
          try {
            const existing = await getDocument(env.DB, contactId, effectiveTag);
            const title = existing?.title || docTitle(effectiveTag);
            // feed both the sender's direction AND the drafted reply — the reply
            // is where the actual written content lives.
            const newMaterial = `Direction / notes:\n${bodyForAi}\n\n─────\n\nDrafted content (integrate this into the document):\n${aiResponse}`;
            const updated = await buildDocument(env, {
              tag: effectiveTag, title,
              currentDoc: existing?.content || '',
              newMaterial, command: docCmd,
              authorName: contactId, language: contact?.language,
            });
            if (updated) {
              const note = changeNoteFor(docCmd, (existing?.content || '').length, updated.length);
              docVersion = await saveDocument(env.DB, { contactId, tag: effectiveTag, title, content: updated, changeNote: note, messageId: msg.id });
              console.log(`governing doc "${contactId}/${effectiveTag}" → v${docVersion} (${note})`);
            }
          } catch (docErr) {
            console.error(`doc build failed for "${contactId}/${effectiveTag}": ${docErr.message}`);
          }
        }

        results.push({ id: msg.id, status: 'generated', contact: contactId, parts: outboundParts.length, chars: aiResponse.length, docVersion });
        console.log(`response queued for msg ${msg.id} (${outboundParts.length} parts, ${finalResponse.length} chars)`);
      } else {
        results.push({ id: msg.id, status: 'no_response' });
        await setState(env.DB, 'last_error', `AI returned empty for msg ${msg.id} at ${new Date().toISOString()}`);
      }
    } catch (genErr) {
      console.error(`generation error for message ${msg.id}: ${genErr.message}`);
      results.push({ id: msg.id, status: 'error', error: genErr.message });
      await setState(env.DB, 'last_error', `generation failed for msg ${msg.id}: ${genErr.message} at ${new Date().toISOString()}`);
    }
  }

  console.log(`=== GENERATE DONE: ${generated} new responses queued ===`);
  return { success: true, generated, total: pending.length, results };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3: SEND — browser sends drafts, verifies, marks confirmed
// ═══════════════════════════════════════════════════════════════
async function phaseSend(env) {
  console.log('=== PHASE 3: SEND ===');
  const pendingParts = await getPendingParts(env.DB, MAX_SENDS_PER_CYCLE);

  // Skip queue items whose inbound is already responded — EXCEPT legitimate
  // later parts of the same multi-part response. When part 1 sends it marks the
  // inbound responded; if part 2 is retried on a later cron the inbound reads
  // "responded", but part 2 is not stale — it's the rest of the same message.
  // A part is stale only if the inbound is responded AND this is part 1 (or a
  // single part), i.e. no earlier part of this group already went out.
  const validParts = [];
  for (const qp of pendingParts) {
    if (qp.inbound_id) {
      const inbound = await env.DB.prepare("SELECT responded_at FROM messages WHERE id = ?").bind(qp.inbound_id).first();
      const responded = inbound && inbound.responded_at && inbound.responded_at !== 'series_collecting';
      if (responded) {
        // is there an already-sent earlier part in this same queue group? if so,
        // this is a legitimate continuation, not a stale duplicate.
        const priorSent = await env.DB.prepare(
          "SELECT id FROM send_queue WHERE inbound_id = ? AND status = 'sent' AND part_num < ? LIMIT 1"
        ).bind(qp.inbound_id, qp.part_num).first();
        if (!priorSent) {
          console.log(`skipping stale queue #${qp.id}: inbound ${qp.inbound_id} already responded (${inbound.responded_at}), no prior part sent`);
          await env.DB.prepare("UPDATE send_queue SET status = 'skipped' WHERE id = ?").bind(qp.id).run();
          continue;
        }
        console.log(`queue #${qp.id} part ${qp.part_num}/${qp.total_parts}: continuation of already-sent part, allowing`);
      }
    }
    validParts.push(qp);
  }

  const standaloneJson = await getState(env.DB, 'standalone_outbound');
  const hasStandalone = standaloneJson && standaloneJson.length > 2;

  if (validParts.length === 0 && !hasStandalone) {
    console.log('no pending sends');
    return { success: true, sent: 0, message: 'nothing to send' };
  }

  console.log(`${validParts.length} queue parts to send${hasStandalone ? ' + 1 standalone' : ''}`);
  const browser = await puppeteer.launch(env.BROWSER);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const loggedIn = await loginToSecurus(page, env);
    if (!loggedIn) {
      return { success: false, error: 'Login failed' };
    }

    let sent = 0;
    let lastKnownStamps = null;
    const results = [];
    const contacts = await getContacts(env.DB);
    // Resolve a queue part's recipient. Returns null when the recipient can't
    // be confidently resolved — NEVER falls back to another contact's id, since
    // a wrong-recipient send is unrecoverable.
    const recipientFor = (qp) => {
      const cid = qp.contact_id || DEFAULT_CONTACT;
      const c = contacts.find(x => x.id === cid);
      const securusId = qp.securus_id || c?.securus_id;
      if (!securusId || !c?.name) return null;
      return { contactId: cid, securusId, name: c.name };
    };

    if (hasStandalone) {
      const standalone = JSON.parse(standaloneJson);
      console.log(`sending standalone: "${standalone.subject}"`);
      const stdContact = contacts.find(x => x.id === (standalone.contactId || 'sam'));
      const sendResult = await composeAndSend(page, {
        contactId: standalone.securusId || stdContact?.securus_id || env.SAM_CONTACT_ID,
        contactName: stdContact?.name || null,
        subject: standalone.subject,
        body: standalone.body,
      });
      if (sendResult.success) {
        const outId = await saveMessage(env.DB, {
          direction: 'outbound',
          sender: 'DENNIS HANSON',
          subject: standalone.subject,
          body: standalone.body,
          timestamp: new Date().toISOString(),
        });
        await incrementCounter(env.DB, 'total_messages_sent');
        await markConfirmedSent(env.DB, outId);
        await setState(env.DB, 'standalone_outbound', '');
        if (sendResult.stampBalance !== null && sendResult.stampBalance !== undefined) {
          lastKnownStamps = sendResult.stampBalance - 1;
        }
        results.push({ type: 'standalone', status: 'sent_confirmed' });
        console.log('standalone sent and confirmed');
      } else {
        results.push({ type: 'standalone', status: 'failed', error: sendResult.error });
      }
    }

    for (const qp of validParts) {
      const rcpt = recipientFor(qp);
      if (!rcpt) {
        await markPartFailed(env.DB, qp.id, `recipient unresolvable for contact "${qp.contact_id}" — refusing to guess`);
        results.push({ queueId: qp.id, part: `${qp.part_num}/${qp.total_parts}`, status: 'failed', error: 'recipient unresolvable' });
        console.log(`queue #${qp.id}: recipient unresolvable (contact ${qp.contact_id}) — skipped, will not guess`);
        continue;
      }
      console.log(`sending queue #${qp.id}: part ${qp.part_num}/${qp.total_parts} for inbound ${qp.inbound_id} → ${rcpt.contactId} (${rcpt.securusId})`);

      const sendResult = await composeAndSend(page, {
        contactId: rcpt.securusId,
        contactName: rcpt.name,
        subject: qp.subject,
        body: qp.body,
      });

      if (sendResult.success) {
        const outboundId = await saveMessage(env.DB, {
          direction: 'outbound',
          contactId: rcpt.contactId,
          sender: 'DENNIS HANSON',
          subject: qp.subject,
          body: qp.body,
          timestamp: new Date().toISOString(),
          docTag: qp.doc_tag || null,
        });
        await incrementCounter(env.DB, 'total_messages_sent');
        await markConfirmedSent(env.DB, outboundId);
        await markPartSent(env.DB, qp.id, outboundId);

        // after part 1: mark inbound responded so it's never re-generated
        if (qp.part_num === 1 && qp.inbound_id) {
          await markResponded(env.DB, qp.inbound_id, outboundId);
          if (qp.series_id) {
            const seriesMsgParts = await getSeriesParts(env.DB, qp.series_id);
            for (const sp of seriesMsgParts) {
              await markResponded(env.DB, sp.message_id, outboundId);
            }
          }
        }

        sent++;
        if (sendResult.stampBalance !== null && sendResult.stampBalance !== undefined) {
          lastKnownStamps = sendResult.stampBalance - 1; // we just used one
        }
        results.push({ queueId: qp.id, part: `${qp.part_num}/${qp.total_parts}`, status: 'sent', outboundId });
        console.log(`queue #${qp.id} sent successfully`);
      } else if (sendResult.insufficientStamps) {
        // out of stamps: leave part pending so it auto-sends next cycle after
        // stamps are purchased. Alert Dennis at most once per 24h.
        results.push({ queueId: qp.id, part: `${qp.part_num}/${qp.total_parts}`, status: 'blocked_no_stamps', error: sendResult.error });
        console.log(`queue #${qp.id} BLOCKED: out of stamps — leaving pending, stopping send phase`);
        const lastAlert = await getState(env.DB, 'stamps_alert_at');
        if (!lastAlert || (Date.now() - new Date(lastAlert).getTime()) > 24 * 60 * 60 * 1000) {
          await notifyDennis(env, `securus-agent: OUT OF STAMPS — cannot send replies to Sam. Purchase stamps at securustech.online for the Colorado facility. Queued messages will send automatically once stamps are available.`);
          await setState(env.DB, 'stamps_alert_at', new Date().toISOString());
        }
        break;
      } else {
        const exhausted = await markPartFailed(env.DB, qp.id, sendResult.error || 'unknown');
        results.push({ queueId: qp.id, part: `${qp.part_num}/${qp.total_parts}`, status: exhausted ? 'failed_final' : 'failed_will_retry', error: sendResult.error });
        console.log(`queue #${qp.id} FAILED (${exhausted ? 'retries exhausted' : 'will retry'}): ${sendResult.error}`);
        // only page Dennis once the part has exhausted its automatic retries —
        // transient Securus hiccups retry silently on the next cron.
        if (exhausted) {
          await notifyDennis(env, `securus-agent: queue part ${qp.id} (inbound ${qp.inbound_id}) failed permanently after retries: ${sendResult.error}. Needs manual attention.`);
        }
      }
    }

    if (sent > 0) await setState(env.DB, 'stamps_alert_at', '');

    // track stamp balance and alert if low
    if (lastKnownStamps !== null) {
      await setState(env.DB, 'stamp_balance', String(lastKnownStamps));
      console.log(`stamp balance after sends: ${lastKnownStamps}`);

      const LOW_STAMP_THRESHOLD = 10;
      if (lastKnownStamps <= LOW_STAMP_THRESHOLD && lastKnownStamps > 0) {
        const lastLowAlert = await getState(env.DB, 'stamps_low_alert_at');
        const hoursSinceAlert = lastLowAlert ? (Date.now() - new Date(lastLowAlert).getTime()) / (1000 * 60 * 60) : Infinity;
        if (hoursSinceAlert >= 48) {
          const pendingCount = (await getQueueStatus(env.DB)).pending || 0;
          await notifyDennis(env, `securus-agent: LOW STAMPS — ${lastKnownStamps} stamps remaining${pendingCount > 0 ? `, ${pendingCount} messages still queued` : ''}. Purchase more at securustech.online for Colorado facility.`);
          await setState(env.DB, 'stamps_low_alert_at', new Date().toISOString());
          console.log(`low stamp alert sent (${lastKnownStamps} remaining)`);
        }
      }

      // auto-purchase stamps when low (guarded: disabled by default, hard caps,
      // every attempt logged + SMSed). The purchase path itself stays inert
      // until recon-verified selectors land in stamps.mjs.
      try {
        const abConfig = await getAutobuyConfig(env.DB);
        const guard = await autobuyGuard(env.DB, abConfig, lastKnownStamps);
        if (guard.allowed) {
          console.log(`stamp autobuy: triggering (${guard.reason})`);
          const result = await purchaseStamps(page, abConfig);
          await recordPurchaseAttempt(env.DB, { attempted: !result.notImplemented, balanceBefore: lastKnownStamps, ...result });
          if (result.notImplemented) {
            console.log('stamp autobuy: purchase path not yet implemented (awaiting recon-verified selectors)');
          } else {
            await notifyDennis(env, `securus-agent: STAMP AUTO-PURCHASE ${result.success ? 'COMPLETED' : 'FAILED'} — balance was ${lastKnownStamps}. ${result.note || ''}`);
          }
        } else if (abConfig.enabled) {
          console.log(`stamp autobuy: held (${guard.reason})`);
        }
      } catch (abErr) {
        console.error(`stamp autobuy error: ${abErr.message}`);
      }
    }

    await logout(page);
    console.log(`=== SEND DONE: ${sent} parts sent ===`);
    return { success: true, sent, total: validParts.length, results, stampBalance: lastKnownStamps };
  } catch (err) {
    console.error('send error:', err.message, err.stack);
    await setState(env.DB, 'last_error', `send: ${err.message} at ${new Date().toISOString()}`);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// ═══════════════════════════════════════════════════════════════
// CRON ORCHESTRATOR — runs all three phases sequentially
// ═══════════════════════════════════════════════════════════════
async function cronOrchestrator(env) {
  console.log('=== CRON ORCHESTRATOR START ===');
  const startTime = Date.now();
  const phaseResults = {};

  // Phase 1: SCAN
  try {
    phaseResults.scan = await phaseScan(env);
  } catch (err) {
    console.error('SCAN phase crashed:', err.message);
    phaseResults.scan = { success: false, error: err.message };
    await notifyDennis(env, `securus-agent SCAN failed: ${err.message}`);
  }

  // Phase 2: GENERATE
  try {
    phaseResults.generate = await phaseGenerate(env);
  } catch (err) {
    console.error('GENERATE phase crashed:', err.message);
    phaseResults.generate = { success: false, error: err.message };
    await notifyDennis(env, `securus-agent GENERATE failed: ${err.message}`);
  }

  // Phase 3: SEND (only if there are queued parts)
  const hasQueued = await hasPendingParts(env.DB);
  const standaloneJson = await getState(env.DB, 'standalone_outbound');
  const hasStandalone = standaloneJson && standaloneJson.length > 2;

  if (hasQueued || hasStandalone) {
    try {
      phaseResults.send = await phaseSend(env);
    } catch (err) {
      console.error('SEND phase crashed:', err.message);
      phaseResults.send = { success: false, error: err.message };
      await notifyDennis(env, `securus-agent SEND failed: ${err.message}`);
    }
  } else {
    phaseResults.send = { skipped: true, reason: 'no drafts ready' };
  }

  // update conversation logs if anything changed
  const scanNew = phaseResults.scan?.newMessages || 0;
  const sendCount = phaseResults.send?.sent || 0;
  if (scanNew > 0 || sendCount > 0) {
    try {
      const mdAll = await generateConversationMarkdown(env.DB, 'all');
      await setState(env.DB, 'conversation_md_all', mdAll);
      const activeTags = await getAllDocTags(env.DB);
      for (const tag of activeTags) {
        const mdTag = await generateConversationMarkdown(env.DB, tag);
        await setState(env.DB, `conversation_md_${tag}`, mdTag);
      }
      console.log(`conversation markdowns updated (${activeTags.length} topic docs)`);
    } catch (err) {
      console.error('markdown update failed:', err.message);
    }
  }

  await setState(env.DB, 'last_check', new Date().toISOString());
  await incrementCounter(env.DB, 'total_checks');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`=== CRON DONE in ${elapsed}s: scan=${scanNew} new, gen=${phaseResults.generate?.generated || 0}, sent=${sendCount} ===`);
  return { success: true, elapsed, phases: phaseResults };
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION MARKDOWN GENERATOR
// ═══════════════════════════════════════════════════════════════
async function generateConversationMarkdown(db, docTag) {
  let messages;
  if (docTag === 'all' || docTag === undefined) {
    messages = (await db.prepare(
      'SELECT id, external_id, direction, sender, subject, body, timestamp, responded_at, response_id, doc_tag, confirmed_sent FROM messages ORDER BY id ASC'
    ).all()).results;
  } else if (docTag === null) {
    messages = (await db.prepare(
      'SELECT id, external_id, direction, sender, subject, body, timestamp, responded_at, response_id, doc_tag, confirmed_sent FROM messages WHERE doc_tag IS NULL ORDER BY id ASC'
    ).all()).results;
  } else {
    messages = (await db.prepare(
      'SELECT id, external_id, direction, sender, subject, body, timestamp, responded_at, response_id, doc_tag, confirmed_sent FROM messages WHERE doc_tag = ? ORDER BY id ASC'
    ).bind(docTag).all()).results;
  }

  const inbound = messages.filter(m => m.direction === 'inbound');
  const outbound = messages.filter(m => m.direction === 'outbound');
  const outboundById = {};
  outbound.forEach(m => { outboundById[m.id] = m; });

  let exchanges = [];
  const processed = new Set();

  for (const m of outbound) {
    if (!inbound.some(i => i.response_id === m.id) && m.id === 1) {
      exchanges.push({ type: 'outbound_only', outbound: m });
      processed.add(m.id);
    }
  }

  const sortedInbound = [...inbound].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  for (const msg of sortedInbound) {
    if (processed.has(msg.id)) continue;
    processed.add(msg.id);
    const exchange = { type: 'exchange', inbound: msg };
    if (msg.response_id) {
      const resp = outboundById[msg.response_id];
      if (resp) {
        exchange.outbound = resp;
        processed.add(resp.id);
      }
    }
    exchanges.push(exchange);
  }

  for (const msg of outbound) {
    if (!processed.has(msg.id)) {
      exchanges.push({ type: 'outbound_only', outbound: msg });
      processed.add(msg.id);
    }
  }

  const dateRange = messages.length > 0
    ? `${messages[0].timestamp.split('T')[0]} to ${messages[messages.length - 1].timestamp.split('T')[0]}`
    : 'N/A';

  let title, description;
  if (docTag && docTag !== 'all') {
    const name = docTag.charAt(0).toUpperCase() + docTag.slice(1);
    title = `# ${name} — Project Notes`;
    description = `> Topic document for **${name}**. Contains all messages and research related to this project.`;
  } else if (docTag === null) {
    title = `# Conversation Log: Dennis & Sam`;
    description = `> General conversation history (messages not filed under a specific topic).`;
  } else {
    title = `# Conversation Log: Dennis & Sam`;
    description = `> Complete conversation history between Dennis (AI) and Sam (Samuel Mullikin).`;
  }

  let md = `${title}

${description}
> Another AI can search through this document to find prior context about any topic discussed.

**Total Messages:** ${messages.length}
**Inbound (Sam):** ${inbound.length}
**Outbound (Dennis/AI):** ${outbound.length}
**Date Range:** ${dateRange}

---

`;

  let exchangeNum = 0;
  for (const ex of exchanges) {
    exchangeNum++;

    if (ex.type === 'outbound_only') {
      const m = ex.outbound;
      const date = m.timestamp.split('T')[0];
      const confirmed = m.confirmed_sent ? ' ✓' : '';
      md += `## Exchange ${exchangeNum} | ${date}\n\n`;
      md += `### Dennis (Outbound${confirmed})\n`;
      md += `**Subject:** ${m.subject}  \n`;
      md += `**Date:** ${m.timestamp}  \n`;
      md += `\n${m.body}\n\n---\n\n`;
    } else {
      const inMsg = ex.inbound;
      const date = inMsg.timestamp.split('T')[0];
      md += `## Exchange ${exchangeNum} | ${date}\n\n`;
      md += `### Sam (Inbound)\n`;
      md += `**Subject:** ${inMsg.subject}  \n`;
      md += `**Date:** ${inMsg.timestamp}  \n`;
      if (inMsg.external_id) md += `**Message ID:** ${inMsg.external_id}  \n`;
      md += `\n${inMsg.body}\n\n`;

      if (ex.outbound) {
        const confirmed = ex.outbound.confirmed_sent ? ' ✓' : '';
        md += `### Dennis (Response${confirmed})\n`;
        md += `**Subject:** ${ex.outbound.subject}  \n`;
        md += `**Date:** ${ex.outbound.timestamp}  \n`;
        md += `\n${ex.outbound.body}\n\n`;
      } else {
        md += `### Dennis (Response)\n`;
        md += `*No response sent yet.*\n\n`;
      }
      md += `---\n\n`;
    }
  }

  if (docTag && docTag !== 'all' && docTag !== null) {
    const importKey = `${docTag}_import`;
    const imported = await getState(db, importKey);
    if (imported) {
      md += `\n\n---\n\n# Imported Content\n\n${imported}\n`;
    }
  }

  md += `\n*Last updated: ${new Date().toISOString()}*\n`;
  return md;
}

// ═══════════════════════════════════════════════════════════════
// WORKER EXPORT — HTTP endpoints + cron handler
// ═══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── Dashboard (read-only monitoring UI) ──────────────────────────────
    // Token gate: if DASH_TOKEN is set, require ?token= to match. If unset,
    // the dashboard is open (dev) — a banner alert notes this.
    const dashAuthed = () => !env.DASH_TOKEN || url.searchParams.get('token') === env.DASH_TOKEN;

    if (url.pathname === '/dashboard' || url.pathname === '/') {
      if (!dashAuthed()) {
        return new Response('Unauthorized — append ?token=YOUR_TOKEN', { status: 401 });
      }
      return new Response(renderDashboardHTML(env.DASH_TOKEN ? url.searchParams.get('token') : ''), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/api/dashboard') {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      try {
        const contactId = (url.searchParams.get('contact') || DEFAULT_CONTACT).toLowerCase();
        const data = await getDashboardData(env, contactId);
        return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
      } catch (err) {
        return Response.json({ error: err.message, stack: err.stack?.substring(0, 400) }, { status: 500 });
      }
    }

    // governing document body + version history for a (contact, topic)
    if (url.pathname.startsWith('/api/document/')) {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const tag = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!tag) return Response.json({ error: 'no tag' }, { status: 400 });
      const contactId = (url.searchParams.get('contact') || DEFAULT_CONTACT).toLowerCase();
      const doc = await getDocument(env.DB, contactId, tag);
      const versions = await getDocumentVersions(env.DB, contactId, tag);
      return Response.json({ tag, contactId, doc: doc || null, versions }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // full text of one message, fetched on demand when a history entry is tapped
    if (url.pathname.startsWith('/api/message/')) {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const id = parseInt(url.pathname.split('/')[3], 10);
      if (isNaN(id)) return Response.json({ error: 'invalid id' }, { status: 400 });
      const row = await env.DB.prepare(
        "SELECT id, direction, subject, body, substr(timestamp,1,16) as ts, doc_tag FROM messages WHERE id = ?"
      ).bind(id).first();
      if (!row) return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json(row, { headers: { 'Cache-Control': 'no-store' } });
    }

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

    // trigger full cron loop (all 3 phases)
    if (url.pathname === '/check' || url.pathname === '/cron') {
      ctx.waitUntil(cronOrchestrator(env));
      return Response.json({ triggered: true, message: 'cron orchestrator started (scan → generate → send)', ts: new Date().toISOString() });
    }

    // individual phase triggers
    if (url.pathname === '/scan') {
      ctx.waitUntil(phaseScan(env));
      return Response.json({ triggered: true, phase: 'scan', ts: new Date().toISOString() });
    }

    // /deep-scan — enumerate ALL inbox pages, compare with D1, report missing
    // runs synchronously (no ctx.waitUntil) — enumeration only, no message opening
    if (url.pathname === '/deep-scan') {
      let browser;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        const loggedIn = await loginToSecurus(page, env);
        if (!loggedIn) {
          await browser.close();
          return Response.json({ success: false, error: 'Login failed' });
        }

        await navigateToInbox(page);
        const allMessages = await enumerateAllPages(page);
        const samMessages = findSamMessages(allMessages);

        const dbMessages = (await env.DB.prepare("SELECT external_id, subject FROM messages WHERE direction = 'inbound'").all()).results;
        const dbSubjects = new Set(dbMessages.map(m => (m.subject || '').substring(0, 40)));

        const missing = [];
        const known = [];
        for (const msg of samMessages) {
          const subjectPrefix = (msg.subject || '').substring(0, 40);
          if (dbSubjects.has(subjectPrefix)) {
            known.push({ page: msg.page, index: msg.index, subject: msg.subject?.substring(0, 60), date: msg.date });
          } else {
            missing.push({ page: msg.page, index: msg.index, subject: msg.subject?.substring(0, 60), date: msg.date, isUnread: msg.isUnread });
          }
        }

        await setState(env.DB, 'deep_scan_result', JSON.stringify({
          status: 'enumerated', totalInbox: allMessages.length, samMessages: samMessages.length,
          pages: allMessages.length > 0 ? (allMessages[allMessages.length - 1].page || 1) : 0,
          known: known.length, potentiallyMissing: missing.length, missingMessages: missing,
          ts: new Date().toISOString(),
        }));

        await logout(page);
        await browser.close();
        return Response.json({
          success: true, totalInbox: allMessages.length, samMessages: samMessages.length,
          pages: allMessages.length > 0 ? (allMessages[allMessages.length - 1].page || 1) : 0,
          known: known.length, potentiallyMissing: missing.length, missingMessages: missing,
        });
      } catch (err) {
        if (browser) await browser.close().catch(() => {});
        return Response.json({ success: false, error: err.message, stack: err.stack?.substring(0, 500) });
      }
    }

    // /deep-scan-open/{page} — open and save missing messages on a specific inbox page
    if (url.pathname.startsWith('/deep-scan-open/')) {
      const targetPage = parseInt(url.pathname.split('/')[2], 10);
      if (isNaN(targetPage)) return Response.json({ success: false, error: 'invalid page number' });

      let browser;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        const loggedIn = await loginToSecurus(page, env);
        if (!loggedIn) {
          await browser.close();
          return Response.json({ success: false, error: 'Login failed' });
        }

        const existingExternalIds = new Set();
        const dbMessages = (await env.DB.prepare("SELECT external_id FROM messages WHERE direction = 'inbound'").all()).results;
        dbMessages.forEach(m => { if (m.external_id) existingExternalIds.add(m.external_id); });

        await navigateToInbox(page);

        // navigate to target page
        if (targetPage > 1) {
          for (let p = 1; p < targetPage; p++) {
            const clicked = await page.evaluate(() => {
              const links = [...document.querySelectorAll('a')];
              const nextLink = links.find(a => {
                const text = (a.textContent?.trim() || '').toLowerCase();
                return text === '>' || text.startsWith('next') || text === '›' ||
                       (a.getAttribute('aria-label') || '').toLowerCase().includes('next');
              });
              if (nextLink) { nextLink.click(); return true; }
              return false;
            });
            if (!clicked) {
              await logout(page);
              await browser.close();
              return Response.json({ success: false, error: `could not navigate to page ${p + 1}` });
            }
            await humanDelay(2000, 3000);
            await page.waitForSelector('table tbody tr', { visible: true, timeout: 15000 }).catch(() => {});
          }
        }

        const pageMessages = await enumerateMessages(page);
        const samMessages = findSamMessages(pageMessages);
        const results = [];

        for (const msg of samMessages) {
          const messageId = await openMessage(page, msg.index);
          if (!messageId) {
            results.push({ subject: msg.subject, status: 'no_messageId' });
            await navigateBackToInbox(page);
            // re-navigate to target page
            if (targetPage > 1) {
              for (let p = 1; p < targetPage; p++) {
                await page.evaluate(() => {
                  const links = [...document.querySelectorAll('a')];
                  const nl = links.find(a => (a.textContent?.trim() || '').toLowerCase().startsWith('next'));
                  if (nl) nl.click();
                });
                await humanDelay(2000, 3000);
                await page.waitForSelector('table tbody tr', { visible: true, timeout: 15000 }).catch(() => {});
              }
            }
            continue;
          }

          if (existingExternalIds.has(messageId)) {
            results.push({ subject: msg.subject, messageId, status: 'already_in_d1' });
          } else {
            const { sender, body } = await extractMessage(page);
            const { command: docCmd, docTag } = parseDocCommand(body);
            const newMsgId = await saveMessage(env.DB, {
              externalId: messageId,
              direction: 'inbound',
              sender: sender || 'SAMUEL MULLIKIN',
              subject: msg.subject,
              body: body || '',
              timestamp: new Date().toISOString(),
              docTag: docTag || null,
            });
            existingExternalIds.add(messageId);

            const seriesInfo = detectSeriesIndicator(body);
            if (seriesInfo) {
              const series = await getOrCreateSeries(env.DB, {
                seriesKey: seriesInfo.seriesKey, totalParts: seriesInfo.totalParts,
                docTag: docTag || null, docCommand: docCmd || null,
              });
              await addSeriesPart(env.DB, { seriesId: series.id, partNum: seriesInfo.partNum, messageId: newMsgId });
              await env.DB.prepare("UPDATE messages SET responded_at = 'series_collecting' WHERE id = ?").bind(newMsgId).run();
              await checkSeriesComplete(env.DB, series.id);
            }

            results.push({ subject: msg.subject, messageId, status: 'saved', d1Id: newMsgId, bodyLen: body?.length });
          }

          await navigateBackToInbox(page);
          if (targetPage > 1) {
            for (let p = 1; p < targetPage; p++) {
              await page.evaluate(() => {
                const links = [...document.querySelectorAll('a')];
                const nl = links.find(a => (a.textContent?.trim() || '').toLowerCase().startsWith('next'));
                if (nl) nl.click();
              });
              await humanDelay(2000, 3000);
              await page.waitForSelector('table tbody tr', { visible: true, timeout: 15000 }).catch(() => {});
            }
          }
        }

        await logout(page);
        await browser.close();
        const saved = results.filter(r => r.status === 'saved').length;
        return Response.json({ success: true, page: targetPage, totalOnPage: samMessages.length, saved, results });
      } catch (err) {
        if (browser) await browser.close().catch(() => {});
        return Response.json({ success: false, error: err.message, stack: err.stack?.substring(0, 500) });
      }
    }

    // /inbox-info — quick diagnostic: read inbox structure, pagination, unread count
    if (url.pathname === '/inbox-info') {
      let browser;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        const loggedIn = await loginToSecurus(page, env);
        if (!loggedIn) {
          await browser.close();
          return Response.json({ success: false, error: 'Login failed' });
        }

        await navigateToInbox(page);

        const inboxInfo = await page.evaluate(() => {
          const bodyText = document.body?.innerText?.substring(0, 5000) || '';
          const allLinks = [...document.querySelectorAll('a')].map(a => ({
            text: a.textContent?.trim()?.substring(0, 50),
            href: a.href,
          }));
          const paginationLinks = allLinks.filter(a => /^\d+$/.test(a.text) || a.text === '>' || a.text === '<' || a.text?.toLowerCase().includes('next') || a.text?.toLowerCase().includes('prev'));
          const rows = document.querySelectorAll('table tbody tr');
          const messages = [...rows].map((row, i) => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 3) return null;
            const sender = cells[0]?.textContent?.trim() || '';
            const subjectEl = cells[1]?.querySelector('.hide-for-small-only');
            const subject = subjectEl ? subjectEl.textContent?.trim() : cells[1]?.textContent?.trim() || '';
            const date = cells[2]?.textContent?.trim() || '';
            const isUnread = row.classList.contains('font-bold');
            return { index: i, sender, subject: subject.substring(0, 60), date, isUnread };
          }).filter(Boolean);

          const navBadge = document.querySelector('a[href*="inbox"] .badge, a[href*="inbox"] span');
          const unreadBadge = navBadge?.textContent?.trim() || null;

          return {
            url: window.location.href,
            messageCount: messages.length,
            messages,
            paginationLinks,
            unreadBadge,
            bodySnippet: bodyText.substring(0, 1000),
          };
        });

        await logout(page);
        await browser.close();
        return Response.json({ success: true, ...inboxInfo });
      } catch (err) {
        if (browser) await browser.close().catch(() => {});
        return Response.json({ success: false, error: err.message });
      }
    }

    // /discover-contacts — log in, open compose, dump the recipient dropdown.
    // Used when onboarding a new contact: the dropdown value is the securus_id
    // the send path needs (the DOC number is NOT it).
    if (url.pathname === '/discover-contacts') {
      let browser;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        const loggedIn = await loginToSecurus(page, env);
        if (!loggedIn) {
          await browser.close();
          return Response.json({ success: false, error: 'Login failed' });
        }
        await page.goto(urls.compose, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
        await acceptPendingTerms(page).catch(() => {});
        await page.waitForSelector(composeSel.contactDropdown, { visible: true, timeout: 20000 });
        const options = await page.evaluate((sel) => {
          const dd = document.querySelector(sel);
          return dd ? [...dd.options].map(o => ({ value: o.value, text: (o.textContent || '').trim() })) : [];
        }, composeSel.contactDropdown);
        await logout(page).catch(() => {});
        await browser.close();
        const registered = await getContacts(env.DB);
        return Response.json({
          success: true,
          dropdown: options.filter(o => o.value),
          registered: registered.map(c => ({ id: c.id, securus_id: c.securus_id, name: c.name })),
        });
      } catch (err) {
        if (browser) await browser.close().catch(() => {});
        return Response.json({ success: false, error: err.message });
      }
    }

    // /login-debug — attempt login, capture page state after submit (URL, errors, body text)
    if (url.pathname === '/login-debug') {
      let browser;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        const loggedIn = await loginToSecurus(page, env);

        const pageState = await page.evaluate(() => {
          const errorEls = [...document.querySelectorAll('.alert, .error, .callout, [class*="error"], [class*="alert"], [role="alert"]')]
            .map(el => el.textContent?.trim())
            .filter(t => t && t.length > 0 && t.length < 500);
          const emailField = document.querySelector('input[type="email"]');
          const passField = document.querySelector('input[type="password"]');
          const hasCaptcha = !!document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], [class*="captcha"], #captcha');
          return {
            url: window.location.href,
            title: document.title,
            errorMessages: errorEls,
            loginFormStillPresent: !!(emailField && passField),
            emailFieldValue: emailField?.value?.substring(0, 5) || null,
            hasCaptcha,
            buttons: [...document.querySelectorAll('button, input[type="submit"], a.button')].map(b => ({
              text: (b.textContent || b.value || '').trim().substring(0, 60),
              cls: (b.className || '').substring(0, 80),
              visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length),
              disabled: b.disabled || false,
            })).filter(b => b.text),
            modals: [...document.querySelectorAll('.reveal-overlay, .reveal, [class*="modal"]')].map(m => ({
              cls: (m.className || '').substring(0, 80),
              visible: !!(m.offsetWidth || m.offsetHeight),
              textStart: (m.innerText || '').substring(0, 300),
              checkboxes: [...m.querySelectorAll('input[type="checkbox"]')].length,
              buttons: [...m.querySelectorAll('button, a.button')].map(b => (b.textContent || '').trim().substring(0, 60)).filter(Boolean),
            })),
            bodyText: document.body?.innerText?.substring(0, 1500) || '',
          };
        });

        await browser.close();
        return Response.json({ loggedIn, ...pageState });
      } catch (err) {
        if (browser) await browser.close().catch(() => {});
        return Response.json({ success: false, error: err.message, stack: err.stack?.substring(0, 500) });
      }
    }

    if (url.pathname === '/deep-scan-results') {
      const result = await getState(env.DB, 'deep_scan_result');
      if (!result) return Response.json({ status: 'no results yet — run /deep-scan first' });
      return Response.json(JSON.parse(result));
    }

    if (url.pathname === '/generate') {
      const result = await phaseGenerate(env);
      return Response.json(result);
    }

    if (url.pathname === '/send') {
      try {
        const result = await phaseSend(env);
        return Response.json(result);
      } catch (err) {
        return Response.json({ success: false, error: err.message, stack: err.stack?.substring(0, 500) });
      }
    }

    // /send-one/{id} — send pending queue parts for an inbound message id
    if (url.pathname.startsWith('/send-one/')) {
      const msgId = parseInt(url.pathname.split('/')[2], 10);
      if (isNaN(msgId)) return Response.json({ success: false, error: 'invalid id' });

      // pick up both pending and failed parts — /send-one is the manual recovery
      // path, so it should retry a failed part regardless of backoff/retry count.
      const parts = (await env.DB.prepare(
        "SELECT * FROM send_queue WHERE inbound_id = ? AND status IN ('pending','failed') ORDER BY part_num ASC"
      ).bind(msgId).all()).results;
      if (parts.length === 0) return Response.json({ success: false, error: `no pending or failed queue parts for inbound ${msgId}` });

      let browser;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        const loggedIn = await loginToSecurus(page, env);
        if (!loggedIn) {
          await browser.close();
          return Response.json({ success: false, error: 'Login failed' });
        }

        const sendContacts = await getContacts(env.DB);
        const results = [];
        for (const qp of parts) {
          const c = sendContacts.find(x => x.id === (qp.contact_id || 'sam'));
          const securusId = qp.securus_id || c?.securus_id;
          if (!securusId || !c?.name) {
            // never guess a recipient — a wrong-inmate send is unrecoverable
            results.push({ queueId: qp.id, part: `${qp.part_num}/${qp.total_parts}`, success: false, error: `recipient unresolvable for contact "${qp.contact_id}"` });
            break;
          }
          const sendResult = await composeAndSend(page, {
            contactId: securusId,
            contactName: c.name,
            subject: qp.subject,
            body: qp.body,
          });
          results.push({ queueId: qp.id, part: `${qp.part_num}/${qp.total_parts}`, contact: qp.contact_id || 'sam', subject: qp.subject, bodyLen: qp.body.length, ...sendResult });

          if (sendResult.success) {
            const outboundId = await saveMessage(env.DB, {
              direction: 'outbound',
              contactId: qp.contact_id || 'sam',
              sender: 'DENNIS HANSON',
              subject: qp.subject,
              body: qp.body,
              timestamp: new Date().toISOString(),
              docTag: qp.doc_tag || null,
            });
            await incrementCounter(env.DB, 'total_messages_sent');
            await markConfirmedSent(env.DB, outboundId);
            await markPartSent(env.DB, qp.id, outboundId);
            if (sendResult.stampBalance !== null && sendResult.stampBalance !== undefined) {
              await setState(env.DB, 'stamp_balance', String(sendResult.stampBalance - 1));
            }

            if (qp.part_num === 1 && qp.inbound_id) {
              await markResponded(env.DB, qp.inbound_id, outboundId);
              if (qp.series_id) {
                const seriesMsgParts = await getSeriesParts(env.DB, qp.series_id);
                for (const sp of seriesMsgParts) {
                  await markResponded(env.DB, sp.message_id, outboundId);
                }
              }
            }
          } else {
            await markPartFailed(env.DB, qp.id, sendResult.error || 'unknown');
            break;
          }
        }

        await logout(page);
        await browser.close();
        return Response.json({ success: results.every(r => r.success), msgId, results });
      } catch (err) {
        if (browser) await browser.close().catch(() => {});
        return Response.json({ success: false, error: err.message, stack: err.stack?.substring(0, 500) });
      }
    }

    // /stamp-autobuy — GET: config + guard status + purchase log + recon state.
    // POST {enabled, lowWater, packPreference, maxPerDay, maxPerWeek}: update config.
    if (url.pathname === '/stamp-autobuy') {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (request.method === 'POST') {
        const body = await request.json();
        const current = await getAutobuyConfig(env.DB);
        const updated = { ...current };
        for (const k of Object.keys(AUTOBUY_DEFAULTS)) if (k in body) updated[k] = body[k];
        await setState(env.DB, 'stamp_autobuy', JSON.stringify(updated));
        return Response.json({ success: true, config: updated });
      }
      const config = await getAutobuyConfig(env.DB);
      const balance = parseInt(await getState(env.DB, 'stamp_balance') || '', 10);
      const guard = await autobuyGuard(env.DB, config, Number.isNaN(balance) ? null : balance);
      const recon = await getState(env.DB, 'stamp_purchase_recon');
      return Response.json({
        config, balance: Number.isNaN(balance) ? null : balance, guard,
        purchaseLog: await getPurchaseLog(env.DB),
        recon: recon ? JSON.parse(recon) : null,
        implemented: false,
        note: 'purchase click-path pending recon-verified selectors; flipping enabled=true arms the guard but nothing buys until implementation lands',
      });
    }

    // /queue-send — queue a standalone outbound message
    if (url.pathname === '/queue-send') {
      if (request.method === 'POST') {
        const { subject, body } = await request.json();
        await setState(env.DB, 'standalone_outbound', JSON.stringify({ subject, body, queuedAt: new Date().toISOString() }));
        return Response.json({ success: true, message: 'queued for next send phase' });
      }
      return Response.json({ success: false, error: 'POST required with { subject, body }' });
    }

    // /send-to/{contact} — POST {subject, body}: queue an outbound message to a
    // specific contact (routed to THAT contact's Securus id, verified by name at
    // compose). Used to onboard / message a contact directly. Splits if long.
    if (url.pathname.startsWith('/send-to/')) {
      if (request.method !== 'POST') return Response.json({ success: false, error: 'POST required with { subject, body }' });
      const contactId = decodeURIComponent(url.pathname.split('/')[2] || '').toLowerCase();
      const contact = await getContact(env.DB, contactId);
      if (!contact) return Response.json({ success: false, error: `unknown contact "${contactId}"` });
      const { subject, body, docTag } = await request.json();
      if (!subject || !body) return Response.json({ success: false, error: 'subject and body required' });
      const parts = splitForSend(subject, body);
      await queueOutboundParts(env.DB, { inboundId: null, seriesId: null, parts, docTag: docTag || null, contactId, securusId: contact.securus_id });
      return Response.json({ success: true, contact: contactId, name: contact.name, securusId: contact.securus_id, parts: parts.length, note: 'queued — will send on next /send or cron' });
    }

    // /fix-dupes — find inbound messages that have outbound responses but aren't marked responded
    if (url.pathname === '/fix-dupes') {
      const unresponded = await getUnrespondedInbound(env.DB);
      const fixed = [];
      for (const msg of unresponded) {
        const replySubj = makeReplySubject(msg.subject);
        // same rule as phaseGenerate: a reply must postdate the message
        const outbound = await env.DB.prepare(
          "SELECT id, subject, timestamp FROM messages WHERE direction = 'outbound' AND contact_id = ? AND subject = ? AND timestamp >= ? ORDER BY id ASC LIMIT 1"
        ).bind(msg.contact_id || DEFAULT_CONTACT, replySubj, msg.timestamp).first();
        if (outbound) {
          await markResponded(env.DB, msg.id, outbound.id);
          await setState(env.DB, `draft_${msg.id}`, '');
          fixed.push({ inboundId: msg.id, inboundSubject: msg.subject, outboundId: outbound.id });
        }
      }
      // count duplicate outbound messages
      const dupes = (await env.DB.prepare(
        "SELECT subject, COUNT(*) as cnt FROM messages WHERE direction = 'outbound' GROUP BY subject HAVING cnt > 1"
      ).all()).results;
      return Response.json({ success: true, fixed, duplicateSubjects: dupes, unrespondedBefore: unresponded.length, fixedCount: fixed.length });
    }

    // /resend/{id} — reset a message for re-generation and re-send
    if (url.pathname.startsWith('/resend/')) {
      const msgId = parseInt(url.pathname.split('/')[2], 10);
      if (isNaN(msgId)) return Response.json({ success: false, error: 'invalid message id' });
      await resetResponse(env.DB, msgId);
      await setState(env.DB, `draft_${msgId}`, '');
      return Response.json({ success: true, message: `message ${msgId} reset — will re-generate and re-send` });
    }

    // /draft — view pending send queue (backwards compatible name)
    if (url.pathname === '/draft') {
      let pending = [];
      try { pending = await getPendingParts(env.DB, 20); } catch {}
      const grouped = {};
      for (const p of pending) {
        if (!grouped[p.inbound_id]) grouped[p.inbound_id] = [];
        grouped[p.inbound_id].push({
          queueId: p.id, part: `${p.part_num}/${p.total_parts}`,
          subject: p.subject, bodyLength: p.body.length,
          bodyPreview: p.body.substring(0, 200),
        });
      }
      return Response.json({ pendingQueue: grouped, totalPending: pending.length });
    }

    // /verify-sent — check sent folder
    if (url.pathname === '/verify-sent') {
      let browser;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        const loggedIn = await loginToSecurus(page, env);
        if (!loggedIn) {
          await browser.close();
          return Response.json({ success: false, error: 'Login failed' });
        }

        await safeGoto(page, urls.myAccount);
        await humanDelay(1500, 2500);
        await safeGoto(page, urls.sent);
        await humanDelay(3000, 4000);

        const sentPageState = await page.evaluate(() => {
          const allTables = document.querySelectorAll('table');
          const tableData = [...allTables].map((table, idx) => {
            const rows = [...table.querySelectorAll('tr')];
            return {
              tableIndex: idx,
              rowCount: rows.length,
              rows: rows.slice(0, 5).map(row => {
                const cells = [...row.querySelectorAll('td,th')];
                return cells.map(c => c.textContent?.trim()?.substring(0, 80) || '');
              }),
            };
          });
          return {
            url: window.location.href,
            hash: window.location.hash,
            title: document.title,
            bodyText: document.body?.innerText?.substring(0, 3000) || '',
            tableCount: allTables.length,
            tables: tableData,
            h1h2h3: [...document.querySelectorAll('h1,h2,h3,h4')].map(h => h.textContent?.trim()?.substring(0, 100)),
            links: [...document.querySelectorAll('a')].slice(0, 15).map(a => ({ href: a.href, text: a.textContent?.trim()?.substring(0, 60) })),
          };
        });

        await logout(page);
        await browser.close();
        return Response.json({ success: true, sentPageState });
      } catch (err) {
        if (browser) await browser.close().catch(() => {});
        return Response.json({ success: false, error: err.message });
      }
    }

    // /conversation — markdown history
    if (url.pathname === '/conversation') {
      const docParam = url.searchParams.get('doc');
      let filterTag;
      if (!docParam) filterTag = 'all';
      else if (docParam === 'general') filterTag = null;
      else filterTag = docParam.toLowerCase();
      const md = await generateConversationMarkdown(env.DB, filterTag);
      await setState(env.DB, `conversation_md_${docParam || 'all'}`, md);
      return new Response(md, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
    }

    // /rebuild-doc/{tag} — build the governing document for one topic from its
    // full message history (Sam's notes + Dennis's drafted replies), in one pass.
    if (url.pathname.startsWith('/rebuild-doc/')) {
      const tag = decodeURIComponent(url.pathname.split('/')[2] || '').toLowerCase();
      if (!tag) return Response.json({ success: false, error: 'no tag' });
      const contactId = (url.searchParams.get('contact') || DEFAULT_CONTACT).toLowerCase();
      try {
        const msgs = await getMessagesByDocTag(env.DB, contactId, tag);
        if (!msgs.length) return Response.json({ success: false, error: `no messages for ${contactId}/${tag}` });
        // compose the full exchange chronologically, capped for the model
        let material = '';
        for (const m of msgs) {
          const who = m.direction === 'inbound' ? 'Author' : 'Assistant';
          const { cleanBody } = parseDocCommand(m.body);
          material += `[${who}]\n${cleanBody || m.body}\n\n`;
        }
        const CAP = 160000;
        if (material.length > CAP) material = material.substring(material.length - CAP);
        const title = docTitle(tag);
        const rc = await getContact(env.DB, contactId);
        const content = await buildDocument(env, { tag, title, currentDoc: '', newMaterial: material, command: 'makenew', authorName: contactId, language: rc?.language });
        if (!content) return Response.json({ success: false, error: 'doc build returned empty' });
        const v = await saveDocument(env.DB, { contactId, tag, title, content, changeNote: `rebuilt from ${msgs.length} messages`, messageId: msgs[msgs.length - 1]?.id });
        return Response.json({ success: true, contactId, tag, version: v, chars: content.length, fromMessages: msgs.length });
      } catch (err) {
        return Response.json({ success: false, error: err.message });
      }
    }

    // /assemble-doc/{tag} — deterministic (no-AI) governing-doc build. Stitches
    // Dennis's drafted (outbound) content chronologically into one structured
    // document. Fast and timeout-proof — used to backfill large topics where a
    // single AI synthesis can't complete inside an HTTP request. Future
    // makeupdate cycles refine it via buildDocument.
    if (url.pathname.startsWith('/assemble-doc/')) {
      const tag = decodeURIComponent(url.pathname.split('/')[2] || '').toLowerCase();
      if (!tag) return Response.json({ success: false, error: 'no tag' });
      const contactId = (url.searchParams.get('contact') || DEFAULT_CONTACT).toLowerCase();
      try {
        const msgs = await getMessagesByDocTag(env.DB, contactId, tag);
        if (!msgs.length) return Response.json({ success: false, error: `no messages for ${contactId}/${tag}` });
        const title = docTitle(tag);
        let body = `# ${title}\n\n_Assembled from ${msgs.length} messages. This is a stitched draft — it will be refined into integrated prose on the next update._\n`;
        let n = 0;
        for (const m of msgs) {
          if (m.direction !== 'outbound') continue; // drafted content lives in Dennis's replies
          let text = m.body || '';
          // strip the doc-command acknowledgement prefix if present
          text = text.replace(/^(I've (started|updated|received)[^\n]*\n+)/i, '')
                     .replace(/^(Here's the full[^\n]*\n+)/i, '').trim();
          if (!text) continue;
          n++;
          const date = (m.timestamp || '').substring(0, 10);
          body += `\n\n---\n\n## Section ${n}${date ? ` · ${date}` : ''}\n\n${text}`;
        }
        const v = await saveDocument(env.DB, { contactId, tag, title, content: body, changeNote: `assembled (deterministic) from ${n} contributions`, messageId: msgs[msgs.length - 1]?.id });
        return Response.json({ success: true, contactId, tag, version: v, chars: body.length, sections: n });
      } catch (err) {
        return Response.json({ success: false, error: err.message });
      }
    }

    // /rebuild-docs?contact=sam — rebuild every topic for one contact (async)
    if (url.pathname === '/rebuild-docs') {
      const contactId = (url.searchParams.get('contact') || DEFAULT_CONTACT).toLowerCase();
      const tags = await getAllDocTags(env.DB, contactId);
      ctx.waitUntil((async () => {
        for (const tag of tags) {
          try {
            const msgs = await getMessagesByDocTag(env.DB, contactId, tag);
            if (!msgs.length) continue;
            let material = '';
            for (const m of msgs) {
              const who = m.direction === 'inbound' ? 'Author' : 'Assistant';
              const { cleanBody } = parseDocCommand(m.body);
              material += `[${who}]\n${cleanBody || m.body}\n\n`;
            }
            if (material.length > 160000) material = material.substring(material.length - 160000);
            const title = docTitle(tag);
            const rc = await getContact(env.DB, contactId);
            const content = await buildDocument(env, { tag, title, currentDoc: '', newMaterial: material, command: 'makenew', authorName: contactId, language: rc?.language });
            if (content) {
              await saveDocument(env.DB, { contactId, tag, title, content, changeNote: `rebuilt from ${msgs.length} messages`, messageId: msgs[msgs.length - 1]?.id });
              console.log(`rebuilt governing doc "${contactId}/${tag}" (${content.length} chars from ${msgs.length} msgs)`);
            }
          } catch (err) {
            console.error(`rebuild ${contactId}/${tag} failed: ${err.message}`);
          }
        }
        console.log('rebuild-docs complete');
      })());
      return Response.json({ success: true, triggered: true, contactId, tags, note: 'rebuilding in background — check /api/document/{tag}?contact= shortly' });
    }

    // /docs — list all topic documents
    if (url.pathname === '/docs') {
      const tags = await getAllDocTags(env.DB);
      const docs = [{ tag: 'general', description: 'Untagged conversation history', url: '/conversation?doc=general' }];
      for (const tag of tags) {
        docs.push({ tag, description: `${tag.charAt(0).toUpperCase() + tag.slice(1)} project notes`, url: `/conversation?doc=${tag}` });
      }
      docs.push({ tag: 'all', description: 'Complete history (all topics)', url: '/conversation' });
      return Response.json({ docs, totalTags: tags.length });
    }

    if (url.pathname === '/status') {
      const lastCheck = await getState(env.DB, 'last_check');
      const totalChecks = await getState(env.DB, 'total_checks');
      const totalSent = await getState(env.DB, 'total_messages_sent');
      const lastError = await getState(env.DB, 'last_error');
      const stampBalance = await getState(env.DB, 'stamp_balance');
      const recentMessages = await getRecentMessages(env.DB, 10);
      const unresponded = await getUnrespondedInbound(env.DB);
      const unconfirmed = await getUnconfirmedOutbound(env.DB);
      let queueStatus = { pending: 0, sent: 0, failed: 0 };
      try { queueStatus = await getQueueStatus(env.DB); } catch {}
      let seriesInfo = [];
      try { seriesInfo = await getSeriesStatus(env.DB); } catch {}

      return Response.json({
        lastCheck,
        totalChecks,
        totalMessagesSent: totalSent,
        lastError,
        stampBalance: stampBalance ? parseInt(stampBalance, 10) : null,
        usage: await getUsageSnapshot(env.DB).catch(() => null),
        queue: { unresponded: unresponded.length, sendQueue: queueStatus, unconfirmedOutbound: unconfirmed.length },
        series: seriesInfo,
        recentMessages,
      });
    }

    if (url.pathname === '/queue') {
      let queueStatus = { pending: 0, sent: 0, failed: 0 };
      try { queueStatus = await getQueueStatus(env.DB); } catch {}
      const pending = await getPendingParts(env.DB, 20);
      const failed = (await env.DB.prepare(
        "SELECT id, inbound_id, part_num, total_parts, subject, error, created_at FROM send_queue WHERE status = 'failed' ORDER BY id DESC LIMIT 10"
      ).all()).results;
      return Response.json({ counts: queueStatus, pending, failed });
    }

    if (url.pathname === '/series') {
      let seriesInfo = [];
      try { seriesInfo = await getSeriesStatus(env.DB); } catch {}
      return Response.json({ series: seriesInfo });
    }

    if (url.pathname === '/retry-failed') {
      const count = await resetFailedParts(env.DB);
      return Response.json({ success: true, resetCount: count });
    }

    if (url.pathname === '/migrate') {
      const migrations = [
        "ALTER TABLE messages ADD COLUMN confirmed_sent TEXT DEFAULT NULL",
        "ALTER TABLE send_queue ADD COLUMN retry_count INTEGER DEFAULT 0",
        "ALTER TABLE send_queue ADD COLUMN last_attempt_at TEXT",
        `CREATE TABLE IF NOT EXISTS documents (
          tag TEXT PRIMARY KEY, title TEXT, content TEXT NOT NULL DEFAULT '',
          version INTEGER NOT NULL DEFAULT 1, source_count INTEGER DEFAULT 0,
          last_message_id INTEGER,
          created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS document_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL, version INTEGER NOT NULL,
          content TEXT NOT NULL, change_note TEXT, message_id INTEGER,
          created_at TEXT DEFAULT (datetime('now')), UNIQUE(tag, version)
        )`,
        "CREATE INDEX IF NOT EXISTS idx_doc_versions_tag ON document_versions(tag)",
        `CREATE TABLE IF NOT EXISTS send_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT, inbound_id INTEGER, series_id INTEGER,
          part_num INTEGER NOT NULL, total_parts INTEGER NOT NULL,
          subject TEXT NOT NULL, body TEXT NOT NULL, doc_tag TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT DEFAULT (datetime('now')), sent_at TEXT,
          outbound_msg_id INTEGER, error TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS inbound_series (
          id INTEGER PRIMARY KEY AUTOINCREMENT, series_key TEXT NOT NULL UNIQUE,
          total_parts INTEGER NOT NULL, received_parts INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'collecting', doc_tag TEXT, doc_command TEXT,
          created_at TEXT DEFAULT (datetime('now')), completed_at TEXT, processed_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS inbound_series_parts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, series_id INTEGER NOT NULL,
          part_num INTEGER NOT NULL, message_id INTEGER NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (series_id) REFERENCES inbound_series(id),
          FOREIGN KEY (message_id) REFERENCES messages(id),
          UNIQUE(series_id, part_num)
        )`,
        "CREATE INDEX IF NOT EXISTS idx_send_queue_status ON send_queue(status)",
        "CREATE INDEX IF NOT EXISTS idx_send_queue_inbound ON send_queue(inbound_id)",
        "CREATE INDEX IF NOT EXISTS idx_inbound_series_status ON inbound_series(status)",
        "CREATE INDEX IF NOT EXISTS idx_series_parts_series ON inbound_series_parts(series_id)",
        // ── multi-tenant: contacts registry + contact_id scoping ──
        `CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY, securus_id TEXT, name TEXT, doc_number TEXT,
          language TEXT DEFAULT 'en', match_names TEXT, persona TEXT DEFAULT 'Dennis',
          active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
        )`,
        `INSERT OR IGNORE INTO contacts (id, securus_id, name, doc_number, language, match_names, persona) VALUES
          ('sam', '65651103', 'SAMUEL MULLIKIN', NULL, 'en', 'SAMUEL,MULLIKIN', 'Dennis')`,
        `INSERT OR IGNORE INTO contacts (id, securus_id, name, doc_number, language, match_names, persona) VALUES
          ('ricardo', '67887839', 'RICARDO CHALCHISEVILLA', '156419', 'es', 'RICARDO,CHALCHISEVILLA', 'Dennis')`,
        "ALTER TABLE messages ADD COLUMN contact_id TEXT NOT NULL DEFAULT 'sam'",
        "ALTER TABLE send_queue ADD COLUMN contact_id TEXT NOT NULL DEFAULT 'sam'",
        "ALTER TABLE send_queue ADD COLUMN securus_id TEXT",
        "ALTER TABLE inbound_series ADD COLUMN contact_id TEXT NOT NULL DEFAULT 'sam'",
        "CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id)",
        "CREATE INDEX IF NOT EXISTS idx_send_queue_contact ON send_queue(contact_id)",
      ];

      const migrationResults = [];
      for (const sql of migrations) {
        try {
          await env.DB.prepare(sql).run();
          migrationResults.push({ sql: sql.substring(0, 60), status: 'ok' });
        } catch (err) {
          if (err.message?.includes('duplicate column') || err.message?.includes('already exists')) {
            migrationResults.push({ sql: sql.substring(0, 60), status: 'already_exists' });
          } else {
            migrationResults.push({ sql: sql.substring(0, 60), status: 'error', error: err.message });
          }
        }
      }

      // Rebuild documents + document_versions with a composite (contact_id, tag)
      // key so each contact has an independent document per tag. SQLite can't
      // change a primary key in place, so we rebuild atomically. Guarded by the
      // presence of the contact_id column so it runs exactly once. All existing
      // rows are attributed to 'sam' (the only contact before this migration).
      try {
        const dcols = (await env.DB.prepare("PRAGMA table_info(documents)").all()).results.map(r => r.name);
        if (dcols.length && !dcols.includes('contact_id')) {
          await env.DB.batch([
            env.DB.prepare(`CREATE TABLE documents_v2 (
              contact_id TEXT NOT NULL DEFAULT 'sam', tag TEXT NOT NULL, title TEXT,
              content TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
              source_count INTEGER DEFAULT 0, last_message_id INTEGER,
              created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
              PRIMARY KEY (contact_id, tag))`),
            env.DB.prepare(`INSERT INTO documents_v2 (contact_id, tag, title, content, version, source_count, last_message_id, created_at, updated_at)
              SELECT 'sam', tag, title, content, version, source_count, last_message_id, created_at, updated_at FROM documents`),
            env.DB.prepare("DROP TABLE documents"),
            env.DB.prepare("ALTER TABLE documents_v2 RENAME TO documents"),
          ]);
          migrationResults.push({ sql: 'rebuild documents (contact_id, tag) PK', status: 'ok' });
        } else {
          migrationResults.push({ sql: 'rebuild documents', status: 'already_done' });
        }

        const vcols = (await env.DB.prepare("PRAGMA table_info(document_versions)").all()).results.map(r => r.name);
        if (vcols.length && !vcols.includes('contact_id')) {
          await env.DB.batch([
            env.DB.prepare(`CREATE TABLE document_versions_v2 (
              id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id TEXT NOT NULL DEFAULT 'sam', tag TEXT NOT NULL,
              version INTEGER NOT NULL, content TEXT NOT NULL, change_note TEXT, message_id INTEGER,
              created_at TEXT DEFAULT (datetime('now')), UNIQUE(contact_id, tag, version))`),
            env.DB.prepare(`INSERT INTO document_versions_v2 (contact_id, tag, version, content, change_note, message_id, created_at)
              SELECT 'sam', tag, version, content, change_note, message_id, created_at FROM document_versions`),
            env.DB.prepare("DROP TABLE document_versions"),
            env.DB.prepare("ALTER TABLE document_versions_v2 RENAME TO document_versions"),
            env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_doc_versions_tag ON document_versions(contact_id, tag)"),
          ]);
          migrationResults.push({ sql: 'rebuild document_versions (contact_id, tag, version)', status: 'ok' });
        } else {
          migrationResults.push({ sql: 'rebuild document_versions', status: 'already_done' });
        }
      } catch (err) {
        migrationResults.push({ sql: 'rebuild documents/versions', status: 'error', error: err.message });
      }

      // migrate existing drafts to send_queue
      let draftsMigrated = 0;
      try {
        const draftKeys = (await env.DB.prepare(
          "SELECT key, value FROM system_state WHERE key LIKE 'draft_%' AND length(value) > 2"
        ).all()).results;
        for (const row of draftKeys) {
          const msgId = parseInt(row.key.replace('draft_', ''), 10);
          if (isNaN(msgId)) continue;
          try {
            const draft = JSON.parse(row.value);
            if (draft.parts && draft.parts.length > 0) {
              await queueOutboundParts(env.DB, { inboundId: msgId, seriesId: null, parts: draft.parts, docTag: draft.docTag || null });
              await setState(env.DB, row.key, '');
              draftsMigrated++;
            }
          } catch {}
        }
      } catch {}

      // migrate batch_waiting to series_collecting
      try {
        await env.DB.prepare("UPDATE messages SET responded_at = 'series_collecting' WHERE responded_at = 'batch_waiting'").run();
      } catch {}

      // clear stale queue entries where inbound is already responded
      let staleCleaned = 0;
      try {
        const staleRows = (await env.DB.prepare(
          `SELECT sq.id FROM send_queue sq
           JOIN messages m ON sq.inbound_id = m.id
           WHERE sq.status = 'pending' AND m.responded_at IS NOT NULL AND m.responded_at != 'series_collecting'`
        ).all()).results;
        for (const row of staleRows) {
          await env.DB.prepare("UPDATE send_queue SET status = 'sent' WHERE id = ?").bind(row.id).run();
          staleCleaned++;
        }
      } catch {}

      return Response.json({ success: true, migrations: migrationResults, draftsMigrated, staleCleaned });
    }

    return Response.json({
      service: 'securus-agent',
      version: 'v5-dashboard',
      routes: ['/dashboard', '/api/dashboard', '/check', '/cron', '/scan', '/generate', '/send', '/send-one/{id}', '/verify-sent', '/resend/{id}', '/fix-dupes', '/queue', '/series', '/retry-failed', '/status', '/login-debug', '/draft', '/conversation', '/docs', '/migrate'],
    });
  },

  async scheduled(event, env, ctx) {
    const jitterMs = Math.floor(Math.random() * 30 * 1000);
    console.log(`cron triggered, jitter: ${jitterMs}ms`);
    await new Promise(resolve => setTimeout(resolve, jitterMs));
    ctx.waitUntil(cronOrchestrator(env));
  },
};

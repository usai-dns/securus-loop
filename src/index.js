// securus-agent cloudflare worker — three-phase cron architecture
// Phase 1: SCAN — browser reads inbox, saves to D1
// Phase 2: GENERATE — AI creates responses, saves drafts
// Phase 3: SEND — browser sends drafts, verifies in sent folder, marks confirmed
import puppeteer from '@cloudflare/puppeteer';
import { loginToSecurus, logout } from './securus/auth.mjs';
import { navigateToInbox, enumerateMessages, enumerateAllPages, findSamMessages } from './securus/inbox.mjs';
import { openMessage, extractMessage, navigateBackToInbox } from './securus/read.mjs';
import { composeAndSend } from './securus/compose.mjs';
import { urls } from './securus/selectors.mjs';
import { humanDelay, safeGoto } from './securus/helpers.mjs';
import { messageExists, getMessageByExternalId, saveMessage, markResponded, markConfirmedSent, getUnconfirmedOutbound, resetResponse, getRecentMessages, getUnrespondedInbound, getMessagesByDocTag, getAllDocTags, getAllMessages } from './db/messages.mjs';
import { parseDocCommand, docAcknowledgment } from './docs/commands.mjs';
import { getState, setState, incrementCounter } from './db/state.mjs';
import { notifyDennis } from './notify/sms.mjs';
import { generateResponse, splitForSend, shouldEscalate } from './ai/responder.mjs';
import { queueOutboundParts, getPendingParts, markPartSent, markPartFailed, getQueueStatus, hasPendingParts, hasQueuedForInbound, resetFailedParts } from './db/send_queue.mjs';
import { detectSeriesIndicator, stripSeriesIndicator, getOrCreateSeries, addSeriesPart, checkSeriesComplete, getCompleteSeries, getSeriesParts, markSeriesProcessed, getSeriesStatus } from './db/series.mjs';

function makeReplySubject(originalSubject) {
  let s = (originalSubject || 'your message').replace(/\.{2,}$/, '').trim();
  s = s.replace(/^(RE:\s*)+/i, '').trim();
  s = s.substring(0, 60);
  return `RE: ${s}`;
}

const MAX_SENDS_PER_CYCLE = 4;
const MAX_CONSECUTIVE_KNOWN = 2;
const MAX_TOPIC_CHARS = 50000;

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
    const samMessages = findSamMessages(allMessages);
    console.log(`inbox: ${allMessages.length} total, ${samMessages.length} from Sam`);

    await setState(env.DB, 'last_scan', JSON.stringify({
      ts: new Date().toISOString(),
      totalRows: allMessages.length,
      samCount: samMessages.length,
      pageUrl: page.url(),
      first3: allMessages.slice(0, 3).map(m => ({ sender: m.sender, subject: m.subject?.substring(0, 50) })),
    }));

    let newMessageCount = 0;
    let consecutiveKnown = 0;

    for (const msg of samMessages) {
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
      console.log(`new message from ${sender}: "${body?.substring(0, 100)}..."`);

      const { command: docCmd, docTag } = parseDocCommand(body);
      if (docCmd) console.log(`doc command: ${docCmd} ${docTag}`);

      const newMsgId = await saveMessage(env.DB, {
        externalId: messageId,
        direction: 'inbound',
        sender: sender || 'SAMUEL MULLIKIN',
        subject: msg.subject,
        body: body || '',
        timestamp: new Date().toISOString(),
        docTag: docTag || null,
      });

      const seriesInfo = detectSeriesIndicator(body);
      if (seriesInfo) {
        console.log(`series detected: message ${seriesInfo.partNum}/${seriesInfo.totalParts} (key: ${seriesInfo.seriesKey})`);
        const series = await getOrCreateSeries(env.DB, {
          seriesKey: seriesInfo.seriesKey,
          totalParts: seriesInfo.totalParts,
          docTag: docTag || null,
          docCommand: docCmd || null,
        });
        await addSeriesPart(env.DB, { seriesId: series.id, partNum: seriesInfo.partNum, messageId: newMsgId });
        await env.DB.prepare("UPDATE messages SET responded_at = 'series_collecting' WHERE id = ?").bind(newMsgId).run();
        const isComplete = await checkSeriesComplete(env.DB, series.id);
        if (isComplete) {
          console.log(`series ${seriesInfo.seriesKey} COMPLETE: all ${seriesInfo.totalParts} parts received`);
        }
      }

      newMessageCount++;
      await notifyDennis(env, `securus: new message from ${sender}\n\n${body?.substring(0, 160)}`);
      await navigateBackToInbox(page);
    }

    await logout(page);
    console.log(`=== SCAN DONE: ${newMessageCount} new messages ===`);
    return { success: true, newMessages: newMessageCount, total: samMessages.length };
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

    const effectiveTag = series.doc_tag;
    const effectiveCmd = series.doc_command;
    const isFullDoc = effectiveCmd === 'makefull';
    const recentHistory = await getRecentMessages(env.DB, 10);
    let topicHistory = null;
    let knowledgeEntries = [];

    if (effectiveTag) {
      const allTopicMsgs = await getMessagesByDocTag(env.DB, effectiveTag);
      let totalChars = 0;
      topicHistory = [];
      for (let i = allTopicMsgs.length - 1; i >= 0; i--) {
        const bodyLen = (allTopicMsgs[i].body || '').length;
        if (totalChars + bodyLen > MAX_TOPIC_CHARS && topicHistory.length > 0) break;
        topicHistory.unshift(allTopicMsgs[i]);
        totalChars += bodyLen;
      }
      const importContent = await getState(env.DB, `${effectiveTag}_import`);
      if (importContent) {
        const truncated = importContent.length > 30000 ? importContent.substring(0, 30000) + '\n\n[... truncated ...]' : importContent;
        knowledgeEntries.push({ topic: `${effectiveTag} project reference`, content: truncated });
      }
    }

    const replySubject = effectiveTag
      ? `RE: ${effectiveTag.charAt(0).toUpperCase() + effectiveTag.slice(1)} Update`
      : makeReplySubject(parts[0].subject);

    try {
      const aiResponse = await generateResponse(env, combinedBody, recentHistory, knowledgeEntries, replySubject.length, topicHistory, effectiveTag, { fullDocument: isFullDoc });
      if (aiResponse) {
        const ack = docAcknowledgment(effectiveCmd, effectiveTag, { total: series.total_parts });
        const finalResponse = ack + aiResponse;
        const outboundParts = splitForSend(replySubject, finalResponse);
        const primaryId = parts[0].message_id;
        await queueOutboundParts(env.DB, { inboundId: primaryId, seriesId: series.id, parts: outboundParts, docTag: effectiveTag });
        await markSeriesProcessed(env.DB, series.id);
        generated++;
        results.push({ id: primaryId, status: 'generated', type: 'series', parts: outboundParts.length, seriesKey: series.series_key });
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
      console.log(`dedup: send_queue already has entries for msg ${msg.id}, marking responded`);
      const firstQueued = await env.DB.prepare(
        "SELECT outbound_msg_id FROM send_queue WHERE inbound_id = ? AND status = 'sent' AND outbound_msg_id IS NOT NULL LIMIT 1"
      ).bind(msg.id).first();
      if (firstQueued) await markResponded(env.DB, msg.id, firstQueued.outbound_msg_id);
      results.push({ id: msg.id, status: 'already_queued' });
      continue;
    }

    const replySubjectCheck = makeReplySubject(msg.subject);
    const existingOutbound = await env.DB.prepare(
      "SELECT id FROM messages WHERE direction = 'outbound' AND subject = ? LIMIT 1"
    ).bind(replySubjectCheck).first();
    if (existingOutbound) {
      console.log(`dedup: outbound already exists for msg ${msg.id} (outbound #${existingOutbound.id}), marking responded`);
      await markResponded(env.DB, msg.id, existingOutbound.id);
      results.push({ id: msg.id, status: 'dedup_resolved', outboundId: existingOutbound.id });
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
      console.log(`generating response for message ${msg.id}: "${msg.subject?.substring(0, 60)}"`);
      const { command: docCmd, docTag, cleanBody } = parseDocCommand(msg.body);
      const bodyForAi = cleanBody || msg.body;
      const recentHistory = await getRecentMessages(env.DB, 10);
      const effectiveTag = msg.doc_tag || docTag;
      const isFullDoc = docCmd === 'makefull';
      let topicHistory = null;
      let knowledgeEntries = [];

      if (effectiveTag) {
        const allTopicMsgs = await getMessagesByDocTag(env.DB, effectiveTag);
        let totalChars = 0;
        topicHistory = [];
        for (let i = allTopicMsgs.length - 1; i >= 0; i--) {
          const bodyLen = (allTopicMsgs[i].body || '').length;
          if (totalChars + bodyLen > MAX_TOPIC_CHARS && topicHistory.length > 0) break;
          topicHistory.unshift(allTopicMsgs[i]);
          totalChars += bodyLen;
        }
        console.log(`loaded ${topicHistory.length}/${allTopicMsgs.length} messages for topic "${effectiveTag}" (${totalChars} chars)`);
        const importContent = await getState(env.DB, `${effectiveTag}_import`);
        if (importContent) {
          const truncated = importContent.length > 30000 ? importContent.substring(0, 30000) + '\n\n[... truncated ...]' : importContent;
          knowledgeEntries.push({ topic: `${effectiveTag} project reference`, content: truncated });
          console.log(`loaded ${importContent.length} chars of imported ${effectiveTag} content`);
        }
      }

      const replySubject = makeReplySubject(msg.subject);
      const aiResponse = await generateResponse(env, bodyForAi, recentHistory, knowledgeEntries, replySubject.length, topicHistory, effectiveTag, { fullDocument: isFullDoc });

      if (aiResponse) {
        const ack = docAcknowledgment(docCmd, docTag);
        const finalResponse = ack + aiResponse;
        const outboundParts = splitForSend(replySubject, finalResponse);
        await queueOutboundParts(env.DB, { inboundId: msg.id, seriesId: null, parts: outboundParts, docTag: effectiveTag });
        generated++;
        results.push({ id: msg.id, status: 'generated', parts: outboundParts.length, chars: aiResponse.length });
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

  const standaloneJson = await getState(env.DB, 'standalone_outbound');
  const hasStandalone = standaloneJson && standaloneJson.length > 2;

  if (pendingParts.length === 0 && !hasStandalone) {
    console.log('no pending sends');
    return { success: true, sent: 0, message: 'nothing to send' };
  }

  console.log(`${pendingParts.length} queue parts to send${hasStandalone ? ' + 1 standalone' : ''}`);
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

    if (hasStandalone) {
      const standalone = JSON.parse(standaloneJson);
      console.log(`sending standalone: "${standalone.subject}"`);
      const sendResult = await composeAndSend(page, {
        contactId: env.SAM_CONTACT_ID,
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
        results.push({ type: 'standalone', status: 'sent_confirmed' });
        console.log('standalone sent and confirmed');
      } else {
        results.push({ type: 'standalone', status: 'failed', error: sendResult.error });
      }
    }

    for (const qp of pendingParts) {
      console.log(`sending queue #${qp.id}: part ${qp.part_num}/${qp.total_parts} for inbound ${qp.inbound_id}`);

      const sendResult = await composeAndSend(page, {
        contactId: env.SAM_CONTACT_ID,
        subject: qp.subject,
        body: qp.body,
      });

      if (sendResult.success) {
        const outboundId = await saveMessage(env.DB, {
          direction: 'outbound',
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
        results.push({ queueId: qp.id, part: `${qp.part_num}/${qp.total_parts}`, status: 'sent', outboundId });
        console.log(`queue #${qp.id} sent successfully`);
      } else {
        await markPartFailed(env.DB, qp.id, sendResult.error || 'unknown');
        results.push({ queueId: qp.id, part: `${qp.part_num}/${qp.total_parts}`, status: 'failed', error: sendResult.error });
        console.log(`queue #${qp.id} FAILED: ${sendResult.error}`);
        await notifyDennis(env, `securus-agent: queue part ${qp.id} failed: ${sendResult.error}`);
      }
    }

    await logout(page);
    console.log(`=== SEND DONE: ${sent} parts sent ===`);
    return { success: true, sent, total: pendingParts.length, results };
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

      const parts = (await env.DB.prepare(
        "SELECT * FROM send_queue WHERE inbound_id = ? AND status = 'pending' ORDER BY part_num ASC"
      ).bind(msgId).all()).results;
      if (parts.length === 0) return Response.json({ success: false, error: `no pending queue parts for inbound ${msgId}` });

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

        const results = [];
        for (const qp of parts) {
          const sendResult = await composeAndSend(page, {
            contactId: env.SAM_CONTACT_ID,
            subject: qp.subject,
            body: qp.body,
          });
          results.push({ queueId: qp.id, part: `${qp.part_num}/${qp.total_parts}`, subject: qp.subject, bodyLen: qp.body.length, ...sendResult });

          if (sendResult.success) {
            const outboundId = await saveMessage(env.DB, {
              direction: 'outbound',
              sender: 'DENNIS HANSON',
              subject: qp.subject,
              body: qp.body,
              timestamp: new Date().toISOString(),
              docTag: qp.doc_tag || null,
            });
            await incrementCounter(env.DB, 'total_messages_sent');
            await markConfirmedSent(env.DB, outboundId);
            await markPartSent(env.DB, qp.id, outboundId);

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

    // /queue-send — queue a standalone outbound message
    if (url.pathname === '/queue-send') {
      if (request.method === 'POST') {
        const { subject, body } = await request.json();
        await setState(env.DB, 'standalone_outbound', JSON.stringify({ subject, body, queuedAt: new Date().toISOString() }));
        return Response.json({ success: true, message: 'queued for next send phase' });
      }
      return Response.json({ success: false, error: 'POST required with { subject, body }' });
    }

    // /fix-dupes — find inbound messages that have outbound responses but aren't marked responded
    if (url.pathname === '/fix-dupes') {
      const unresponded = await getUnrespondedInbound(env.DB);
      const fixed = [];
      for (const msg of unresponded) {
        const replySubj = makeReplySubject(msg.subject);
        const outbound = await env.DB.prepare(
          "SELECT id, subject, timestamp FROM messages WHERE direction = 'outbound' AND subject = ? ORDER BY id ASC LIMIT 1"
        ).bind(replySubj).first();
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

      return Response.json({ success: true, migrations: migrationResults, draftsMigrated });
    }

    return Response.json({
      service: 'securus-agent',
      version: 'v4-queue',
      routes: ['/check', '/cron', '/scan', '/generate', '/send', '/send-one/{id}', '/verify-sent', '/resend/{id}', '/fix-dupes', '/queue', '/series', '/retry-failed', '/status', '/draft', '/conversation', '/docs', '/migrate'],
    });
  },

  async scheduled(event, env, ctx) {
    const jitterMs = Math.floor(Math.random() * 30 * 1000);
    console.log(`cron triggered, jitter: ${jitterMs}ms`);
    await new Promise(resolve => setTimeout(resolve, jitterMs));
    ctx.waitUntil(cronOrchestrator(env));
  },
};

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

      const { command: docCmd, docTag, cleanBody, batch } = parseDocCommand(body);
      if (docCmd) console.log(`doc command: ${docCmd} ${docTag}${batch ? ` (${batch.part}/${batch.total})` : ''}`);

      const newMsgId = await saveMessage(env.DB, {
        externalId: messageId,
        direction: 'inbound',
        sender: sender || 'SAMUEL MULLIKIN',
        subject: msg.subject,
        body: body || '',
        timestamp: new Date().toISOString(),
        docTag: docTag || null,
      });

      if (batch && docTag) {
        await env.DB.prepare("UPDATE messages SET responded_at = 'batch_waiting' WHERE id = ?").bind(newMsgId).run();
        const batchKey = `batch_${docTag}`;
        const existingBatch = await getState(env.DB, batchKey);
        const batchState = existingBatch ? JSON.parse(existingBatch) : { total: batch.total, parts: {} };
        batchState.total = batch.total;
        batchState.parts[String(batch.part)] = newMsgId;
        const receivedCount = Object.keys(batchState.parts).length;
        if (receivedCount >= batchState.total) {
          batchState.complete = true;
          console.log(`batch ${docTag} complete: all ${batchState.total} parts received`);
        } else {
          console.log(`batch ${docTag}: part ${batch.part}/${batchState.total} (${receivedCount} so far)`);
        }
        await setState(env.DB, batchKey, JSON.stringify(batchState));
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
  const pending = await getUnrespondedInbound(env.DB);
  if (pending.length === 0) {
    console.log('no unresponded messages');
    return { success: true, generated: 0 };
  }

  let generated = 0;
  const results = [];

  // check for complete batches first
  const batchRows = (await env.DB.prepare(
    "SELECT key, value FROM system_state WHERE key LIKE 'batch_%' AND value LIKE '%\"complete\":true%'"
  ).all()).results;

  for (const row of batchRows) {
    const batchState = JSON.parse(row.value);
    if (batchState.drafted) continue;

    const batchDocTag = row.key.replace('batch_', '');
    console.log(`processing complete batch for ${batchDocTag} (${batchState.total} parts)`);

    const sortedParts = Object.entries(batchState.parts).sort(([a], [b]) => parseInt(a) - parseInt(b));
    const bodies = [];
    const partMsgIds = [];
    for (const [partNum, msgId] of sortedParts) {
      const partMsg = await env.DB.prepare("SELECT body FROM messages WHERE id = ?").bind(msgId).first();
      if (partMsg) {
        const { cleanBody: partBody } = parseDocCommand(partMsg.body);
        bodies.push(partBody);
        partMsgIds.push(msgId);
      }
    }

    const combinedBody = bodies.join('\n\n---\n\n');
    const recentHistory = await getRecentMessages(env.DB, 10);
    const topicHistory = await getMessagesByDocTag(env.DB, batchDocTag);
    const replySubject = `RE: ${batchDocTag.charAt(0).toUpperCase() + batchDocTag.slice(1)} Update`;
    const aiResponse = await generateResponse(env, combinedBody, recentHistory, [], replySubject.length, topicHistory, batchDocTag);

    if (aiResponse) {
      const ack = docAcknowledgment('makeupdate', batchDocTag, { total: batchState.total });
      const finalResponse = ack + aiResponse;
      const parts = splitForSend(replySubject, finalResponse);
      const primaryId = partMsgIds[0];
      await env.DB.prepare("UPDATE messages SET responded_at = NULL WHERE id = ?").bind(primaryId).run();
      await setState(env.DB, `draft_${primaryId}`, JSON.stringify({
        messageId: primaryId,
        parts,
        docTag: batchDocTag,
        batchMsgIds: partMsgIds,
        generatedAt: new Date().toISOString(),
      }));
      batchState.drafted = true;
      await setState(env.DB, row.key, JSON.stringify(batchState));
      generated++;
      results.push({ id: primaryId, status: 'generated', type: 'batch', parts: parts.length });
      console.log(`batch ${batchDocTag} draft saved (${parts.length} parts, ${finalResponse.length} chars)`);
    }
  }

  // generate for individual messages
  for (const msg of pending) {
    const existingDraft = await getState(env.DB, `draft_${msg.id}`);
    if (existingDraft) {
      results.push({ id: msg.id, status: 'draft_exists' });
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
      const { command: docCmd, docTag, cleanBody, batch } = parseDocCommand(msg.body);
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
          const truncated = importContent.length > 30000 ? importContent.substring(0, 30000) + '\n\n[... truncated for context limit ...]' : importContent;
          knowledgeEntries.push({ topic: `${effectiveTag} project reference`, content: truncated });
          console.log(`loaded ${importContent.length} chars of imported ${effectiveTag} content`);
        }
      }

      const replySubject = makeReplySubject(msg.subject);
      const aiResponse = await generateResponse(env, bodyForAi, recentHistory, knowledgeEntries, replySubject.length, topicHistory, effectiveTag, { fullDocument: isFullDoc });

      if (aiResponse) {
        const ack = docAcknowledgment(docCmd, docTag);
        const finalResponse = ack + aiResponse;
        const parts = splitForSend(replySubject, finalResponse);
        await setState(env.DB, `draft_${msg.id}`, JSON.stringify({
          messageId: msg.id,
          parts,
          docTag: msg.doc_tag || docTag || null,
          generatedAt: new Date().toISOString(),
        }));
        generated++;
        results.push({ id: msg.id, status: 'generated', parts: parts.length, chars: aiResponse.length });
        console.log(`draft saved for message ${msg.id} (${parts.length} parts, ${finalResponse.length} chars)`);
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

  console.log(`=== GENERATE DONE: ${generated} new drafts ===`);
  return { success: true, generated, total: pending.length, results };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3: SEND — browser sends drafts, verifies, marks confirmed
// ═══════════════════════════════════════════════════════════════
async function phaseSend(env) {
  console.log('=== PHASE 3: SEND ===');
  const pending = await getUnrespondedInbound(env.DB);
  const toSend = [];
  for (const msg of pending) {
    if (toSend.length >= MAX_SENDS_PER_CYCLE) break;
    const draftJson = await getState(env.DB, `draft_${msg.id}`);
    if (draftJson) {
      toSend.push({ msg, draft: JSON.parse(draftJson) });
    }
  }

  // also check for standalone outbound
  const standaloneJson = await getState(env.DB, 'standalone_outbound');
  const hasStandalone = standaloneJson && standaloneJson.length > 2;

  if (toSend.length === 0 && !hasStandalone) {
    console.log('no drafts to send');
    return { success: true, sent: 0, message: 'no drafts ready' };
  }

  console.log(`${toSend.length} drafts to send${hasStandalone ? ' + 1 standalone' : ''}`);
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

    // send standalone outbound first
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

    // send drafts
    for (const { msg, draft } of toSend) {
      console.log(`sending draft for message ${msg.id} (${draft.parts.length} parts)`);
      let firstOutboundId = null;
      let allPartsSent = true;

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
            docTag: draft.docTag || msg.doc_tag || null,
          });
          await incrementCounter(env.DB, 'total_messages_sent');
          await markConfirmedSent(env.DB, outboundId);
          if (i === 0) firstOutboundId = outboundId;
          console.log(`part ${i + 1}/${draft.parts.length} sent and confirmed for msg ${msg.id}`);
        } else {
          allPartsSent = false;
          console.log(`part ${i + 1} FAILED for msg ${msg.id}: ${sendResult.error}`);
          results.push({ id: msg.id, status: 'send_failed', part: i + 1, error: sendResult.error });
          await notifyDennis(env, `securus-agent: failed to send reply part ${i + 1} for msg ${msg.id}: ${sendResult.error}`);
          break;
        }
      }

      if (firstOutboundId && allPartsSent) {
        if (draft.batchMsgIds) {
          for (const batchId of draft.batchMsgIds) {
            await markResponded(env.DB, batchId, firstOutboundId);
          }
          await setState(env.DB, `batch_${draft.docTag}`, '');
        } else {
          await markResponded(env.DB, msg.id, firstOutboundId);
        }
        await setState(env.DB, `draft_${msg.id}`, '');
        sent++;
        results.push({ id: msg.id, status: 'sent_confirmed', parts: draft.parts.length });
      }
    }

    await logout(page);
    console.log(`=== SEND DONE: ${sent} messages sent and confirmed ===`);
    return { success: true, sent, total: toSend.length, results };
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

  // check for deep scan request (needs cron's 15min budget)
  const deepScanRequested = await getState(env.DB, 'deep_scan_requested');
  if (deepScanRequested === 'true') {
    console.log('deep scan requested — running instead of normal cycle');
    await setState(env.DB, 'deep_scan_requested', '');
    try {
      phaseResults.deepScan = await deepScan(env);
    } catch (err) {
      console.error('DEEP SCAN crashed:', err.message);
      phaseResults.deepScan = { success: false, error: err.message };
    }
    await setState(env.DB, 'last_check', new Date().toISOString());
    await incrementCounter(env.DB, 'total_checks');
    return { success: true, phases: phaseResults };
  }

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

  // Phase 3: SEND (only if there are drafts)
  const pending = await getUnrespondedInbound(env.DB);
  let hasDrafts = false;
  for (const msg of pending) {
    const d = await getState(env.DB, `draft_${msg.id}`);
    if (d) { hasDrafts = true; break; }
  }
  const standaloneJson = await getState(env.DB, 'standalone_outbound');
  const hasStandalone = standaloneJson && standaloneJson.length > 2;

  if (hasDrafts || hasStandalone) {
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
// DEEP SCAN — find and save messages missed on pages 2+
// ═══════════════════════════════════════════════════════════════
async function deepScan(env) {
  console.log('=== DEEP SCAN START ===');
  await setState(env.DB, 'deep_scan_result', JSON.stringify({ status: 'running', startedAt: new Date().toISOString() }));

  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const loggedIn = await loginToSecurus(page, env);
    if (!loggedIn) {
      const result = { success: false, error: 'Login failed', ts: new Date().toISOString() };
      await setState(env.DB, 'deep_scan_result', JSON.stringify(result));
      await browser.close();
      return result;
    }

    await navigateToInbox(page);
    const allMessages = await enumerateAllPages(page);
    const samMessages = findSamMessages(allMessages);
    console.log(`deep-scan: ${allMessages.length} total, ${samMessages.length} from Sam`);

    const existingExternalIds = new Set();
    const dbMessages = (await env.DB.prepare("SELECT external_id, subject FROM messages WHERE direction = 'inbound'").all()).results;
    dbMessages.forEach(m => { if (m.external_id) existingExternalIds.add(m.external_id); });
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

    console.log(`deep-scan: ${known.length} known, ${missing.length} potentially missing`);

    // save interim results
    await setState(env.DB, 'deep_scan_result', JSON.stringify({
      status: 'opening_missing',
      totalInbox: allMessages.length,
      samMessages: samMessages.length,
      known: known.length,
      potentiallyMissing: missing.length,
      missingMessages: missing,
      ts: new Date().toISOString(),
    }));

    let opened = 0;
    for (const msg of missing) {
      console.log(`deep-scan: opening missing message on page ${msg.page}: "${msg.subject}"`);
      await navigateToInbox(page);
      await humanDelay(1000, 1500);

      if (msg.page > 1) {
        for (let p = 1; p < msg.page; p++) {
          const clicked = await page.evaluate(() => {
            const links = [...document.querySelectorAll('a')];
            const nextLink = links.find(a =>
              a.textContent?.trim() === '>' ||
              a.textContent?.trim().toLowerCase() === 'next' ||
              a.getAttribute('aria-label')?.toLowerCase().includes('next')
            );
            if (nextLink) { nextLink.click(); return true; }
            const pageLinks = links.filter(a => /^\d+$/.test(a.textContent?.trim()));
            const currentPage = document.querySelector('a.active, span.active, li.active a');
            const currentNum = currentPage ? parseInt(currentPage.textContent?.trim()) : 0;
            const nextPageLink = pageLinks.find(a => parseInt(a.textContent?.trim()) === currentNum + 1);
            if (nextPageLink) { nextPageLink.click(); return true; }
            return false;
          });
          if (!clicked) break;
          await humanDelay(2000, 3000);
          await page.waitForSelector('table tbody tr', { visible: true, timeout: 15000 }).catch(() => {});
        }
      }

      const messageId = await openMessage(page, msg.index);
      if (!messageId) {
        console.log(`deep-scan: no messageId for "${msg.subject}"`);
        continue;
      }

      if (existingExternalIds.has(messageId)) {
        console.log(`deep-scan: ${messageId} already in D1 (subject prefix mismatch)`);
        continue;
      }

      const { sender, body } = await extractMessage(page);
      const { command: docCmd, docTag, cleanBody, batch } = parseDocCommand(body);

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

      if (batch && docTag) {
        await env.DB.prepare("UPDATE messages SET responded_at = 'batch_waiting' WHERE id = ?").bind(newMsgId).run();
        const batchKey = `batch_${docTag}`;
        const existingBatch = await getState(env.DB, batchKey);
        const batchState = existingBatch ? JSON.parse(existingBatch) : { total: batch.total, parts: {} };
        batchState.total = batch.total;
        batchState.parts[String(batch.part)] = newMsgId;
        if (Object.keys(batchState.parts).length >= batchState.total) batchState.complete = true;
        await setState(env.DB, batchKey, JSON.stringify(batchState));
      }

      opened++;
      console.log(`deep-scan: saved ${messageId} as D1#${newMsgId}: "${msg.subject?.substring(0, 40)}"`);
    }

    await logout(page);
    await browser.close();

    const finalResult = {
      success: true,
      status: 'complete',
      totalInbox: allMessages.length,
      samMessages: samMessages.length,
      pages: allMessages.length > 0 ? (allMessages[allMessages.length - 1].page || 1) : 0,
      known: known.length,
      potentiallyMissing: missing.length,
      newMessagesSaved: opened,
      missingMessages: missing,
      knownMessages: known,
      ts: new Date().toISOString(),
    };
    await setState(env.DB, 'deep_scan_result', JSON.stringify(finalResult));
    console.log(`=== DEEP SCAN DONE: ${opened} new messages saved ===`);
    return finalResult;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    const errResult = { success: false, error: err.message, ts: new Date().toISOString() };
    await setState(env.DB, 'deep_scan_result', JSON.stringify(errResult));
    console.error('deep scan error:', err.message, err.stack);
    return errResult;
  }
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

    // /deep-scan — queue a full multi-page inbox scan for the next cron cycle
    // cron gets 15min budget vs HTTP's ~30s, needed for multi-page browser ops
    if (url.pathname === '/deep-scan') {
      await setState(env.DB, 'deep_scan_requested', 'true');
      await setState(env.DB, 'deep_scan_result', JSON.stringify({ status: 'queued', queuedAt: new Date().toISOString() }));
      return Response.json({ triggered: true, message: 'deep scan queued — trigger /cron or wait for next hourly cycle, then check /deep-scan-results', ts: new Date().toISOString() });
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

    // /send-one/{id} — send a single draft, verify, return detailed result
    if (url.pathname.startsWith('/send-one/')) {
      const msgId = parseInt(url.pathname.split('/')[2], 10);
      if (isNaN(msgId)) return Response.json({ success: false, error: 'invalid id' });

      const draftJson = await getState(env.DB, `draft_${msgId}`);
      if (!draftJson) return Response.json({ success: false, error: `no draft for message ${msgId}` });
      const draft = JSON.parse(draftJson);

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
        for (let i = 0; i < draft.parts.length; i++) {
          const part = draft.parts[i];
          const sendResult = await composeAndSend(page, {
            contactId: env.SAM_CONTACT_ID,
            subject: part.subject,
            body: part.body,
          });
          results.push({ part: i + 1, subject: part.subject, bodyLen: part.body.length, ...sendResult });

          if (sendResult.success) {
            const outboundId = await saveMessage(env.DB, {
              direction: 'outbound',
              sender: 'DENNIS HANSON',
              subject: part.subject,
              body: part.body,
              timestamp: new Date().toISOString(),
              docTag: draft.docTag || null,
            });
            await incrementCounter(env.DB, 'total_messages_sent');
            await markConfirmedSent(env.DB, outboundId);

            if (i === 0) {
              if (draft.batchMsgIds) {
                for (const batchId of draft.batchMsgIds) {
                  await markResponded(env.DB, batchId, outboundId);
                }
                await setState(env.DB, `batch_${draft.docTag}`, '');
              } else {
                await markResponded(env.DB, msgId, outboundId);
              }
              await setState(env.DB, `draft_${msgId}`, '');
            }
          } else {
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

    // /resend/{id} — reset a message for re-generation and re-send
    if (url.pathname.startsWith('/resend/')) {
      const msgId = parseInt(url.pathname.split('/')[2], 10);
      if (isNaN(msgId)) return Response.json({ success: false, error: 'invalid message id' });
      await resetResponse(env.DB, msgId);
      await setState(env.DB, `draft_${msgId}`, '');
      return Response.json({ success: true, message: `message ${msgId} reset — will re-generate and re-send` });
    }

    // /draft — view current drafts
    if (url.pathname === '/draft') {
      const unresponded = await getUnrespondedInbound(env.DB);
      const drafts = [];
      for (const msg of unresponded) {
        const draftJson = await getState(env.DB, `draft_${msg.id}`);
        if (draftJson) {
          const draft = JSON.parse(draftJson);
          drafts.push({
            msgId: msg.id,
            subject: msg.subject,
            parts: draft.parts.map(p => ({
              subject: p.subject,
              bodyLength: p.body.length,
              bodyPreview: p.body.substring(0, 200),
            })),
          });
        }
      }
      return Response.json({ drafts, unrespondedCount: unresponded.length });
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
      let draftsReady = 0;
      for (const msg of unresponded) {
        const d = await getState(env.DB, `draft_${msg.id}`);
        if (d) draftsReady++;
      }

      return Response.json({
        lastCheck,
        totalChecks,
        totalMessagesSent: totalSent,
        lastError,
        queue: { unresponded: unresponded.length, draftsReady, unconfirmedOutbound: unconfirmed.length },
        recentMessages,
      });
    }

    // /migrate — add confirmed_sent column if missing
    if (url.pathname === '/migrate') {
      try {
        await env.DB.prepare("ALTER TABLE messages ADD COLUMN confirmed_sent TEXT DEFAULT NULL").run();
        return Response.json({ success: true, message: 'confirmed_sent column added' });
      } catch (err) {
        if (err.message?.includes('duplicate column')) {
          return Response.json({ success: true, message: 'column already exists' });
        }
        return Response.json({ success: false, error: err.message });
      }
    }

    return Response.json({
      service: 'securus-agent',
      version: 'v3-phases',
      routes: ['/check', '/cron', '/scan', '/generate', '/send', '/send-one/{id}', '/verify-sent', '/resend/{id}', '/status', '/draft', '/conversation', '/docs', '/migrate'],
    });
  },

  async scheduled(event, env, ctx) {
    const jitterMs = Math.floor(Math.random() * 30 * 1000);
    console.log(`cron triggered, jitter: ${jitterMs}ms`);
    await new Promise(resolve => setTimeout(resolve, jitterMs));
    ctx.waitUntil(cronOrchestrator(env));
  },
};

// securus-agent cloudflare worker — three-phase cron architecture
// Phase 1: SCAN — browser reads inbox, saves to D1
// Phase 2: GENERATE — AI creates responses, saves drafts
// Phase 3: SEND — browser sends drafts, verifies in sent folder, marks confirmed
import puppeteer from '@cloudflare/puppeteer';
import { loginToSecurus, logout, acceptPendingTerms, lastLoginDiagnostic } from './securus/auth.mjs';
import { navigateToInbox, enumerateMessages, enumerateAllPages, findSamMessages } from './securus/inbox.mjs';
import { openMessage, extractMessage, navigateBackToInbox } from './securus/read.mjs';
import { composeAndSend } from './securus/compose.mjs';
import { urls, compose as composeSel } from './securus/selectors.mjs';
import { humanDelay, safeGoto, launchMessaging, inAppNav } from './securus/helpers.mjs';
import { messageExists, getMessageByExternalId, saveMessage, markResponded, markConfirmedSent, getUnconfirmedOutbound, resetResponse, getRecentMessages, getUnrespondedInbound, getMessagesByDocTag, getAllDocTags, getAllMessages } from './db/messages.mjs';
import { parseDocCommand, docAcknowledgment, parseReferenceDirectives, parseImageCommand, parseInlineImage, parseImageDirectives, mentionedTags } from './docs/commands.mjs';
import { getState, setState, incrementCounter } from './db/state.mjs';
import { notifyDennis } from './notify/sms.mjs';
import { generateResponse, splitForSend, shouldEscalate, buildDocument, buildDocumentPatch, engineerImagePrompt, resolveImageIntent, resolveReferences, voiceViolations, budgetReply, replyFooter } from './ai/responder.mjs';
import { getDocument, saveDocument, docTitle, changeNoteFor, getDocumentVersions, getSections, saveSections, applyPatch, renderSections, appendEntry, getEntries, archiveDocument, isProtected, listDocumentsForContact } from './db/documents.mjs';
import { getUsageSnapshot } from './db/usage.mjs';
import { generateImage, hfConfigured, hfAuthCandidates, PER_IMAGE_COST, IMAGE_MODELS, DEFAULT_IMAGE_MODEL } from './ai/images.mjs';
import { saveImage, getImage, getImages, latestImageForProject, listImages, imageFilename } from './db/images.mjs';
import { getContacts, getContact, contactIdForSender, DEFAULT_CONTACT } from './db/contacts.mjs';
import { getAutobuyConfig, autobuyGuard, purchaseStamps, recordPurchaseAttempt, getPurchaseLog, AUTOBUY_DEFAULTS } from './securus/stamps.mjs';
import { queueOutboundParts, getPendingParts, markPartSent, markPartFailed, getQueueStatus, hasPendingParts, hasQueuedForInbound, resetFailedParts, safeSubject, getPartImageIds, setPartImageIds, chunkImageIds, MAX_ATTACHMENTS_PER_MESSAGE } from './db/send_queue.mjs';
import { REQUESTS_MIGRATIONS, createRequests, getRequestsForInbound, getCarryoverRequests, markRequests, listRequests, requestCounts, requestLabel, imageDirectivesToRequests } from './db/requests.mjs';
import { extractRequests, reconcileRequests } from './ai/requests.mjs';
import { refreshProfile, PROFILE_TAG } from './ai/profile.mjs';
import { PROJECT_STATE_MIGRATIONS, getCurrentState, getStateHistory, applyStateChanges, renderStateBlock, sectionsCitingStale } from './db/project_state.mjs';
import { extractStateChanges, consistencySweepInstruction } from './ai/state.mjs';
import { upgradeProject, upgradeAllProjects } from './ops/upgrade.mjs';
import { detectSeriesIndicator, stripSeriesIndicator, getOrCreateSeries, addSeriesPart, checkSeriesComplete, getCompleteSeries, getSeriesParts, markSeriesProcessed, getSeriesStatus, findDuplicateInbound } from './db/series.mjs';
import { getDashboardData, renderDashboardHTML } from './dashboard.mjs';
import { ensureTenantSchema, upsertTenant, getTenant, setTenantStatus, tenantCredentials, registerTenantContact, getTenantContacts, OWNER_TENANT } from './db/tenants.mjs';
import { listContacts, listAgencies, searchInmates, addContactFromSearch, listComposeRecipients } from './securus/contacts-page.mjs';
import { computeNextRun, DEFAULT_SCHEDULE } from './db/schedule.mjs';

function makeReplySubject(originalSubject) {
  let s = (originalSubject || 'your message').replace(/\.{2,}$/, '').trim();
  s = s.replace(/^(RE:\s*)+/i, '').trim();
  // capped through safeSubject so the stored queue subject, the sent subject,
  // and the dedup comparison all agree
  return safeSubject(`RE: ${s}`);
}

const MAX_SENDS_PER_CYCLE = 4;
const MAX_CONSECUTIVE_KNOWN = 2;
const MAX_TOPIC_CHARS = 50000;

// Record an error to last_error AND a rolling history (error_log, last 30) —
// a single overwritten key hid a 36h login-reset streak (Oct 2026).
async function recordError(env, msg) {
  const entry = `${msg} at ${new Date().toISOString()}`;
  await setState(env.DB, 'last_error', entry);
  try {
    const log = JSON.parse(await getState(env.DB, 'error_log') || '[]');
    log.push(entry);
    await setState(env.DB, 'error_log', JSON.stringify(log.slice(-30)));
  } catch { /* history is best-effort */ }
}

// Generate one image for a contact (GH#7 v2): engineer the prompt from intent
// (+ project doc excerpt + any reference docs), call Higgsfield, persist.
// project null → 'standalone'. Returns { ok, imageId, prompt, note, ... }.
// v2: label (Sam's "Saga2"), model (registry id; unknown → soul + modelFallback)
// and requestId (ledger row) travel with the image.
async function runImageGeneration(env, { contactId, project, intent, referenceDocs = [], iterate = false, label = null, model = DEFAULT_IMAGE_MODEL, requestId = null }) {
  const tag = (project || 'standalone').toLowerCase();
  const prev = iterate ? await latestImageForProject(env.DB, contactId, tag) : null;
  const govDoc = project ? await getDocument(env.DB, contactId, tag) : null;
  const refExcerpt = referenceDocs.map(r => `[${r.name}]\n${(r.content || '').substring(0, 1500)}`).join('\n\n') || null;
  const { prompt, note } = await engineerImagePrompt(env, {
    intent: intent || (prev ? 'another variation in the same direction' : ''),
    project: tag,
    previousPrompt: prev?.prompt || null,
    docExcerpt: [govDoc?.content?.substring(0, 2500), refExcerpt].filter(Boolean).join('\n\n---\n\n') || null,
  });
  const gen = await generateImage(env, { prompt, model: model || DEFAULT_IMAGE_MODEL });
  if (!gen.success) {
    return { ok: false, prompt, note, label, model: gen.model, modelFallback: gen.modelFallback, requestedModel: gen.requestedModel, error: gen.error, nsfw: gen.nsfw, notConfigured: gen.notConfigured };
  }
  const imageId = await saveImage(env.DB, {
    contactId, docTag: tag, intent, prompt,
    label, model: gen.model, requestId,
    parentImageId: prev?.id || null, hfRequestId: gen.requestId,
    mime: gen.mime, dataB64: gen.bytesB64, cost: gen.cost ?? PER_IMAGE_COST,
  });
  console.log(`[IMAGE] saved #${imageId} ${contactId}/${tag} (${gen.model}${gen.modelFallback ? `, requested ${gen.requestedModel}` : ''})${prev ? ' (iteration of #' + prev.id + ')' : ''}`);
  return { ok: true, imageId, prompt, note, label, model: gen.model, modelFallback: gen.modelFallback, requestedModel: gen.requestedModel };
}

// Plain-language references: when the body names one of this contact's
// documents without a MakeReference keyword ("based on my values in monday"),
// confirm intent with the LLM resolver and load those docs as references.
// Same-contact only — isolation holds.
async function loadPlainLanguageRefs(env, { contactId, body, excludeTag, already = [] }) {
  try {
    // {tag,title} entries so titles match too ("series bible" ⇒ qualia-bible);
    // archived copies duplicate the live doc's words and the pipeline's own
    // profile is not a user topic — neither is a plain-language candidate
    // (both stay reachable by an explicit MakeReference)
    const rows = (await listDocumentsForContact(env.DB, contactId))
      .filter(r => isUserTag(r.tag))
      .map(r => ({ tag: r.tag, title: r.title }));
    const have = new Set(already.map(r => r.name));
    const candidates = mentionedTags(body, rows)
      .filter(t => t !== excludeTag && !have.has(t));
    if (!candidates.length) return [];
    const confirmed = await resolveReferences(env, { body, candidateTags: candidates });
    const out = [];
    for (const refTag of confirmed) {
      const rd = await getDocument(env.DB, contactId, refTag);
      if (rd?.content) {
        out.push({ name: refTag, content: rd.content });
        console.log(`plain-language reference loaded: ${contactId}/${refTag} (${rd.content.length} chars)`);
      }
    }
    return out;
  } catch (e) {
    console.log(`plain-language ref resolution failed: ${e.message}`);
    return [];
  }
}

// imported reference content: scoped key is `${contactId}:${tag}_import`;
// sam's pre-multi-tenant data lives at the legacy `${tag}_import` key.
async function getImportContent(db, contactId, tag) {
  const scoped = await getState(db, `${contactId}:${tag}_import`);
  if (scoped) return scoped;
  if (contactId === DEFAULT_CONTACT) return getState(db, `${tag}_import`);
  return null;
}

// ═══════════════════════════════════════════════════════════════
// REQUEST LEDGER helpers (v2 §3) — shared by SCAN and GENERATE
// ═══════════════════════════════════════════════════════════════
const MAX_REPLY_PARTS = 3;            // hard cap on text parts per reply (v2 §5)
const CARRYOVER_MIN_AGE_HOURS = 2;    // open items younger than this ride along with the next reply
const MAX_CARRYOVER_PER_MESSAGE = 4;  // items delivered per standalone follow-up
const MAX_CARRYOVER_ATTEMPTS = 3;     // then 'deferred' — never loop on an undeliverable item
const CARRYOVER_COOLDOWN_HOURS = 6;   // at most one standalone follow-up per contact per this window (stamps)
const ARCHIVED_TAG_RE = /-archived-\d{8}/;

const capitalize = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
const isWaitFollowup = (r) => r.kind === 'followup' && r.spec && r.spec.wait === true;
const isUserTag = (t) => !!t && t !== PROFILE_TAG && !ARCHIVED_TAG_RE.test(t);

// Legacy first-line `MakeImage <project> <intent>` (no separator / label) is
// owned by parseImageCommand; the v2 directive parser deliberately skips it.
function legacyImageCommand(body) {
  const first = (body || '').split('\n')[0];
  const m = first.match(/^\s*make\s*-?\s*(?:image|img|picture)\b\s*(.*)$/i);
  if (!m) return null;
  const rest = m[1] || '';
  if (/^[-–—:]/.test(rest) || /^[A-Za-z0-9][A-Za-z0-9 _#'.-]{0,39}:\s+\S/.test(rest)) return null;
  const cmd = parseImageCommand(body);
  return cmd.isImage ? cmd : null;
}

// Deterministic image rows (v2 directives + legacy command) first, then the
// LLM extractor for everything else. Pure w.r.t. the DB — nothing is written.
async function extractLedgerRequests(env, { contactId, body, subject, docTag }) {
  const dir = parseImageDirectives(body || '');
  const imgs = dir.images.filter(i => i && i.prompt);
  const group = (subject || docTag || '').replace(/^(RE:\s*)+/i, '').trim().substring(0, 40) || null;
  // project travels in the spec so a request carried over to a later message
  // is still filed under (and prompted from) the document it came with
  const imageRows = imageDirectivesToRequests(imgs, { group })
    .map((r, i) => ({ ...r, spec: { ...r.spec, modelRaw: imgs[i].modelHintRaw || null, project: docTag || null } }));
  let cleanBody = dir.cleanBody || '';
  const legacy = legacyImageCommand(body);
  if (legacy) {
    imageRows.unshift({
      kind: 'image',
      label: legacy.project ? `${capitalize(legacy.project)} image` : 'Image',
      spec: { prompt: legacy.intent || null, model: null, label: null, group, project: legacy.project || null, iterate: legacy.iterate || !legacy.intent, legacy: 'command' },
      priority: 6,
    });
    cleanBody = legacy.intent || '';
  }
  const explicitImages = imageRows.map(r => ({ label: r.label, prompt: r.spec.prompt || '' }));
  let known = [];
  try { known = (await listDocumentsForContact(env.DB, contactId)).map(d => d.tag).filter(isUserTag); } catch { /* fresh db */ }
  const extracted = cleanBody.trim()
    ? await extractRequests(env, { body: cleanBody, subject, contactNick: contactId, knownProjects: known, docTag, explicitImages })
    : [];
  for (const r of extracted) {
    if (r.kind === 'image') r.spec = { ...r.spec, project: r.spec.project || docTag || null };
  }
  return [...imageRows, ...extracted];
}

// SCAN: persist the ledger rows for a NEW inbound. A message that is only
// "no need to respond — more coming" gets responded_at='followup_wait' so
// GENERATE never answers it (treated like 'escalated' everywhere).
async function recordInboundRequests(env, { contactId, inboundId, body, subject, docTag }) {
  try {
    const rows = await extractLedgerRequests(env, { contactId, body, subject, docTag });
    const ids = rows.length ? await createRequests(env.DB, contactId, inboundId, rows) : [];
    const onlyWait = rows.length > 0 && rows.every(isWaitFollowup);
    if (onlyWait) {
      await env.DB.prepare("UPDATE messages SET responded_at = 'followup_wait' WHERE id = ? AND responded_at IS NULL").bind(inboundId).run();
      console.log(`[REQUESTS] msg ${inboundId}: wait-only — marked followup_wait, no reply`);
    }
    console.log(`[REQUESTS] msg ${inboundId}: ${ids.length} request(s) recorded (${rows.map(r => r.kind).join(', ') || 'none'})`);
    return { ids, followupWait: onlyWait };
  } catch (e) {
    console.error(`[REQUESTS] extraction failed for msg ${inboundId}: ${e.message}`);
    return { ids: [], followupWait: false };
  }
}

// A new message from the contact satisfies any standing "wait for more" item.
async function closeWaitFollowups(env, contactId, newInboundId) {
  try {
    await env.DB.prepare(
      `UPDATE requests SET status = 'done', note = ?, updated_at = datetime('now')
       WHERE contact_id = ? AND kind = 'followup' AND status IN ('open','in_progress') AND spec LIKE '%"wait":true%'`
    ).bind(`next message arrived (#${newInboundId})`, contactId).run();
  } catch (e) { console.log(`[REQUESTS] closeWaitFollowups: ${e.message}`); }
}

// GENERATE: the ledger rows for an inbound, extracting on the fly for
// messages saved before the ledger existed (or by admin backfill paths).
// persist=false (dry runs) returns in-memory rows with negative ids.
async function ensureRequests(env, { contactId, inboundId, body, subject, docTag, persist = true }) {
  const existing = inboundId ? await getRequestsForInbound(env.DB, inboundId) : [];
  if (existing.length) return existing;
  const rows = await extractLedgerRequests(env, { contactId, body, subject, docTag });
  if (!rows.length) return [];
  if (persist && inboundId) {
    await createRequests(env.DB, contactId, inboundId, rows);
    return getRequestsForInbound(env.DB, inboundId);
  }
  return rows.map((r, i) => ({ ...r, id: -(i + 1), contact_id: contactId, inbound_id: inboundId, status: 'open', attempts: 0, note: null, fulfilled_by_outbound_id: null }));
}

async function closeRequestsForInbound(env, inboundId, status, note) {
  try {
    const rows = await getRequestsForInbound(env.DB, inboundId);
    const ids = rows.filter(r => r.status === 'open' || r.status === 'in_progress').map(r => r.id);
    if (ids.length) await markRequests(env.DB, ids, status, { note });
  } catch (e) { console.log(`[REQUESTS] close for msg ${inboundId}: ${e.message}`); }
}

// SEND: once the outbound `messages` row exists, link it to the ledger rows
// and the AI's document entries for the inbound it answers. Carry-over parts
// (no inbound) are linked through the note composeReply wrote.
async function linkOutboundToLedger(env, { outboundId, queuePart }) {
  try {
    if (queuePart.inbound_id) {
      await env.DB.prepare(
        "UPDATE requests SET fulfilled_by_outbound_id = ? WHERE inbound_id = ? AND status = 'done' AND fulfilled_by_outbound_id IS NULL"
      ).bind(outboundId, queuePart.inbound_id).run();
      await env.DB.prepare(
        "UPDATE document_entries SET outbound_id = ? WHERE inbound_id = ? AND author = 'ai' AND outbound_id IS NULL"
      ).bind(outboundId, queuePart.inbound_id).run();
    } else {
      // the first part of a carry-over message carries the note's queue id
      await env.DB.prepare(
        "UPDATE requests SET fulfilled_by_outbound_id = ? WHERE contact_id = ? AND status = 'done' AND fulfilled_by_outbound_id IS NULL AND note = ?"
      ).bind(outboundId, queuePart.contact_id || DEFAULT_CONTACT, `carry-over q#${queuePart.id}`).run();
    }
  } catch (e) { console.log(`[REQUESTS] link outbound #${outboundId}: ${e.message}`); }
}

// SEND: every image attached to one queue part (≤ 5, guaranteed at queue time)
async function attachmentsForPart(env, qp) {
  const imageIds = getPartImageIds(qp);
  if (!imageIds.length) return [];
  const imgs = await getImages(env.DB, imageIds);
  if (imgs.length !== imageIds.length) console.log(`queue #${qp.id}: ${imageIds.length - imgs.length} image row(s) missing`);
  return imgs.filter(i => i.data_b64).map(i => ({ filename: imageFilename(i), mime: i.mime || 'image/jpeg', bytesB64: i.data_b64, label: i.label }));
}

// Series parts → one body (doc command lines + "message N/M" markers removed)
function combineSeriesBodies(parts) {
  return parts.map(p => {
    const { cleanBody } = parseDocCommand(p.body);
    return stripSeriesIndicator(cleanBody || p.body);
  }).join('\n\n---\n\n');
}

// ═══════════════════════════════════════════════════════════════
// PHASE 1: SCAN — browser reads inbox, saves new messages to D1
// ═══════════════════════════════════════════════════════════════
// Login with a FRESH Browser Rendering session per attempt — a relaunch gets
// new egress treatment, which matters when Securus degrades one path (the
// Oct 2026 cron-time failures: resets and stalled renders that one-off manual
// runs never hit). Records a diagnostic for every failed attempt.
async function connectAndLogin(env, phase, { attempts = 2, waitMs = 45000 } = {}) {
  for (let a = 1; a <= attempts; a++) {
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      if (await loginToSecurus(page, env)) return { browser, page };
      await recordError(env, `${phase}: login failed (attempt ${a}/${attempts}) — ${lastLoginDiagnostic() || 'no diagnostic'}`);
    } catch (err) {
      await recordError(env, `${phase}: login attempt ${a}/${attempts} threw — ${err.message}`);
    }
    await browser.close().catch(() => {});
    if (a < attempts) await new Promise(r => setTimeout(r, waitMs));
  }
  return null;
}

async function phaseScan(env) {
  console.log('=== PHASE 1: SCAN ===');
  const conn = await connectAndLogin(env, 'scan');
  if (!conn) return { success: false, error: 'Login failed' };
  const { browser, page } = conn;
  try {

    await navigateToInbox(page);
    let allMessages = await enumerateMessages(page);
    if (allMessages.length === 0) {
      // the inbox SPA sometimes renders its table late — a scan that reads 0
      // rows silently skips a whole cycle of inbound pickup. Reload once.
      console.log('inbox showed 0 rows — reloading once to rule out slow render');
      await page.reload({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 4000));
      allMessages = await enumerateMessages(page);
      console.log(`after reload: ${allMessages.length} rows`);
    }

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

    // contacts with ZERO stored messages (just onboarded): their first message
    // may sit below known rows, where the early-stop would never reach it.
    const newContactRows = new Set();
    for (const c of contacts) {
      const has = await env.DB.prepare("SELECT 1 FROM messages WHERE contact_id = ? AND direction='inbound' LIMIT 1").bind(c.id).first();
      if (!has) newContactRows.add(c.id);
    }

    for (let oi = 0; oi < ours.length; oi++) {
      const msg = ours[oi];
      if (consecutiveKnown >= MAX_CONSECUTIVE_KNOWN) {
        const pendingNew = ours.slice(oi).some(r => newContactRows.has(r.contactId));
        if (!pendingNew) {
          console.log(`${consecutiveKnown} consecutive known — stopping scan early`);
          break;
        }
        console.log(`early-stop reached but a new contact's rows remain below — continuing`);
        consecutiveKnown = 0;
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

      // a new message satisfies any standing "more coming — wait" item
      await closeWaitFollowups(env, contactId, newMsgId);

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
        if (isComplete) {
          console.log(`series ${scopedKey} COMPLETE`);
          // ledger: extract ONCE over the combined body, keyed to part 1's id
          // (the id GENERATE queues the series reply under)
          const sParts = await getSeriesParts(env.DB, series.id);
          if (sParts.length) {
            await recordInboundRequests(env, {
              contactId, inboundId: sParts[0].message_id,
              body: combineSeriesBodies(sParts), subject: sParts[0].subject, docTag: series.doc_tag || docTag || null,
            });
          }
        }
      } else {
        await recordInboundRequests(env, { contactId, inboundId: newMsgId, body: body || '', subject: msg.subject, docTag: docTag || null });
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

      // auto-activate staged contacts: a contact registered without a
      // securus_id (awaiting Securus-side approval) is activated the moment
      // their name appears in the compose dropdown — id verified by name match,
      // never guessed — and their stored pending welcome is queued.
      try {
        const staged = (await env.DB.prepare(
          "SELECT * FROM contacts WHERE active = 0 AND securus_id IS NULL"
        ).all()).results;
        for (const sc of staged) {
          const norm = (s) => (s || '').toUpperCase().replace(/\s+/g, ' ').trim();
          const match = ddOptions.find(o => norm(o.text) === norm(sc.name));
          if (!match) continue;
          await env.DB.prepare("UPDATE contacts SET securus_id = ?, active = 1 WHERE id = ?")
            .bind(match.value, sc.id).run();
          console.log(`auto-activated contact "${sc.id}" → securus_id ${match.value} ("${match.text}")`);
          const welcomeRaw = await getState(env.DB, `pending_welcome_${sc.id}`);
          if (welcomeRaw) {
            const welcome = JSON.parse(welcomeRaw);
            const wParts = splitForSend(welcome.subject, welcome.body);
            await queueOutboundParts(env.DB, { inboundId: null, seriesId: null, parts: wParts, docTag: null, contactId: sc.id, securusId: match.value });
            await setState(env.DB, `pending_welcome_${sc.id}`, '');
            console.log(`queued pending welcome for "${sc.id}" (${wParts.length} part(s))`);
          }
          await notifyDennis(env, `securus-agent: contact ${sc.name} appeared in Securus — activated${welcomeRaw ? ', welcome queued' : ''}.`);
        }
      } catch (actErr) {
        console.error(`auto-activate failed: ${actErr.message}`);
      }
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
    await recordError(env, `scan: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2: GENERATE — AI creates responses, saves as drafts
// ═══════════════════════════════════════════════════════════════
// v2 sequence per inbound (docs/V2_ARCHITECTURE.md §3–§9):
//   ledger rows → protected-doc check → MakeNew archive → images FIRST →
//   capability manifest → generateResponse → voice check → budget (≤3 parts)
//   → reconcile ledger → footer → split → queue → attach image ids → doc patch

// topic context for one (contact, tag): message history (capped), imported
// reference content, and the current governing document body
async function loadTopicContext(env, contactId, effectiveTag) {
  const out = { topicHistory: null, knowledgeEntries: [], currentDocument: null, docVersion: null };
  if (!effectiveTag) return out;
  const allTopicMsgs = await getMessagesByDocTag(env.DB, contactId, effectiveTag);
  let totalChars = 0;
  out.topicHistory = [];
  for (let i = allTopicMsgs.length - 1; i >= 0; i--) {
    const bodyLen = (allTopicMsgs[i].body || '').length;
    if (totalChars + bodyLen > MAX_TOPIC_CHARS && out.topicHistory.length > 0) break;
    out.topicHistory.unshift(allTopicMsgs[i]);
    totalChars += bodyLen;
  }
  console.log(`loaded ${out.topicHistory.length}/${allTopicMsgs.length} messages for topic "${effectiveTag}" (${totalChars} chars)`);
  const importContent = await getImportContent(env.DB, contactId, effectiveTag);
  if (importContent) {
    const truncated = importContent.length > 30000 ? importContent.substring(0, 30000) + '\n\n[... truncated ...]' : importContent;
    out.knowledgeEntries.push({ topic: `${effectiveTag} project reference`, content: truncated });
  }
  // the whole combined manuscript is in view while replying, before this edit
  // is applied to it
  const govDoc = await getDocument(env.DB, contactId, effectiveTag);
  if (govDoc?.content) {
    out.currentDocument = govDoc.content;
    out.docVersion = govDoc.version;
    console.log(`loaded governing doc "${contactId}/${effectiveTag}" v${govDoc.version} (${govDoc.content.length} chars) into response context`);
  }
  return out;
}

function imageModelLabel(r) {
  const base = IMAGE_MODELS[r.model]?.label || r.model || 'image model';
  const raw = r.requestedModelRaw || r.requestedModel;
  return r.modelFallback && raw ? `${base} (requested "${raw}" — not available, used Soul)` : base;
}

// Generate every open image request for a message (own + carried over), at
// most MAX_ATTACHMENTS_PER_MESSAGE; the rest stay open for a later message.
// Failures are marked on the ledger here; successes are marked once the parts
// carrying them are queued (composeReply).
async function runImageRequests(env, { contactId, defaultProject, imageRequests, referenceDocs = [], dryRun = false, skip = false }) {
  const todo = imageRequests.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const deferred = imageRequests.slice(MAX_ATTACHMENTS_PER_MESSAGE);
  if (skip) return { results: [], deferred: imageRequests, skipped: true };
  if (!todo.length) return { results: [], deferred, skipped: false };
  if (!hfConfigured(env)) {
    console.log(`${todo.length} image request(s) from ${contactId} but Higgsfield keys not configured — left open`);
    return { results: todo.map(r => ({ ok: false, notConfigured: true, requestId: r.id, label: requestLabel(r) })), deferred, skipped: false };
  }
  const results = [];
  for (const req of todo) {
    const spec = req.spec || {};
    const label = req.label || requestLabel(req);
    let r;
    try {
      r = await runImageGeneration(env, {
        contactId,
        project: spec.project || defaultProject || null,
        intent: spec.prompt || '',
        iterate: !!spec.iterate,
        referenceDocs,
        label,
        model: spec.model || DEFAULT_IMAGE_MODEL,
        requestId: req.id > 0 ? req.id : null,
      });
    } catch (e) {
      r = { ok: false, error: e.message };
    }
    r.requestId = req.id;
    r.label = r.label || label;
    r.requestedModelRaw = spec.modelRaw || spec.model || null;
    results.push(r);
    if (!r.ok && !r.notConfigured && !dryRun && req.id > 0) {
      await markRequests(env.DB, [req.id], 'failed', { note: (r.nsfw ? 'content flagged' : (r.error || 'generation failed')).substring(0, 200), bumpAttempts: true });
    }
    console.log(`[IMAGE] request #${req.id} "${label}" → ${r.ok ? `image #${r.imageId} (${r.model}${r.modelFallback ? ', fallback' : ''})` : (r.notConfigured ? 'not configured' : `FAILED ${r.error}`)}`);
  }
  return { results, deferred, skipped: false };
}

// Insert the reply parts (plus image-only overflow parts when there are more
// image batches than text parts) and attach image ids per part. One insert so
// part_num/total_parts come out right. Returns the queued rows.
async function queueReplyParts(env, { inboundId, seriesId, parts, docTag, contactId, securusId, replySubject, batches }) {
  const allParts = [...parts];
  for (let b = parts.length; b < batches.length; b++) {
    allParts.push({ subject: `${replySubject} (pt ${b + 1})`, body: `More images from your request (${b + 1}/${batches.length}).` });
  }
  const before = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM send_queue").first();
  await queueOutboundParts(env.DB, { inboundId, seriesId, parts: allParts, docTag, contactId, securusId });
  const rows = (await env.DB.prepare(
    "SELECT id, part_num FROM send_queue WHERE id > ? AND contact_id = ? ORDER BY id ASC"
  ).bind(before?.m || 0, contactId).all()).results;
  for (let b = 0; b < batches.length && b < rows.length; b++) {
    try {
      await setPartImageIds(env.DB, rows[b].id, batches[b]);
    } catch (e) {
      // image_ids column missing (migration not run yet): keep the primary image
      console.log(`setPartImageIds failed (${e.message}) — falling back to image_id`);
      await env.DB.prepare("UPDATE send_queue SET image_id = ? WHERE id = ?").bind(batches[b][0], rows[b].id).run();
    }
  }
  return { parts: allParts, rows, firstQueueId: rows[0]?.id || null };
}

// The common reply pipeline: manifest → generate → voice → budget → reconcile
// → footer → split → queue. dryRun skips every write (ledger + queue).
// `carryoverMode` = a standalone follow-up delivering older open items.
async function composeReply(env, {
  contactId, contact, inboundId = null, seriesId = null, replySubject, bodyForAi, ack = '',
  recentHistory, knowledgeEntries = [], topicHistory = null, effectiveTag = null, currentDocument = null, referenceDocs = [],
  isFullDoc = false, imageRun = { results: [], deferred: [] }, ownRequests = [], carried = [], batchSiblings = [],
  dryRun = false, queueDocTag = null, carryoverMode = false,
}) {
  const imgResults = imageRun.results || [];
  const okImages = imgResults.filter(r => r.ok);
  const attachments = okImages.map(r => ({ label: r.label, model: imageModelLabel(r) }));
  const failed = imgResults.filter(r => !r.ok && !r.notConfigured).map(r => ({ label: r.label, reason: r.nsfw ? 'content flagged' : 'generation failed' }));
  // image items that will come LATER (keys missing / over the 5-per-message cap)
  const deferredImages = [
    ...imgResults.filter(r => !r.ok && r.notConfigured).map(r => ({ label: r.label, kind: 'image' })),
    ...(imageRun.deferred || []).map(r => ({ label: requestLabel(r), kind: 'image' })),
  ];
  const isOpen = (r) => r.status === 'open' || r.status === 'in_progress';
  // what the draft is expected to cover: this message's own non-image items +
  // carried-over ones; images reconcile deterministically above
  const candidates = [...ownRequests, ...carried].filter(r => isOpen(r) && r.kind !== 'image' && !isWaitFollowup(r));

  const stampRaw = parseInt(await getState(env.DB, 'stamp_balance') || '', 10);
  const stampBase = Number.isFinite(stampRaw) ? stampRaw : null;
  // Pre-generation the only "later" items are deferred images: the message's
  // own requests are to be ANSWERED now, so they must not be listed as open
  // (the manifest tells the model open items arrive in later messages).
  const manifest = {
    attachments, failed,
    openRequests: [...deferredImages],
    carriedOver: carried.filter(isOpen).map(r => ({ label: requestLabel(r) + (r.note ? ` (still missing: ${r.note})` : '') })),
    stampsLeft: stampBase === null ? null : stampBase - 1,
    batchSiblings,
  };
  const profile = (await getDocument(env.DB, contactId, PROFILE_TAG).catch(() => null))?.content || null;
  const projectState = await projectStateBlock(env, contactId, effectiveTag);
  const genOpts = { fullDocument: isFullDoc, currentDocument, language: contact?.language, contactName: contact?.name, contactNick: contactId, referenceDocs, manifest, profile, projectState };

  let aiResponse = await generateResponse(env, bodyForAi, recentHistory, knowledgeEntries, replySubject.length, topicHistory, effectiveTag, genOpts);
  if (!aiResponse) return null;

  // voice: regenerate ONCE on third-person slips, keep whichever is cleaner
  const names = [contactId, contact?.name].filter(Boolean);
  const slips = voiceViolations(aiResponse, names);
  if (slips.length) {
    console.log(`voice: ${slips.length} third-person slip(s) — regenerating once: ${slips.slice(0, 3).join(' | ')}`);
    const retry = await generateResponse(env, bodyForAi, recentHistory, knowledgeEntries, replySubject.length, topicHistory, effectiveTag, genOpts);
    if (retry && voiceViolations(retry, names).length < slips.length) aiResponse = retry;
  }

  // budget: hard cap on parts; overflow becomes followup requests the ledger delivers later
  const budget = isFullDoc
    ? { text: aiResponse, overflowItems: [], compressed: false, truncated: false }
    : await budgetReply(env, aiResponse, { subject: replySubject, maxParts: MAX_REPLY_PARTS });
  const followups = budget.overflowItems.map(l => ({ kind: 'followup', label: String(l).replace(/\s+/g, ' ').trim().substring(0, 60), spec: { from: 'budget' }, priority: 6 }));
  if (followups.length && !dryRun) await createRequests(env.DB, contactId, inboundId, followups);

  // reconcile: which open items does the draft actually deliver?
  const rec = candidates.length ? await reconcileRequests(env, { draft: budget.text, openRequests: candidates }) : { done: [], partial: [] };
  const doneIds = new Set(rec.done);
  const partialNotes = new Map(rec.partial.map(p => [p.id, p.note]));
  if (candidates.length && !rec.done.length && !rec.partial.length) {
    // inconclusive (API failure or silence): a reply is by construction the
    // answer to its own message; a carry-over message was written for exactly
    // these items. Anything else stays open.
    for (const r of candidates) {
      if (carryoverMode || (r.kind === 'answer' && r.inbound_id === inboundId)) doneIds.add(r.id);
    }
    console.log(`[REQUESTS] reconcile inconclusive — ${doneIds.size}/${candidates.length} assumed covered`);
  }
  const stillOpen = candidates.filter(r => !doneIds.has(r.id));
  manifest.openRequests = [
    ...stillOpen.map(r => ({ label: requestLabel(r), kind: r.kind })),
    ...followups.map(f => ({ label: f.label, kind: 'followup' })),
    ...deferredImages,
  ];

  // text → parts; the stamps line depends on the part count, so split, add
  // the footer, then split again (the footer is short; budget left headroom)
  const cap = isFullDoc ? {} : { maxParts: MAX_REPLY_PARTS };
  let finalText = ack + budget.text;
  let parts = splitForSend(replySubject, finalText, cap);
  manifest.stampsLeft = stampBase === null ? null : stampBase - parts.length;
  const footer = replyFooter(manifest);
  if (footer) {
    finalText += `\n\n— — —\n${footer}`;
    parts = splitForSend(replySubject, finalText, cap);
  }
  const batches = chunkImageIds(okImages.map(r => r.imageId));

  let queued = null;
  if (!dryRun) {
    queued = await queueReplyParts(env, { inboundId, seriesId, parts, docTag: queueDocTag ?? effectiveTag, contactId, securusId: contact?.securus_id, replySubject, batches });
    parts = queued.parts;
    // ledger: fulfilled_by_outbound_id is set in SEND (inbound-linked rows) —
    // standalone carry-overs are linked through the note
    const linkNote = inboundId ? null : `carry-over q#${queued.firstQueueId}`;
    const realDone = [...doneIds].filter(id => id > 0);
    if (realDone.length) await markRequests(env.DB, realDone, 'done', { note: linkNote });
    const okReq = okImages.map(r => r.requestId).filter(id => id > 0);
    if (okReq.length) await markRequests(env.DB, okReq, 'done', { note: linkNote });
    for (const r of stillOpen) {
      if (r.id > 0 && (partialNotes.has(r.id) || r.status === 'in_progress')) {
        await markRequests(env.DB, [r.id], 'open', { note: partialNotes.get(r.id) || null });
      }
    }
  }

  return {
    aiResponse, text: finalText, parts, manifest, footer, budget,
    images: { generated: okImages.map(r => ({ imageId: r.imageId, requestId: r.requestId, label: r.label, model: r.model, modelFallback: !!r.modelFallback })), failed, deferred: deferredImages, batches, skipped: !!imageRun.skipped },
    reconcile: { done: [...doneIds], partial: rec.partial, followups: followups.map(f => f.label) },
    queue: queued ? { firstQueueId: queued.firstQueueId, rows: queued.rows.length } : null,
  };
}

// Project State (v2 §13) for the prompt: current facts + the project's images.
// Safe before the migration has run (table missing ⇒ no block).
async function projectStateBlock(env, contactId, tag) {
  if (!tag) return null;
  try {
    const rows = await getCurrentState(env.DB, contactId, tag);
    const assets = (await listImages(env.DB, contactId, tag).catch(() => [])).slice(0, 8);
    return renderStateBlock(rows, { assets }) || null;
  } catch (e) {
    console.log(`[STATE] block unavailable for ${contactId}/${tag}: ${e.message}`);
    return null;
  }
}

// Settle the project's facts from this exchange and report which stored
// sections now cite a superseded value (the patcher corrects them).
async function updateProjectState(env, { contactId, tag, inboundId, authorText, aiResponse, sections }) {
  try {
    const current = await getCurrentState(env.DB, contactId, tag);
    const changes = await extractStateChanges(env, { tag, currentState: current, authorMessage: authorText, assistantReply: aiResponse, authorName: contactId });
    if (!changes.length) return { changes: 0, superseded: [], stale: [] };
    const applied = await applyStateChanges(env.DB, { contactId, tag, changes, inboundId, author: contactId });
    const stale = applied.superseded.length ? sectionsCitingStale(sections, applied.superseded) : [];
    console.log(`[STATE] ${contactId}/${tag}: +${applied.set.length} set, ${applied.superseded.length} superseded${stale.length ? ` → stale sections: ${stale.join('; ')}` : ''}`);
    return { changes: changes.length, set: applied.set, superseded: applied.superseded, stale };
  } catch (e) {
    console.log(`[STATE] update failed for ${contactId}/${tag}: ${e.message}`);
    return { changes: 0, superseded: [], stale: [], error: e.message };
  }
}

// Governing document maintenance (v2 §6): ledger entry for the author → patch
// (never a whole-document rewrite) → sections saved → ledger entry for the AI.
// v2 §13: facts are settled first so the patch can sweep stale sections.
async function maintainDocument(env, { contactId, contact, cmd, tag, inboundId, authorText, authorSummary, aiResponse }) {
  const today = new Date().toISOString().slice(0, 10);
  const cur = await getSections(env.DB, contactId, tag);
  if (cur?.protected) {
    console.log(`doc "${contactId}/${tag}" is protected — patch skipped`);
    return null;
  }
  const title = cur?.title || docTitle(tag);
  await appendEntry(env.DB, { contactId, tag, author: contactId, entryDate: today, inboundId, content: authorText, summary: (authorSummary || '').substring(0, 200) || null });
  const stateUpdate = await updateProjectState(env, { contactId, tag, inboundId, authorText, aiResponse, sections: cur?.sections || [] });
  const sweep = consistencySweepInstruction(stateUpdate.superseded, stateUpdate.stale);
  // both the sender's direction AND the drafted reply — the reply is where the
  // written content lives (the full draft, not the budgeted send text)
  const newMaterial = `Direction / notes:\n${authorText}\n\n─────\n\nDrafted content (integrate this into the document):\n${aiResponse}${sweep ? `\n\n─────\n\n${sweep}` : ''}`;
  const { patch, changelog, replace } = await buildDocumentPatch(env, {
    tag, title, sections: cur?.sections || [], newMaterial,
    command: cur ? cmd : 'makenew', authorName: contactId, language: contact?.language, entryDate: today,
  });
  const next = applyPatch(replace ? [] : (cur?.sections || []), patch);
  const prevLen = (cur?.doc?.content || '').length;
  const newLen = renderSections(next).length;
  const note = changeNoteFor(cmd, prevLen, newLen);
  const version = await saveSections(env.DB, { contactId, tag, title, sections: next, changelogEntry: changelog || note, changeNote: note, messageId: inboundId, date: today });
  await appendEntry(env.DB, { contactId, tag, author: 'ai', entryDate: today, inboundId, summary: (changelog || note).substring(0, 500), content: aiResponse.substring(0, 20000) });
  console.log(`governing doc "${contactId}/${tag}" → v${version} (${prevLen} → ${newLen} chars; ${changelog || note})`);
  return { version, changelog: changelog || note, prevLen, newLen, state: stateUpdate };
}

// MakeNew/MakeUpdate against a protected doc: refuse, say so, never patch.
async function refuseProtectedDoc(env, { contactId, contact, inboundId, seriesId = null, tag, replySubject, dryRun }) {
  const name = capitalize(tag);
  const body = `${name} is a protected reference document, so I didn't change it — it stays exactly as it is. ` +
    `If you want to build on it, send "MakeNew <newname>" and tell me to reference ${name}, ` +
    `or ask me to copy it into a working document.`;
  const parts = splitForSend(replySubject, body);
  if (!dryRun) {
    await queueOutboundParts(env.DB, { inboundId, seriesId, parts, docTag: tag, contactId, securusId: contact?.securus_id });
    await closeRequestsForInbound(env, inboundId, 'cancelled', `protected document "${tag}" — command refused`);
  }
  console.log(`protected doc "${contactId}/${tag}": command refused, notice queued`);
  return parts;
}

function archiveAckLine(tag, archivedAs) {
  return archivedAs
    ? `(The previous ${capitalize(tag)} document is kept untouched as "${archivedAs}" — reference it any time with MakeReference ${archivedAs}.)\n\n`
    : '';
}

// One non-series inbound → one queued reply. `batch` is every unresponded
// inbound from the same contact this cycle (siblings go in the manifest).
// dryRun: full pipeline, zero writes — used by /draft?id= replays.
async function generateForInbound(env, msg, { batch = [], dryRun = false, images = true } = {}) {
  const contactId = msg.contact_id || DEFAULT_CONTACT;
  const contact = await getContact(env.DB, contactId);
  const inboundId = msg.id;
  console.log(`generating response for message ${msg.id} (contact ${contactId}): "${msg.subject?.substring(0, 60)}"${dryRun ? ' [DRY RUN]' : ''}`);

  // strip the directive grammar from what the model reads. Position-aware
  // parsers (image directives, inline makeimage) run on the ORIGINAL body;
  // the doc command / legacy MakeImage line and MakeReference lines follow.
  const original = msg.body || '';
  const dir = parseImageDirectives(original);
  const inlineImg = parseInlineImage(dir.cleanBody || '');
  let text = inlineImg.cleanBody || '';
  const docParse = parseDocCommand(text);
  const legacyImg = docParse.command ? null : legacyImageCommand(text);
  if (docParse.command) text = docParse.cleanBody || '';
  else if (legacyImg) text = legacyImg.intent || '';
  const refParse = parseReferenceDirectives(text);
  text = refParse.cleanBody || '';
  // a message that was ONLY directives still needs to reach the model as asked
  const bodyForAi = text.trim() || original;

  const effectiveTag = msg.doc_tag || docParse.docTag || null;
  const isFullDoc = docParse.command === 'makefull';
  const replySubject = makeReplySubject(msg.subject);

  // references: explicit MakeReference tags + plain-language mentions (same contact only)
  const referenceDocs = [];
  for (const refTag of refParse.refs) {
    if (refTag === effectiveTag) continue;
    const refDoc = await getDocument(env.DB, contactId, refTag);
    if (refDoc?.content) {
      referenceDocs.push({ name: refTag, content: refDoc.content });
      console.log(`reference doc loaded: ${contactId}/${refTag} (${refDoc.content.length} chars)`);
    } else {
      console.log(`reference doc "${refTag}" requested but not found for ${contactId}`);
    }
  }
  referenceDocs.push(...await loadPlainLanguageRefs(env, { contactId, body: bodyForAi, excludeTag: effectiveTag, already: referenceDocs }));

  // ledger: this message's items (extracted now if SCAN didn't) + carry-overs
  let ownRequests = await ensureRequests(env, { contactId, inboundId, body: original, subject: msg.subject, docTag: effectiveTag, persist: !dryRun });
  const carried = (await getCarryoverRequests(env.DB, contactId, inboundId, { limit: 6 })).filter(r => !isWaitFollowup(r));

  const dryDetail = (extra) => dryRun ? { requests: ownRequests, carried, ...extra } : undefined;

  // protected reference docs (and the pipeline's own profile) take no commands
  if ((docParse.command === 'makenew' || docParse.command === 'makeupdate') && effectiveTag
      && (effectiveTag === PROFILE_TAG || await isProtected(env.DB, contactId, effectiveTag))) {
    const parts = await refuseProtectedDoc(env, { contactId, contact, inboundId, tag: effectiveTag, replySubject, dryRun });
    return { id: msg.id, status: 'protected_doc_refused', contact: contactId, tag: effectiveTag, parts: parts.length, dry: dryDetail({ parts: parts.map(p => ({ subject: p.subject, len: p.body.length })) }) };
  }

  // makefull: send the CURRENT governing document (not a fresh regeneration); uncapped split
  if (isFullDoc && effectiveTag) {
    const govDoc = await getDocument(env.DB, contactId, effectiveTag);
    if (govDoc?.content) {
      const parts = splitForSend(replySubject, docAcknowledgment('makefull', effectiveTag) + govDoc.content);
      if (!dryRun) {
        await queueOutboundParts(env.DB, { inboundId, seriesId: null, parts, docTag: effectiveTag, contactId, securusId: contact?.securus_id });
        await closeRequestsForInbound(env, inboundId, 'done', `makefull: document v${govDoc.version} sent`);
      }
      console.log(`makefull: queued governing "${contactId}/${effectiveTag}" doc v${govDoc.version} (${parts.length} parts)`);
      return { id: msg.id, status: 'sent_full_doc', contact: contactId, tag: effectiveTag, version: govDoc.version, parts: parts.length, dry: dryDetail({ parts: parts.map(p => ({ subject: p.subject, len: p.body.length })) }) };
    }
    // no stored doc yet → fall through to generate one from history
  }

  // MakeNew on an existing tag archives it FIRST (so the ack can name the
  // archive and the model starts from a blank document)
  let archivedAs = null;
  if (docParse.command === 'makenew' && effectiveTag) {
    if (dryRun) archivedAs = (await getDocument(env.DB, contactId, effectiveTag)) ? '(would archive)' : null;
    else {
      archivedAs = await archiveDocument(env.DB, contactId, effectiveTag);
      if (archivedAs) console.log(`makenew: archived ${contactId}/${effectiveTag} → ${archivedAs}`);
    }
  }

  const ctx = await loadTopicContext(env, contactId, effectiveTag);
  const recentHistory = await getRecentMessages(env.DB, 10, contactId);

  // images FIRST — the manifest states facts, not intentions. The ledger is
  // the single image pipeline; the legacy grammars only create a row when the
  // ledger has none for this message.
  const openImage = (r) => r.kind === 'image' && (r.status === 'open' || r.status === 'in_progress');
  if (!ownRequests.some(r => r.kind === 'image')) {
    let prompt = null, project = effectiveTag || null, iterate = false;
    if (legacyImg) {
      prompt = legacyImg.intent || null; project = legacyImg.project || null; iterate = legacyImg.iterate || !legacyImg.intent;
    } else if (inlineImg.imagePrompt !== null) {
      prompt = inlineImg.imagePrompt || bodyForAi;
    } else if (hfConfigured(env)
        && /\b(image|picture|photo|logo|draw|drawing|design|art|illustration|poster|portrait)\b/i.test(bodyForAi)
        && /\b(make|create|generate|draw|design|render)\b/i.test(bodyForAi)) {
      try {
        const known = (await getAllDocTags(env.DB, contactId)).filter(isUserTag);
        const intent = await resolveImageIntent(env, { body: bodyForAi, knownProjects: known });
        if (intent.wantsImage && intent.prompt) {
          prompt = intent.prompt; project = intent.project || effectiveTag || null;
          console.log(`plain-language image intent resolved: project=${project || 'standalone'}`);
        }
      } catch (riErr) { console.log(`image intent resolver: ${riErr.message}`); }
    }
    if (prompt !== null || iterate) {
      const row = { kind: 'image', label: project ? `${capitalize(project)} image` : 'Image', spec: { prompt, project, iterate, model: null, group: null, legacy: 'generate' }, priority: 6 };
      if (dryRun) ownRequests = [...ownRequests, { ...row, id: -(ownRequests.length + 1), contact_id: contactId, inbound_id: inboundId, status: 'open', attempts: 0, note: null }];
      else { await createRequests(env.DB, contactId, inboundId, [row]); ownRequests = await getRequestsForInbound(env.DB, inboundId); }
    }
  }
  const imageRequests = [...ownRequests.filter(openImage), ...carried.filter(openImage)];
  const imageRun = await runImageRequests(env, { contactId, defaultProject: effectiveTag, imageRequests, referenceDocs, dryRun, skip: !images });

  let ack = docAcknowledgment(docParse.command, docParse.docTag) + archiveAckLine(effectiveTag, archivedAs);
  if (referenceDocs.length) {
    const names = referenceDocs.map(r => capitalize(r.name)).join(', ');
    ack += `(Used your ${names} document${referenceDocs.length > 1 ? 's' : ''} as reference.)\n\n`;
  }
  const batchSiblings = batch.filter(m => m.id !== msg.id).map(m => ({ subject: m.subject || '(no subject)' }));

  const reply = await composeReply(env, {
    contactId, contact, inboundId, replySubject, bodyForAi, ack,
    recentHistory, knowledgeEntries: ctx.knowledgeEntries, topicHistory: ctx.topicHistory, effectiveTag, currentDocument: ctx.currentDocument, referenceDocs,
    isFullDoc, imageRun, ownRequests, carried, batchSiblings, dryRun, queueDocTag: effectiveTag,
  });
  if (!reply) {
    if (!dryRun) await recordError(env, `AI returned empty for msg ${msg.id}`);
    return { id: msg.id, status: 'no_response', dry: dryDetail({}) };
  }

  // maintain the governing document in place — separate from the reply above
  let doc = null;
  if ((docParse.command === 'makenew' || docParse.command === 'makeupdate') && effectiveTag && !dryRun) {
    try {
      doc = await maintainDocument(env, { contactId, contact, cmd: docParse.command, tag: effectiveTag, inboundId, authorText: bodyForAi, authorSummary: msg.subject, aiResponse: reply.aiResponse });
    } catch (docErr) {
      console.error(`doc patch failed for "${contactId}/${effectiveTag}": ${docErr.message}`);
    }
  }

  console.log(`response ${dryRun ? 'drafted' : 'queued'} for msg ${msg.id} (${reply.parts.length} parts, ${reply.text.length} chars, ${reply.images.generated.length} image(s))`);
  return {
    id: msg.id, status: 'generated', contact: contactId, parts: reply.parts.length, chars: reply.aiResponse.length,
    images: reply.images.generated.length, docVersion: doc?.version ?? null, archivedAs,
    requestsDone: reply.reconcile.done.length, followups: reply.reconcile.followups.length,
    dry: dryDetail({
      manifest: reply.manifest, footer: reply.footer,
      parts: reply.parts.map(p => ({ subject: p.subject, len: p.body.length })),
      imagePlan: { requested: imageRequests.length, ...reply.images },
      reconcile: reply.reconcile, budget: { compressed: !!reply.budget.compressed, truncated: !!reply.budget.truncated, overflow: reply.budget.overflowItems },
      text: reply.text,
    }),
  };
}

// A complete inbound series → one queued reply (same recipe, combined body,
// keyed to part 1's message id).
async function generateForSeries(env, series) {
  console.log(`processing complete series: ${series.series_key} (${series.total_parts} parts)`);
  const parts = await getSeriesParts(env.DB, series.id);
  if (!parts.length) return { seriesKey: series.series_key, status: 'error', error: 'no parts' };
  const rawCombined = combineSeriesBodies(parts);
  const dir = parseImageDirectives(rawCombined);
  const refParse = parseReferenceDirectives(dir.cleanBody || '');
  const combinedBody = (refParse.cleanBody || '').trim() || rawCombined;

  const contactId = series.contact_id || DEFAULT_CONTACT;
  const contact = await getContact(env.DB, contactId);
  const effectiveTag = series.doc_tag || null;
  const effectiveCmd = series.doc_command || null;
  const isFullDoc = effectiveCmd === 'makefull';
  const primaryId = parts[0].message_id;
  const replySubject = effectiveTag ? safeSubject(`RE: ${capitalize(effectiveTag)} Update`) : makeReplySubject(parts[0].subject);

  if ((effectiveCmd === 'makenew' || effectiveCmd === 'makeupdate') && effectiveTag
      && (effectiveTag === PROFILE_TAG || await isProtected(env.DB, contactId, effectiveTag))) {
    await refuseProtectedDoc(env, { contactId, contact, inboundId: primaryId, seriesId: series.id, tag: effectiveTag, replySubject, dryRun: false });
    await markSeriesProcessed(env.DB, series.id);
    return { id: primaryId, status: 'protected_doc_refused', type: 'series', contact: contactId, tag: effectiveTag, seriesKey: series.series_key };
  }

  let archivedAs = null;
  if (effectiveCmd === 'makenew' && effectiveTag) {
    archivedAs = await archiveDocument(env.DB, contactId, effectiveTag);
    if (archivedAs) console.log(`makenew(series): archived ${contactId}/${effectiveTag} → ${archivedAs}`);
  }

  const ctx = await loadTopicContext(env, contactId, effectiveTag);
  const recentHistory = await getRecentMessages(env.DB, 10, contactId);
  const referenceDocs = [];
  for (const refTag of refParse.refs) {
    if (refTag === effectiveTag) continue;
    const rd = await getDocument(env.DB, contactId, refTag);
    if (rd?.content) referenceDocs.push({ name: refTag, content: rd.content });
  }
  referenceDocs.push(...await loadPlainLanguageRefs(env, { contactId, body: combinedBody, excludeTag: effectiveTag, already: referenceDocs }));

  const ownRequests = await ensureRequests(env, { contactId, inboundId: primaryId, body: rawCombined, subject: parts[0].subject, docTag: effectiveTag });
  const carried = (await getCarryoverRequests(env.DB, contactId, primaryId, { limit: 6 })).filter(r => !isWaitFollowup(r));
  const openImage = (r) => r.kind === 'image' && (r.status === 'open' || r.status === 'in_progress');
  const imageRequests = [...ownRequests.filter(openImage), ...carried.filter(openImage)];
  const imageRun = await runImageRequests(env, { contactId, defaultProject: effectiveTag, imageRequests, referenceDocs });

  let ack = docAcknowledgment(effectiveCmd, effectiveTag, { total: series.total_parts }) + archiveAckLine(effectiveTag, archivedAs);
  if (referenceDocs.length) {
    const names = referenceDocs.map(r => capitalize(r.name)).join(', ');
    ack += `(Used your ${names} document${referenceDocs.length > 1 ? 's' : ''} as reference.)\n\n`;
  }

  const reply = await composeReply(env, {
    contactId, contact, inboundId: primaryId, seriesId: series.id, replySubject, bodyForAi: combinedBody, ack,
    recentHistory, knowledgeEntries: ctx.knowledgeEntries, topicHistory: ctx.topicHistory, effectiveTag, currentDocument: ctx.currentDocument, referenceDocs,
    isFullDoc, imageRun, ownRequests, carried, batchSiblings: [], queueDocTag: effectiveTag,
  });
  if (!reply) return { seriesKey: series.series_key, status: 'no_response' };

  let doc = null;
  if ((effectiveCmd === 'makenew' || effectiveCmd === 'makeupdate') && effectiveTag) {
    try {
      doc = await maintainDocument(env, { contactId, contact, cmd: effectiveCmd, tag: effectiveTag, inboundId: primaryId, authorText: combinedBody, authorSummary: parts[0].subject, aiResponse: reply.aiResponse });
    } catch (docErr) { console.error(`series doc patch failed (${contactId}/${effectiveTag}): ${docErr.message}`); }
  }
  await markSeriesProcessed(env.DB, series.id);
  console.log(`series ${series.series_key} response queued (${reply.parts.length} parts, ${reply.text.length} chars)`);
  return { id: primaryId, status: 'generated', type: 'series', contact: contactId, parts: reply.parts.length, seriesKey: series.series_key, images: reply.images.generated.length, docVersion: doc?.version ?? null, archivedAs };
}

// Carry-over delivery (v2 §3): a contact with nothing new this cycle but open
// non-image items older than CARRYOVER_MIN_AGE_HOURS gets ONE standalone
// message delivering up to MAX_CARRYOVER_PER_MESSAGE of them. This is what
// makes "the rest is coming" real. Items that fail to deliver repeatedly are
// parked as 'deferred' rather than re-sent forever.
async function deliverCarryover(env, contact) {
  const contactId = contact.id;
  const lastSent = await getState(env.DB, `carryover_sent_at_${contactId}`);
  if (lastSent && Date.now() - new Date(lastSent).getTime() < CARRYOVER_COOLDOWN_HOURS * 3600e3) return null;
  // created_at: old enough to have missed a reply; updated_at: not touched by
  // this cycle's or the last cycle's attempt
  const rows = (await env.DB.prepare(
    `SELECT * FROM requests WHERE contact_id = ? AND status IN ('open','in_progress') AND kind != 'image'
     AND created_at < datetime('now', ?) AND updated_at < datetime('now', ?) ORDER BY priority DESC, id ASC LIMIT 12`
  ).bind(contactId, `-${CARRYOVER_MIN_AGE_HOURS} hours`, `-${CARRYOVER_MIN_AGE_HOURS} hours`).all()).results.map(r => {
    let spec = null; try { spec = r.spec ? JSON.parse(r.spec) : null; } catch { spec = null; }
    return { ...r, spec };
  });
  const eligible = [];
  for (const r of rows) {
    if (isWaitFollowup(r)) continue;
    if ((r.attempts || 0) >= MAX_CARRYOVER_ATTEMPTS) {
      await markRequests(env.DB, [r.id], 'deferred', { note: `carry-over: ${r.attempts} attempts without delivery` });
      continue;
    }
    eligible.push(r);
    if (eligible.length >= MAX_CARRYOVER_PER_MESSAGE) break;
  }
  if (!eligible.length) return null;
  console.log(`carry-over for ${contactId}: delivering ${eligible.length} open item(s): ${eligible.map(r => `#${r.id}`).join(', ')}`);
  await markRequests(env.DB, eligible.map(r => r.id), 'in_progress', { bumpAttempts: true });

  // the originating messages give the model the actual asks (scoped to this contact)
  const sources = new Map();
  for (const id of [...new Set(eligible.map(r => r.inbound_id).filter(Boolean))]) {
    const m = await env.DB.prepare("SELECT id, subject, body, timestamp, doc_tag FROM messages WHERE id = ? AND contact_id = ?").bind(id, contactId).first();
    if (m) sources.set(id, m);
  }
  const tagCounts = {};
  for (const m of sources.values()) if (m.doc_tag) tagCounts[m.doc_tag] = (tagCounts[m.doc_tag] || 0) + 1;
  const effectiveTag = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a])[0] || null;

  const list = eligible.map((r, i) => {
    const s = sources.get(r.inbound_id);
    return `${i + 1}. ${requestLabel(r)}${r.note ? ` — still missing: ${r.note}` : ''}${s ? ` (from "${s.subject}", ${(s.timestamp || '').substring(0, 10)})` : ''}`;
  }).join('\n');
  const excerpts = [...sources.values()].map(s => `--- "${s.subject}" (${(s.timestamp || '').substring(0, 10)}) ---\n${(s.body || '').substring(0, 3000)}`).join('\n\n');
  const bodyForAi = `[Delivery note from the system — this is NOT a new message from ${contactId}. The items below from ${contactId}'s earlier messages are still owed. Write ONE message as Dennis that delivers them now: open by saying this is the rest of what was asked for, then cover each item fully. Do not promise anything further.]\n\nITEMS STILL OWED:\n${list}\n\nTHE ORIGINAL MESSAGES THESE CAME FROM:\n${excerpts || '(not available)'}`;

  const ctx = await loadTopicContext(env, contactId, effectiveTag);
  const recentHistory = await getRecentMessages(env.DB, 10, contactId);
  const replySubject = safeSubject(`Follow-up: ${requestLabel(eligible[0])}`);
  const reply = await composeReply(env, {
    contactId, contact, inboundId: null, replySubject, bodyForAi, ack: '',
    recentHistory, knowledgeEntries: ctx.knowledgeEntries, topicHistory: ctx.topicHistory, effectiveTag, currentDocument: ctx.currentDocument, referenceDocs: [],
    isFullDoc: false, imageRun: { results: [], deferred: [] }, ownRequests: [], carried: eligible, batchSiblings: [], queueDocTag: effectiveTag, carryoverMode: true,
  });
  if (!reply) {
    await markRequests(env.DB, eligible.map(r => r.id), 'open');
    return { contact: contactId, status: 'carryover_no_response', items: eligible.map(r => r.id) };
  }
  await setState(env.DB, `carryover_sent_at_${contactId}`, new Date().toISOString());
  console.log(`carry-over for ${contactId} queued (${reply.parts.length} parts; delivered ${reply.reconcile.done.length}/${eligible.length})`);
  return { contact: contactId, status: 'carryover_queued', items: eligible.map(r => r.id), delivered: reply.reconcile.done, parts: reply.parts.length, subject: replySubject };
}

const QUEUED_STATUSES = new Set(['generated', 'sent_full_doc', 'protected_doc_refused', 'carryover_queued']);

async function phaseGenerate(env) {
  console.log('=== PHASE 2: GENERATE ===');
  let generated = 0;
  const results = [];
  const outputContacts = new Set();   // profile refresh candidates
  const touchedContacts = new Set();  // had inbound this cycle → no carry-over message

  // Capability-announcement gate: Sam's full instruction message is stored in
  // state and sends itself once Higgsfield keys are present AND a smoke-test
  // generation succeeds — zero-touch launch of the image feature.
  try {
    const pending = await getState(env.DB, 'capability_msg_pending');
    if (pending === 'awaiting_keys' && hfConfigured(env)) {
      console.log('capability msg: keys detected — running image smoke test');
      const smoke = await generateImage(env, { prompt: 'a simple friendly test image: sunrise over mountains, soft colors', pollSeconds: 60 });
      if (smoke.success) {
        const draft = JSON.parse(await getState(env.DB, 'capability_msg_draft') || 'null');
        if (draft) {
          // the announcement itself carries the smoke-test image — the first
          // real send proves the attachment pipeline end-to-end
          const smokeImageId = await saveImage(env.DB, { contactId: 'sam', docTag: 'standalone', intent: 'image feature launch sample', prompt: 'sunrise over mountains, soft colors', label: 'Sample', model: smoke.model, hfRequestId: smoke.requestId, mime: smoke.mime, dataB64: smoke.bytesB64, cost: smoke.cost ?? PER_IMAGE_COST });
          const sam = await getContact(env.DB, 'sam');
          const parts = splitForSend(draft.subject, draft.body);
          await queueOutboundParts(env.DB, { inboundId: null, seriesId: null, parts, docTag: null, contactId: 'sam', securusId: sam?.securus_id });
          await env.DB.prepare("UPDATE send_queue SET image_id = ? WHERE contact_id='sam' AND inbound_id IS NULL AND image_id IS NULL AND part_num = 1 AND status='pending' AND subject = ?").bind(smokeImageId, safeSubject(draft.subject)).run();
          await setState(env.DB, 'capability_msg_pending', 'queued');
          console.log('capability msg: smoke test passed — instructions queued to sam WITH sample image');
          await notifyDennis(env, 'securus-agent: image generation verified — capability instructions (with sample image attached) queued to Sam.');
        }
      } else {
        console.log(`capability msg: smoke test failed (${smoke.error}) — will retry next cron`);
      }
    }
  } catch (capErr) { console.error(`capability msg gate: ${capErr.message}`); }

  // process complete inbound series first
  const completeSeries = await getCompleteSeries(env.DB);
  for (const series of completeSeries) {
    const cid = series.contact_id || DEFAULT_CONTACT;
    touchedContacts.add(cid);
    try {
      const r = await generateForSeries(env, series);
      results.push(r);
      if (QUEUED_STATUSES.has(r.status)) { generated++; outputContacts.add(cid); }
    } catch (genErr) {
      console.error(`series generation error for ${series.series_key}: ${genErr.message}`);
      results.push({ seriesKey: series.series_key, status: 'error', error: genErr.message });
    }
  }

  // individual (non-series) unresponded messages, per contact in send order —
  // the batch list lets each reply know about its siblings (v2 §7)
  const pending = (await getUnrespondedInbound(env.DB)).sort((a, b) => a.id - b.id);
  const batchByContact = new Map();
  for (const m of pending) {
    const cid = m.contact_id || DEFAULT_CONTACT;
    if (!batchByContact.has(cid)) batchByContact.set(cid, []);
    batchByContact.get(cid).push(m);
  }
  const skippedIds = new Set(); // deduped/escalated this cycle → not "siblings awaiting a reply"
  for (const msg of pending) {
    const cid = msg.contact_id || DEFAULT_CONTACT;
    touchedContacts.add(cid);
    skippedIds.add(msg.id); // cleared below once the message is really generated for

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
    ).bind(cid, replySubjectCheck, msg.timestamp).first();
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
      await closeRequestsForInbound(env, msg.id, 'cancelled', `duplicate of message #${dup.id}`);
      console.log(`dedup(content): msg ${msg.id} is a near-duplicate of ${dup.id}, mirrored response ${marker}`);
      results.push({ id: msg.id, status: 'duplicate', of: dup.id });
      continue;
    }

    if (shouldEscalate(msg.body)) {
      console.log(`ESCALATION: message ${msg.id} flagged for manual review`);
      await notifyDennis(env, `⚠ ESCALATION: message from ${msg.sender} needs manual review:\n\n${msg.body?.substring(0, 300)}`);
      await env.DB.prepare("UPDATE messages SET responded_at = 'escalated' WHERE id = ?").bind(msg.id).run();
      await closeRequestsForInbound(env, msg.id, 'deferred', 'escalated to Dennis');
      results.push({ id: msg.id, status: 'escalated' });
      continue;
    }

    try {
      skippedIds.delete(msg.id);
      const batch = (batchByContact.get(cid) || []).filter(m => !skippedIds.has(m.id));
      const r = await generateForInbound(env, msg, { batch });
      results.push(r);
      if (QUEUED_STATUSES.has(r.status)) { generated++; outputContacts.add(cid); }
    } catch (genErr) {
      console.error(`generation error for message ${msg.id}: ${genErr.message}`);
      results.push({ id: msg.id, status: 'error', error: genErr.message });
      await recordError(env, `generation failed for msg ${msg.id}: ${genErr.message}`);
    }
  }

  // carry-over delivery: contacts with nothing new this cycle but open items
  // old enough to have missed a reply — one standalone message each
  try {
    const active = await getContacts(env.DB, { activeOnly: true });
    for (const c of active) {
      if (touchedContacts.has(c.id) || !c.securus_id) continue;
      try {
        const r = await deliverCarryover(env, c);
        if (r) {
          results.push(r);
          if (QUEUED_STATUSES.has(r.status)) { generated++; outputContacts.add(c.id); }
        }
      } catch (coErr) {
        console.error(`carry-over for ${c.id} failed: ${coErr.message}`);
        results.push({ contact: c.id, status: 'carryover_error', error: coErr.message });
      }
    }
  } catch (listErr) { console.error(`carry-over contact listing failed: ${listErr.message}`); }

  // contact profile refresh — once per contact that got output this cycle (v2 §8)
  for (const cid of outputContacts) {
    try {
      const p = await refreshProfile(env, cid);
      if (p) results.push({ contact: cid, status: 'profile_refreshed', version: p.version, chars: p.chars });
    } catch (pErr) { console.error(`profile refresh for ${cid} failed: ${pErr.message}`); }
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
  const conn = await connectAndLogin(env, 'send');
  if (!conn) return { success: false, error: 'Login failed' };
  const { browser, page } = conn;

  try {

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

      // fetched per part, never for the whole queue (5 × ~3MB base64 in memory)
      const attachments = await attachmentsForPart(env, qp);
      const sendResult = await composeAndSend(page, {
        contactId: rcpt.securusId,
        contactName: rcpt.name,
        subject: qp.subject,
        body: qp.body,
        attachments,
      });
      if (sendResult.attachments) console.log(`queue #${qp.id}: attachments requested=${sendResult.attachments.requested} attached=${sendResult.attachments.attached} registered=${sendResult.attachments.registered}`);

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
        await linkOutboundToLedger(env, { outboundId, queuePart: qp });

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
        // persist the compose diagnostic with the error — console logs from
        // cron runs are otherwise unreachable
        const d = sendResult.diag;
        const errDetail = (sendResult.error || 'unknown')
          + (d ? ` [body=${d.bodyLen} subj=${d.subjLen} contact=${d.contactValue}; page: ${(d.text || '').replace(/\s+/g, ' ').substring(0, 180)}]` : '')
          + (sendResult.modalText ? ` [modal: ${sendResult.modalText.replace(/\s+/g, ' ').substring(0, 150)}]` : '');
        const exhausted = await markPartFailed(env.DB, qp.id, errDetail);
        results.push({ queueId: qp.id, part: `${qp.part_num}/${qp.total_parts}`, status: exhausted ? 'failed_final' : 'failed_will_retry', error: sendResult.error });
        console.log(`queue #${qp.id} FAILED (${exhausted ? 'retries exhausted' : 'will retry'}): ${sendResult.error}`);
        // only page Dennis once the part has exhausted its automatic retries —
        // transient Securus hiccups retry silently on the next cron.
        if (exhausted) {
          await notifyDennis(env, `securus-agent: queue part ${qp.id} (inbound ${qp.inbound_id}) failed permanently after retries: ${sendResult.error}. Needs manual attention.`);
        }
        // reset to my-account so the next part's compose boots clean — a
        // failed compose can strand the SPA mid-form
        await safeGoto(page, urls.myAccount).catch(() => {});
        await humanDelay(1500, 2500);
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
    await recordError(env, `send: ${err.message}`);
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

    // ═══ Tenant (customer Securus account) endpoints — called by foxvox-portal over a
    // service binding with `Authorization: Bearer PORTAL_TOKEN`. Never public without the token.
    if (url.pathname.startsWith('/tenant/')) {
      if (!env.PORTAL_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.PORTAL_TOKEN}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return handleTenantRoute(request, env, url);
    }

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
        // v2: every document row (protected / version / length — archived and
        // pipeline docs included) + request ledger counts for this contact
        const documents = await listDocumentsForContact(env.DB, contactId).catch(() => []);
        const byTag = new Map(documents.map(d => [d.tag, d]));
        data.documents = documents.map(d => ({ ...d, archived: ARCHIVED_TAG_RE.test(d.tag), system: d.tag === PROFILE_TAG }));
        data.docs = (data.docs || []).map(row => {
          const d = byTag.get(row.doc_tag);
          return d ? { ...row, protected: d.protected, version: d.version, length: d.length } : { ...row, protected: false, version: row.doc_version || null, length: row.doc_len || null };
        });
        data.requestCounts = await requestCounts(env.DB, contactId).catch(() => null);
        return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
      } catch (err) {
        return Response.json({ error: err.message, stack: err.stack?.substring(0, 400) }, { status: 500 });
      }
    }

    // request ledger (v2 §3). GET /api/requests?contact=&status= → rows + counts.
    // POST /api/requests/{id} { status, note? } → admin reset / cancel.
    if (url.pathname === '/api/requests' || url.pathname.startsWith('/api/requests/')) {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const REQ_STATUSES = ['open', 'in_progress', 'done', 'deferred', 'failed', 'cancelled'];
      const parseReq = (row) => {
        if (!row) return null;
        let spec = null; try { spec = row.spec ? JSON.parse(row.spec) : null; } catch { spec = null; }
        return { ...row, spec };
      };
      try {
        const idPart = url.pathname.split('/')[3];
        if (idPart) {
          const id = parseInt(idPart, 10);
          if (isNaN(id)) return Response.json({ error: 'invalid id' }, { status: 400 });
          const row = parseReq(await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first());
          if (!row) return Response.json({ error: 'not found' }, { status: 404 });
          if (request.method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
            if (!REQ_STATUSES.includes(body.status)) return Response.json({ error: `status must be one of ${REQ_STATUSES.join(', ')}` }, { status: 400 });
            const note = body.note === undefined || body.note === null ? null : String(body.note).substring(0, 300);
            await markRequests(env.DB, [id], body.status, { note });
            if (body.status === 'open') {
              // admin reset: let the carry-over path try again from scratch
              await env.DB.prepare("UPDATE requests SET attempts = 0, fulfilled_by_outbound_id = NULL WHERE id = ?").bind(id).run();
            }
            return Response.json({ request: parseReq(await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first()) }, { headers: { 'Cache-Control': 'no-store' } });
          }
          return Response.json({ request: row }, { headers: { 'Cache-Control': 'no-store' } });
        }
        const contactId = (url.searchParams.get('contact') || DEFAULT_CONTACT).toLowerCase();
        const status = url.searchParams.get('status') || null;
        if (status && !REQ_STATUSES.includes(status)) return Response.json({ error: 'unknown status' }, { status: 400 });
        const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
        const requests = (await listRequests(env.DB, contactId, { status, limit })).map(r => ({
          id: r.id, inbound_id: r.inbound_id, kind: r.kind, label: r.label, spec: r.spec, status: r.status, priority: r.priority,
          fulfilled_by_outbound_id: r.fulfilled_by_outbound_id, attempts: r.attempts, note: r.note, created_at: r.created_at, updated_at: r.updated_at,
        }));
        return Response.json({ contactId, requests, counts: await requestCounts(env.DB, contactId) }, { headers: { 'Cache-Control': 'no-store' } });
      } catch (err) {
        // table missing until /migrate runs
        return Response.json({ error: err.message, requests: [], counts: { open: 0, in_progress: 0, done: 0, deferred: 0, failed: 0, cancelled: 0 } }, { status: /no such table/i.test(err.message) ? 200 : 500 });
      }
    }

    // /image-test — admin: probe HF auth variants; ?generate=1 runs a real
    // cheap generation and stores it as a standalone image.
    if (url.pathname === '/image-test') {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (!hfConfigured(env)) return Response.json({ configured: false, note: 'HF_API_KEY_SECRET not set' });
      const probes = [];
      for (const auth of hfAuthCandidates(env)) {
        const masked = auth.replace(/(.{10}).+(.{4})/, '$1…$2');
        try {
          const r = await fetch('https://api.higgsfield.ai/requests/00000000-0000-0000-0000-000000000000/status', { headers: { Authorization: auth } });
          probes.push({ auth: masked, status: r.status, authOk: r.status !== 401 && r.status !== 403 });
        } catch (e) { probes.push({ auth: masked, error: e.message }); }
      }
      let generation = null;
      const model = url.searchParams.get('model') || DEFAULT_IMAGE_MODEL;
      if (url.searchParams.get('generate') === '1') {
        const prompt = url.searchParams.get('prompt') || 'warm sunrise over calm mountains, soft watercolor style';
        const gen = await generateImage(env, { prompt, model, pollSeconds: 90 });
        if (gen.success) {
          const id = await saveImage(env.DB, { contactId: 'sam', docTag: 'standalone', intent: 'auth/integration test', prompt, label: `test-${gen.model}`, model: gen.model, hfRequestId: gen.requestId, mime: gen.mime, dataB64: gen.bytesB64, cost: gen.cost ?? PER_IMAGE_COST });
          generation = { success: true, imageId: id, bytes: Math.round(gen.bytesB64.length * 0.75), mime: gen.mime, model: gen.model, modelFallback: !!gen.modelFallback, requestedModel: gen.requestedModel || model, viewAt: `/image/${id}?token=…` };
        } else generation = { success: false, error: gen.error, nsfw: !!gen.nsfw, model: gen.model, modelFallback: !!gen.modelFallback, requestedModel: gen.requestedModel || model };
      }
      return Response.json({ configured: true, probes, models: Object.values(IMAGE_MODELS).map(m => ({ id: m.id, label: m.label, path: m.path, cost: m.cost })), requestedModel: model, generation });
    }

    // image gallery data (GH#9) — no bytes
    if (url.pathname === '/api/images') {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const cid = (url.searchParams.get('contact') || DEFAULT_CONTACT).toLowerCase();
      const tag = url.searchParams.get('tag') ? url.searchParams.get('tag').toLowerCase() : null;
      return Response.json({ images: await listImages(env.DB, cid, tag) }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // serve one image's bytes (token-gated)
    if (url.pathname.startsWith('/image/')) {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const id = parseInt(url.pathname.split('/')[2], 10);
      const img = await getImage(env.DB, id);
      if (!img?.data_b64) return Response.json({ error: 'not found' }, { status: 404 });
      const bytes = Uint8Array.from(atob(img.data_b64), c => c.charCodeAt(0));
      return new Response(bytes, { headers: { 'Content-Type': img.mime || 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } });
    }

    // governing document body + version history for a (contact, topic)
    if (url.pathname.startsWith('/api/document/')) {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const tag = decodeURIComponent(url.pathname.split('/')[3] || '').toLowerCase();
      if (!tag) return Response.json({ error: 'no tag' }, { status: 400 });
      const contactId = (url.searchParams.get('contact') || DEFAULT_CONTACT).toLowerCase();
      const doc = await getDocument(env.DB, contactId, tag);
      const versions = await getDocumentVersions(env.DB, contactId, tag);
      // v2: sections (parsed, or derived from content pre-migration), change
      // log, protection flag, and the provenance ledger
      let docOut = null;
      if (doc) {
        const sec = await getSections(env.DB, contactId, tag).catch(() => null);
        docOut = {
          ...doc,
          protected: !!doc.protected,
          changelog: doc.changelog || '',
          sections: sec?.sections || [],
          sectionsDerived: !!sec?.derived,
          archived: ARCHIVED_TAG_RE.test(tag),
        };
      }
      const entries = await getEntries(env.DB, contactId, tag, { limit: 100 }).catch(() => []);
      return Response.json({ tag, contactId, doc: docOut, versions, entries }, { headers: { 'Cache-Control': 'no-store' } });
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

    // /compose-recon — read-only site re-evaluation: capture the sent folder's
    // top rows (did a "failed" send actually deliver?) and the compose page's
    // current structure vs our selectors. Fills nothing, clicks nothing.
    // Navigation-tolerant (Sept 2026 site does real reloads/redirects).
    if (url.pathname === '/compose-recon') {
      let browser;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        const safeEval = async (fn, ...args) => {
          for (let i = 0; i < 4; i++) {
            try { return await page.evaluate(fn, ...args); }
            catch (e) {
              if (!/context|destroyed|navigation|detached/i.test(e.message)) throw e;
              await new Promise(r => setTimeout(r, 2500));
            }
          }
          return { evalFailed: true };
        };
        const loggedIn = await loginToSecurus(page, env);
        if (!loggedIn) { await browser.close(); return Response.json({ success: false, error: 'Login failed', lastUrl: page.url() }); }

        // step-by-step navigation probe (mirrors composeAndSend's path)
        const steps = [];
        const cap = async (label) => {
          const links = await safeEval(() => [...document.querySelectorAll('a,button')]
            .map(e => ({ t: (e.textContent || '').trim().substring(0, 30), h: e.getAttribute('href') }))
            .filter(l => /compose|message|emessag|launch|stamp/i.test(`${l.t} ${l.h || ''}`)).slice(0, 12));
          steps.push({ label, url: page.url(), links });
        };
        await safeGoto(page, urls.myAccount); await new Promise(r => setTimeout(r, 2500)); await cap('my-account');
        await launchMessaging(page, urls); await cap('after LAUNCH');

        // sent folder: top rows (in-app click — the deep link bounces)
        await inAppNav(page, urls, '^sent\\b|emessage/sent');
        await new Promise(r => setTimeout(r, 3000));
        const sentUrl = page.url();
        const sentRows = await safeEval(() => {
          return [...document.querySelectorAll('table tbody tr')].slice(0, 10).map(tr => {
            const cells = [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim().substring(0, 60));
            return cells.slice(0, 4);
          });
        });

        // compose page structure vs expected selectors — click-only entry
        // (any document load of an app route bounces to /my-account)
        await inAppNav(page, urls, '^compose\\b|emessage/compose');
        await new Promise(r => setTimeout(r, 3000));
        await acceptPendingTerms(page).catch(() => {});
        const composeUrl = page.url();
        const structure = await safeEval((sel) => {
          const q = (s) => { const el = document.querySelector(s); return el ? { found: true, tag: el.tagName, disabled: el.disabled ?? null, text: (el.textContent || '').trim().substring(0, 40) } : { found: false }; };
          return {
            contactDropdown: q(sel.contactDropdown),
            subjectField: q(sel.subjectField),
            messageBody: q(sel.messageBody),
            sendButton: q(sel.sendButton),
            allButtons: [...document.querySelectorAll('button')].map(b => ({ text: (b.textContent || '').trim().substring(0, 30), type: b.getAttribute('type'), disabled: b.disabled, visible: !!(b.offsetWidth || b.offsetHeight) })).filter(b => b.text).slice(0, 20),
            modalTemplatesInDom: [...document.querySelectorAll('.reveal, .reveal-overlay, [class*="modal"]')].map(m => ({ cls: (m.className || '').toString().substring(0, 60), visible: !!(m.offsetWidth || m.offsetHeight), textHead: (m.innerText || '').trim().substring(0, 60) })).slice(0, 8),
            // attachment UI (GH#5): file inputs + any attach/photo/image controls
            fileInputs: [...document.querySelectorAll('input[type="file"]')].map(i => ({
              name: i.getAttribute('name'), id: i.id || null, accept: i.getAttribute('accept'),
              multiple: i.multiple, visible: !!(i.offsetWidth || i.offsetHeight),
              cls: (i.className || '').toString().substring(0, 50),
            })),
            attachControls: [...document.querySelectorAll('a, button, label, [role="button"]')]
              .map(e => ({ tag: e.tagName, text: (e.textContent || '').trim().substring(0, 40),
                           cls: (e.className || '').toString().substring(0, 50),
                           forAttr: e.getAttribute('for'), visible: !!(e.offsetWidth || e.offsetHeight) }))
              .filter(c => /attach|photo|image|picture|upload|ecard|e-card|media|clip|paperclip/i.test(`${c.text} ${c.cls}`)).slice(0, 15),
            attachmentHints: (document.body?.innerText || '').match(/[^\n]*(attach|photo|image|ecard|upload)[^\n]*/gi)?.slice(0, 8) || [],
          };
        }, { contactDropdown: composeSel.contactDropdown, subjectField: composeSel.subjectField, messageBody: composeSel.messageBody, sendButton: composeSel.sendButton });

        // stage 2 (GH#5): select a contact (enables the form), re-capture the
        // Attachments control, click it (opens a picker — sends nothing), capture
        // what appears. Abort the click if the control stays disabled.
        let attachStage = null;
        try {
          await safeEval((dd) => {
            const el = document.querySelector(dd);
            if (el && el.options.length > 1) {
              el.value = [...el.options].find(o => o.value)?.value || el.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, composeSel.contactDropdown);
          await new Promise(r => setTimeout(r, 2500));
          const afterSelect = await safeEval(() => {
            const a = [...document.querySelectorAll('a, button, label')].find(e => /attach/i.test(e.textContent || ''));
            return a ? { text: (a.textContent || '').trim(), cls: (a.className || '').toString(), disabled: /disabled/i.test(a.className || '') || a.disabled === true } : null;
          });
          let afterClick = null;
          if (afterSelect && !afterSelect.disabled) {
            await safeEval(() => {
              const a = [...document.querySelectorAll('a, button, label')].find(e => /attach/i.test(e.textContent || ''));
              if (a) a.click();
            });
            await new Promise(r => setTimeout(r, 2500));
            afterClick = await safeEval(() => ({
              url: location.href,
              fileInputs: [...document.querySelectorAll('input[type="file"]')].map(i => ({
                name: i.getAttribute('name'), id: i.id || null, accept: i.getAttribute('accept'), multiple: i.multiple,
                visible: !!(i.offsetWidth || i.offsetHeight) })),
              visibleModals: [...document.querySelectorAll('.reveal, .reveal-overlay, [class*="modal"], [class*="dialog"]')]
                .filter(m => m.offsetWidth || m.offsetHeight)
                .map(m => ({ cls: (m.className || '').toString().substring(0, 50), text: (m.innerText || '').trim().substring(0, 200) })),
              bodyHints: (document.body?.innerText || '').match(/[^\n]*(attach|photo|upload|file|size|jpg|png|limit)[^\n]*/gi)?.slice(0, 10) || [],
            }));
          }
          attachStage = { urlAtProbe: page.url(), afterSelect, afterClick };
          try { await setState(env.DB, 'attach_recon', JSON.stringify({ ts: new Date().toISOString(), ...attachStage })); } catch {}
        } catch (e) { attachStage = { error: e.message }; }

        const dropVis = await safeEval((sel) => {
          const el = document.querySelector(sel);
          if (!el) return { exists: false };
          const r = el.getBoundingClientRect();
          return { exists: true, rect: { x: r.x, y: r.y, w: r.width, h: r.height },
                   offsetParent: !!el.offsetParent,
                   visible: !!(el.offsetWidth || el.offsetHeight) };
        }, composeSel.contactDropdown);
        const shot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 45 }).catch(() => null);

        await logout(page).catch(() => {});
        await browser.close();
        return Response.json({ success: true, steps, sentUrl, composeUrl, finalUrl: page.url(), dropVis, attachStage, sentRows, structure, screenshot: shot });
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
          const soAttachments = await attachmentsForPart(env, qp);
          const sendResult = await composeAndSend(page, {
            contactId: securusId,
            contactName: c.name,
            subject: qp.subject,
            body: qp.body,
            attachments: soAttachments,
          });
          results.push({ queueId: qp.id, part: `${qp.part_num}/${qp.total_parts}`, contact: qp.contact_id || 'sam', subject: qp.subject, bodyLen: qp.body.length, imageIds: getPartImageIds(qp), ...sendResult });

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
            await linkOutboundToLedger(env, { outboundId, queuePart: qp });
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

    // /draft?id={inboundId} — DRY RUN of the v2 single-message flow for one
    // inbound: extracts requests (not persisted), builds the manifest, drafts,
    // budgets, reconciles and splits — nothing is queued, sent or marked.
    // ?images=0 skips image generation (they are reported as deferred).
    // Without ?id — view the pending send queue (backwards compatible name).
    if (url.pathname === '/draft' && url.searchParams.get('id')) {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const id = parseInt(url.searchParams.get('id'), 10);
      if (isNaN(id)) return Response.json({ error: 'invalid id' }, { status: 400 });
      const msg = await env.DB.prepare("SELECT * FROM messages WHERE id = ? AND direction = 'inbound'").bind(id).first();
      if (!msg) return Response.json({ error: `inbound message ${id} not found` }, { status: 404 });
      try {
        const r = await generateForInbound(env, msg, { batch: [], dryRun: true, images: url.searchParams.get('images') !== '0' });
        const d = r.dry || {};
        return Response.json({
          dryRun: true, inboundId: id, contact: r.contact || msg.contact_id, status: r.status,
          requests: d.requests || [], carried: d.carried || [],
          manifest: d.manifest || null, footer: d.footer ?? null,
          parts: d.parts || [], imagePlan: d.imagePlan || null,
          reconcile: d.reconcile || null, budget: d.budget || null,
          archivedAs: r.archivedAs || null, tag: r.tag || null,
          text: d.text || null,
        }, { headers: { 'Cache-Control': 'no-store' } });
      } catch (err) {
        return Response.json({ dryRun: true, inboundId: id, error: err.message, stack: err.stack?.substring(0, 600) }, { status: 500 });
      }
    }
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
      // protected docs (archives, imports, profile) are skipped: saveDocument refuses them
      const tags = (await getAllDocTags(env.DB, contactId)).filter(isUserTag);
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

    // /api/state — project state registry (v2 §13): current facts, or one
    // key's history with ?key=
    if (url.pathname === '/api/state') {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const contactId = (url.searchParams.get('contact') || DEFAULT_CONTACT).toLowerCase();
      const tag = (url.searchParams.get('tag') || '').toLowerCase();
      if (!tag) return Response.json({ error: 'tag is required' }, { status: 400 });
      try {
        const key = url.searchParams.get('key');
        const rows = key ? await getStateHistory(env.DB, contactId, tag, key) : await getCurrentState(env.DB, contactId, tag);
        return Response.json({ contact: contactId, tag, key: key || null, state: rows, block: key ? null : renderStateBlock(rows) }, { headers: { 'Cache-Control': 'no-store' } });
      } catch (err) {
        return Response.json({ contact: contactId, tag, state: [], error: err.message });
      }
    }

    // /upgrade-project — admin (v2 §15): carry one existing document into v2
    // (sections, entries back-fill, state seed, consistency sweep). Several
    // LLM calls over a large document — synchronous, one project at a time.
    if (url.pathname === '/upgrade-project') {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const contactId = (url.searchParams.get('contact') || DEFAULT_CONTACT).toLowerCase();
      const tag = (url.searchParams.get('tag') || '').toLowerCase();
      if (!tag) return Response.json({ error: 'tag is required' }, { status: 400 });
      const opts = {};
      for (const step of ['sections', 'entries', 'state', 'sweep']) if (url.searchParams.get(step) === '0') opts[step] = false;
      try {
        const report = await upgradeProject(env, { contactId, tag, ...opts });
        await setState(env.DB, `upgrade_${contactId}_${tag}`, JSON.stringify({ ts: new Date().toISOString(), report }));
        return Response.json(report);
      } catch (err) {
        return Response.json({ contactId, tag, error: err.message }, { status: 500 });
      }
    }

    // /upgrade-all — admin: every live project of a contact, in the background;
    // progress in state `upgrade_all_{contact}`.
    if (url.pathname === '/upgrade-all') {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const contactId = (url.searchParams.get('contact') || DEFAULT_CONTACT).toLowerCase();
      if (url.searchParams.get('status') === '1') {
        return Response.json(JSON.parse(await getState(env.DB, `upgrade_all_${contactId}`) || 'null') || { status: 'never run' });
      }
      await setState(env.DB, `upgrade_all_${contactId}`, JSON.stringify({ status: 'running', startedAt: new Date().toISOString() }));
      ctx.waitUntil((async () => {
        try {
          const result = await upgradeAllProjects(env, contactId);
          await setState(env.DB, `upgrade_all_${contactId}`, JSON.stringify({ status: 'done', finishedAt: new Date().toISOString(), ...result }));
        } catch (err) {
          await setState(env.DB, `upgrade_all_${contactId}`, JSON.stringify({ status: 'failed', error: err.message, at: new Date().toISOString() }));
        }
      })());
      return Response.json({ triggered: true, contact: contactId, note: 'poll /upgrade-all?status=1&contact=…' });
    }

    // /import-doc — admin: import external content as a governing document.
    // POST JSON { contact, tag, title?, body, note? }. Token-gated. Bypasses
    // the 100KB SQL-statement limit that blocks wrangler-side inserts, and
    // records a proper document_versions entry.
    if (url.pathname === '/import-doc' && request.method === 'POST') {
      if (!dashAuthed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      let payload;
      try { payload = await request.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
      const contactId = (payload.contact || '').toLowerCase();
      const tag = (payload.tag || '').toLowerCase();
      const body = payload.body;
      if (!contactId || !tag || !body) return Response.json({ error: 'contact, tag and body are required' }, { status: 400 });
      const contact = await getContact(env.DB, contactId);
      if (!contact) return Response.json({ error: `unknown contact "${contactId}"` }, { status: 400 });
      try {
        // protected targets refuse unless the caller passes force:true deliberately
        const version = await saveDocument(env.DB, {
          contactId, tag,
          title: payload.title || docTitle(tag),
          content: body,
          changeNote: payload.note || `imported (${body.length} chars)`,
          force: payload.force === true,
        });
        return Response.json({ success: true, contact: contactId, tag, version, chars: body.length });
      } catch (err) {
        return Response.json({ success: false, error: err.message }, { status: /protected/.test(err.message) ? 409 : 500 });
      }
    }

    // /docs — list all topic documents
    if (url.pathname === '/docs') {
      const tags = (await getAllDocTags(env.DB)).filter(isUserTag);
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
        requests: await requestCounts(env.DB, DEFAULT_CONTACT).catch(() => null),
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
        // ── images (GH#6): generated images + prompts, per contact/project ──
        `CREATE TABLE IF NOT EXISTS images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contact_id TEXT NOT NULL DEFAULT 'sam',
          doc_tag TEXT NOT NULL,
          intent TEXT, prompt TEXT NOT NULL,
          parent_image_id INTEGER, hf_request_id TEXT,
          mime TEXT, data_b64 TEXT, status TEXT DEFAULT 'completed',
          cost REAL, created_at TEXT DEFAULT (datetime('now'))
        )`,
        "CREATE INDEX IF NOT EXISTS idx_images_project ON images(contact_id, doc_tag)",
        "ALTER TABLE send_queue ADD COLUMN image_id INTEGER",
        // overflow storage for image bytes: D1 caps a row/string at ~2MB, and a
        // single base64 blob can exceed it — pieces beyond the first live here
        `CREATE TABLE IF NOT EXISTS image_chunks (
          image_id INTEGER NOT NULL, seq INTEGER NOT NULL, data_b64 TEXT NOT NULL,
          PRIMARY KEY (image_id, seq)
        )`,
        // ── v2 images: label / model / ledger link, multi-attach per queue part ──
        "ALTER TABLE images ADD COLUMN label TEXT",
        "ALTER TABLE images ADD COLUMN model TEXT",
        "ALTER TABLE images ADD COLUMN request_id INTEGER",
        "ALTER TABLE send_queue ADD COLUMN image_ids TEXT",
        "CREATE INDEX IF NOT EXISTS idx_images_request ON images(request_id)",
        // ── v2 documents: sections + changelog + protection + provenance ledger ──
        "ALTER TABLE documents ADD COLUMN protected INTEGER DEFAULT 0",
        "ALTER TABLE documents ADD COLUMN sections TEXT",
        "ALTER TABLE documents ADD COLUMN changelog TEXT",
        `CREATE TABLE IF NOT EXISTS document_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contact_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          entry_date TEXT NOT NULL,
          author TEXT NOT NULL,
          inbound_id INTEGER,
          outbound_id INTEGER,
          summary TEXT,
          content TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        "CREATE INDEX IF NOT EXISTS idx_document_entries_doc ON document_entries(contact_id, tag, id)",
        // ── v2 request ledger ──
        ...REQUESTS_MIGRATIONS,
        // ── v2 project state registry (§13) ──
        ...PROJECT_STATE_MIGRATIONS,
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
      version: 'v6-ledger',
      routes: ['/dashboard', '/api/dashboard', '/api/requests', '/api/requests/{id}', '/api/document/{tag}', '/api/images', '/check', '/cron', '/scan', '/generate', '/send', '/send-one/{id}', '/verify-sent', '/resend/{id}', '/fix-dupes', '/queue', '/series', '/retry-failed', '/status', '/login-debug', '/draft', '/draft?id={inboundId}', '/image-test', '/api/state', '/upgrade-project', '/upgrade-all', '/conversation', '/docs', '/migrate'],
    });
  },

  async scheduled(event, env, ctx) {
    const jitterMs = Math.floor(Math.random() * 30 * 1000);
    console.log(`cron triggered, jitter: ${jitterMs}ms`);
    await new Promise(resolve => setTimeout(resolve, jitterMs));
    ctx.waitUntil(cronOrchestrator(env));
  },
};


// ═══════════════════════════════════════════════════════════════
// TENANT ROUTES (portal-facing). Each browser op = one login session.
// ═══════════════════════════════════════════════════════════════
async function withSession(env, creds, fn) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    const loggedIn = await loginToSecurus(page, env, creds);
    if (!loggedIn) return { ok: false, error: 'login_failed' };
    try { return { ok: true, ...(await fn(page)) }; }
    finally { await logout(page).catch(() => {}); }
  } finally { await browser.close().catch(() => {}); }
}

async function handleTenantRoute(request, env, url) {
  const path = url.pathname;
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  const db = env.DB;
  await ensureTenantSchema(db);
  const tenantCreds = async (id) => { const t = await getTenant(db, id); if (!t) throw new Error('unknown tenant ' + id); return { tenant: t, creds: await tenantCredentials(env, t) }; };
  try {
    // Verify raw credentials WITHOUT storing them; returns approved contacts + compose recipients.
    if (path === '/tenant/verify' && request.method === 'POST') {
      if (!body.email || !body.password) return Response.json({ ok: false, error: 'email and password required' }, { status: 400 });
      const r = await withSession(env, { email: body.email, password: body.password }, async (page) => {
        const contacts = await listContacts(page);
        let recipients = [];
        try { recipients = await listComposeRecipients(page, urls.compose, composeSel.contactDropdown, acceptPendingTerms); } catch (e) { recipients = []; }
        return { contacts, recipients };
      });
      return Response.json(r);
    }
    if (path === '/tenant/upsert' && request.method === 'POST') {
      if (!body.id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
      const t = await upsertTenant(db, body);
      if (!t.next_run_at) { const n = computeNextRun(Date.now(), DEFAULT_SCHEDULE); await db.prepare('UPDATE tenants SET next_run_at = ? WHERE id = ?').bind(n, t.id).run(); }
      return Response.json({ ok: true, tenant: { id: t.id, status: t.status, securus_email: t.securus_email, last_verified_at: t.last_verified_at } });
    }
    if (path === '/tenant/status' && request.method === 'POST') {
      const t = await getTenant(db, body.id);
      if (!t) return Response.json({ ok: false, error: 'unknown tenant' }, { status: 404 });
      return Response.json({ ok: true, tenant: { id: t.id, status: t.status, securus_email: t.securus_email, last_verified_at: t.last_verified_at, last_error: t.last_error, next_run_at: t.next_run_at }, contacts: await getTenantContacts(db, t.id) });
    }
    // Re-verify stored credentials (after the customer created the account, or periodically).
    if (path === '/tenant/recheck' && request.method === 'POST') {
      const { tenant, creds } = await tenantCreds(body.id);
      const r = await withSession(env, creds, async (page) => ({ contacts: await listContacts(page), recipients: await listComposeRecipients(page, urls.compose, composeSel.contactDropdown, acceptPendingTerms).catch(() => []) }));
      await setTenantStatus(db, tenant.id, r.ok ? (tenant.status === 'connected' ? 'connected' : 'verified') : 'error', r.ok ? null : r.error);
      return Response.json(r);
    }
    if (path === '/tenant/agencies' && request.method === 'POST') {
      const { creds } = await tenantCreds(body.id);
      if (!/^[A-Z]{2}$/.test(body.state || '')) return Response.json({ ok: false, error: 'state (2-letter) required' }, { status: 400 });
      return Response.json(await withSession(env, creds, async (page) => ({ agencies: await listAgencies(page, body.state) })));
    }
    if (path === '/tenant/search' && request.method === 'POST') {
      const { creds } = await tenantCreds(body.id);
      return Response.json(await withSession(env, creds, async (page) => ({ result: await searchInmates(page, body.query || {}) })));
    }
    // STAGED add. confirm=false → clicks the row button, reports any confirmation modal, dismisses it.
    // confirm=true → also presses the single affirmative button. Operator reviews the trace first.
    if (path === '/tenant/add-contact' && request.method === 'POST') {
      const { tenant, creds } = await tenantCreds(body.id);
      const r = await withSession(env, creds, async (page) => ({ result: await addContactFromSearch(page, body.query || {}, body.targetId, { confirm: body.confirm === true }) }));
      await setState(db, `tenant:${tenant.id}:last_add_contact`, JSON.stringify({ at: new Date().toISOString(), targetId: body.targetId, confirm: body.confirm === true, result: r }));
      return Response.json(r);
    }
    if (path === '/tenant/register-contact' && request.method === 'POST') {
      const t = await getTenant(db, body.id);
      if (!t) return Response.json({ ok: false, error: 'unknown tenant' }, { status: 404 });
      const c = body.contact || {};
      if (!c.id || !c.name || !c.match_names) return Response.json({ ok: false, error: 'contact.id, name, match_names required' }, { status: 400 });
      const row = await registerTenantContact(db, t.id, c);
      await setTenantStatus(db, t.id, 'connected');
      return Response.json({ ok: true, contact: row });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

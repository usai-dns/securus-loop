# Architecture — securus-agent

> Mandatory reading for any AI or developer working on this codebase.
> Updated: 2026-05-30

## System Overview

Cloudflare Worker (`securus-agent`) that autonomously reads, responds to, and sends messages to Samuel Mullikin through the Securus prison eMessaging platform. Speaks as Dennis Hanson (first person). Sam knows it's AI-augmented.

**Runtime**: Cloudflare Workers + Browser Rendering (Puppeteer) + D1 (SQLite)
**AI**: Claude Sonnet 4 via Anthropic API
**Notifications**: Twilio SMS to Dennis

## Three-Phase Cron Architecture

```
CRON (hourly + jitter) or /check endpoint
  │
  ├─ Phase 1: SCAN (phaseScan)
  │   Browser: login → inbox → open new messages → save to D1
  │   Detects: doc commands, series indicators ("message N/M")
  │
  ├─ Phase 2: GENERATE (phaseGenerate)
  │   No browser. AI-only.
  │   Combines complete series → generates response → queues to send_queue
  │   Processes individual unresponded → generates → queues
  │   Dedup: checks send_queue + outbound table before generating
  │
  └─ Phase 3: SEND (phaseSend)
      Browser: login → for each pending queue part → compose → send → verify
      Marks each part sent IMMEDIATELY (crash-safe)
      Marks inbound responded after part 1 sends (prevents re-generation)
```

## Database Schema (D1)

### messages
Primary conversation log. Every inbound and outbound message.
- `external_id`: Securus messageId (URL param) — dedup key for inbound
- `direction`: 'inbound' | 'outbound'
- `responded_at`: NULL = unresponded, datetime = responded, 'escalated' | 'series_collecting' | 'pre_system_archive' | 'followup_wait' | 'duplicate_of_N' = special states ('followup_wait' = the message only said "more coming / no reply needed" — never answered, v2)
- `response_id`: FK to outbound message id
- `doc_tag`: topic tag (e.g., 'scribe', 'starkiller')
- `confirmed_sent`: datetime when verified in sent folder

### send_queue
Persistent outbound message queue. Each row = one message part to send.
- `inbound_id`: which inbound triggered this response
- `series_id`: FK to inbound_series (if responding to a series)
- `part_num` / `total_parts`: for multi-part outbound
- `status`: 'pending' → 'sent' | 'failed' | 'skipped'
- `outbound_msg_id`: FK to messages.id after send succeeds
- `retry_count` / `last_attempt_at`: auto-retry bookkeeping

**Crash safety**: phaseSend marks each part `sent` immediately after compose succeeds. If worker dies between part 2 and part 3, next cycle picks up part 3. No re-sends.

**Auto-retry**: a failed part is re-attempted on later cron cycles, spaced by `RETRY_BACKOFF_HOURS` (2h), up to `MAX_SEND_RETRIES` (4). After that it stays `failed` and Dennis is paged once. `getPendingParts` returns both `pending` and retry-eligible `failed` rows. `/retry-failed` resets counters for a manual retry.

**Stale-guard (multi-part aware)**: a queued part whose inbound is already `responded` is skipped as stale — UNLESS an earlier part of the same queue group already sent (then it's a legitimate continuation, not a duplicate). Without this, part 2 of a response would be skipped forever once part 1 marked the inbound responded.

### inbound_series + inbound_series_parts
Tracks multi-part inbound messages from Sam.
- Trigger: "message N/M" pattern in body (e.g., "message 1/6")
- Each part saved to `inbound_series_parts`, message marked `series_collecting`
- When all N parts arrive: status → 'complete', phaseGenerate combines and responds
- After response queued: status → 'processed'

### system_state
Key-value store for operational metadata.
- `last_check`, `total_checks`, `total_messages_sent`, `last_error`
- `conversation_md_all`, `conversation_md_{tag}` — cached markdown
- `standalone_outbound` — manually queued outbound message
- `{tag}_import` — imported reference content for topics

## Message Lifecycle

### Inbound (Sam → Dennis)
```
Securus inbox → phaseScan opens → saves to messages (external_id dedup)
  ├─ Has "message N/M"? → mark series_collecting, add to inbound_series
  │   └─ All parts received? → status=complete → phaseGenerate combines
  ├─ Has doc command? → parse makenew/makeupdate/makefull, set doc_tag
  ├─ Near-duplicate of a recent inbound? → mirror that response, mark duplicate_of_N
  ├─ Matches escalation phrases? → SMS to Dennis, mark escalated
  └─ Normal message → phaseGenerate creates response → queues to send_queue
```

### Outbound (Dennis → Sam)
```
phaseGenerate creates response → splitForSend if >20k chars
  → queueOutboundParts inserts rows into send_queue (status=pending)
  → phaseSend picks up pending parts (max 4 per cycle)
  → composeAndSend: fill form → send → confirm modal → verify sent folder
  → markPartSent + saveMessage + markConfirmedSent
  → part 1: markResponded on inbound (prevents re-generation)
```

## Character Limit Handling

Securus hard limit: **20,000 characters** (subject + body combined).

**Outbound splitting** (`splitForSend`):
- `maxBodyPerMessage = 20000 - subject.length - 20`
- Splits at paragraph breaks, sentence ends, then word boundaries
- Parts get subject suffix: `(pt 2)`, `(pt 3)`, etc.
- Each part queued as separate send_queue row

**Inbound series** (`detectSeriesIndicator`):
- Pattern: `/message\s+(\d+)\s*\/\s*(\d+)/i`
- Only "message N/M" triggers series — bare "N/M" does NOT (prevents false positives)
- Bounds: partNum 1-totalParts, totalParts 2-30

## Doc Command System

First line of message body parsed for commands:
- `makenew {topic}` — start a new governing document for the topic
- `makeupdate {topic}` — edit the governing document in place with the new material
- `makefull {topic}` — send the current governing document to Sam (auto-splits)

Tags messages with `doc_tag`, loads topic-specific history for AI context.

## Governing Documents

Each topic has a single **living document** — the combined, authoritative body
that Sam's messages edit over time — stored in the `documents` table (with a
`document_versions` snapshot per edit). This is distinct from the `messages`
stream, which is the *conversation that edits it*.

```
messages (edits)  ──►  buildDocument (AI, in-place editor)  ──►  documents (the body)
```

- **makenew / makeupdate**: phaseGenerate sends Dennis's conversational reply as
  usual, AND calls `buildDocument` (responder.mjs) to integrate the new material
  (Sam's notes + Dennis's drafted reply) into the current governing body,
  bumping the version. Streamed (SSE) so large builds don't hit gateway timeouts.
- **makefull**: sends the current governing body (not a fresh regeneration).
- **Backfill**: `/rebuild-doc/{tag}` (AI synthesis, one pass — best for small/mid
  topics) and `/assemble-doc/{tag}` (deterministic stitch of drafted content —
  timeout-proof, used for large topics where a single AI synthesis can't finish
  inside an HTTP request). Deterministic docs get refined into integrated prose
  on the next real makeupdate.
- Dashboard surfaces each topic's governing document under a **Document** tab
  (with the message stream under **History**). `/api/document/{tag}` serves the
  body + version list.

## v2 additions (Nov 2026 — design in `docs/V2_ARCHITECTURE.md`, Wave-1 notes in `docs/v2/`)

### New tables / columns

| Table | Purpose |
|---|---|
| `requests` | Request ledger: `(id, contact_id, inbound_id, kind ∈ answer\|image\|doc_update\|research\|followup, label, spec JSON, status ∈ open\|in_progress\|done\|deferred\|failed\|cancelled, priority, fulfilled_by_outbound_id, attempts, note, created_at, updated_at)`. `src/db/requests.mjs`, extraction/reconcile in `src/ai/requests.mjs`. |
| `document_entries` | Provenance ledger per document: `(contact_id, tag, entry_date, author = contact id \| 'ai', inbound_id, outbound_id, summary, content)`. |
| `documents` + `protected`, `sections` (JSON `[{heading, body}]`), `changelog` | Sectioned documents; `content` is rendered from `sections`. `protected = 1` ⇒ no command may change it (archives `<tag>-archived-<yyyymmdd>`, imports like `qualia-bible`, the `profile` doc). |
| `images` + `label`, `model`, `request_id` | Sam's label, registry model id (`soul` \| `gpt-image`), ledger link. |
| `send_queue` + `image_ids` | JSON array of image ids attached to that part (≤ 5, Securus cap); `image_id` stays as the first id for legacy readers. |

Every new table carries `contact_id`; all reads are scoped by it (isolation unchanged).

### SCAN additions
After each new inbound is saved: `closeWaitFollowups` (a new message satisfies a standing "wait") → `recordInboundRequests` (image directives + legacy `MakeImage` line deterministically, then one LLM extraction over the remaining text). A series is extracted ONCE on completion over the combined body, keyed to part 1's message id. A wait-only message is marked `followup_wait`.

### GENERATE sequence (per inbound; `generateForInbound` / `generateForSeries`)
1. Strip directive grammar (image directives, inline makeimage, doc command, MakeReference) → `bodyForAi`; load explicit + plain-language references (`listDocumentsForContact`, `{tag,title}` matching; archives and `profile` excluded).
2. Ledger: `ensureRequests` (extracts on the fly for pre-ledger messages) + `getCarryoverRequests` (≤ 6 older open items).
3. `makenew`/`makeupdate` on a protected doc (or `profile`) ⇒ queue a refusal notice, cancel the message's requests, stop. `makefull` ⇒ send the stored doc (uncapped split), mark requests done.
4. `makenew` on an existing tag ⇒ `archiveDocument` FIRST (ack names the archive; the model starts blank).
5. **Images first**: open image requests (own + carried, ≤ 5) → `runImageGeneration` (label / model via `IMAGE_MODELS` / requestId). Failures ⇒ `failed`; missing keys ⇒ left open (deferred).
6. **Manifest** `{ attachments, failed, openRequests (deferred images only, pre-generation), carriedOver, stampsLeft, batchSiblings }` + `profile` doc ⇒ `generateResponse`.
7. `voiceViolations` ⇒ regenerate once, keep the cleaner draft.
8. `budgetReply` (≤ 3 parts; skipped for makefull) ⇒ overflow items become `followup` requests.
9. `reconcileRequests` over the message's own + carried non-image items ⇒ `done` / partial `note`; inconclusive ⇒ own `answer` items assumed covered.
10. `manifest.openRequests` rebuilt from what is still open ⇒ `replyFooter` ⇒ `ack + text + "— — —" + footer` ⇒ `splitForSend(maxParts: 3)` ⇒ one `queueOutboundParts` call (image-only overflow parts appended if batches > parts) ⇒ `setPartImageIds` per part ⇒ image requests `done`.
11. `maintainDocument`: `appendEntry(author)` → `buildDocumentPatch` → `applyPatch` → `saveSections` (version bump + changelog) → `appendEntry('ai')`. Never a whole-document rewrite.
12. After the loop: **carry-over delivery** — each active contact with no inbound this cycle and open non-image items older than 2h gets ONE `Follow-up: <label>` message delivering ≤ 4 of them (`in_progress` while queued, `done` on reconcile, `deferred` after 3 attempts). Then `refreshProfile` once per contact that produced output.

### SEND additions
`getPartImageIds` → `getImages` → `composeAndSend({ attachments })` (any attach failure aborts BEFORE Send — no stamp spent). After `saveMessage`: `requests.fulfilled_by_outbound_id` and `document_entries.outbound_id` are linked to the new outbound (carry-over parts link through the `carry-over q#<id>` note).

### New endpoints
`GET /api/requests?contact=&status=` · `POST /api/requests/{id}` `{status, note?}` · `/api/document/{tag}` now returns `entries`, `doc.sections`, `doc.changelog`, `doc.protected` · `/api/dashboard` adds `documents[]` (protected/version/length) and `requestCounts` · `/draft?id=<inbound>&images=0|1` dry-run replay (no writes) · `/image-test?model=<id>&generate=1` · `/status.requests`.

## Key Invariants

1. **Never double-send**: Inbound marked responded after part 1 sends. Dedup checks in phaseGenerate (send_queue + outbound table).
2. **Never lose a send**: send_queue is persistent. Crash between parts resumes from next pending.
3. **Never delete messages**: All messages preserved in D1. Use `responded_at` states to control processing.
4. **Escalation before auto-reply**: Phrase matching happens before AI generation. Matches SMS Dennis instead of auto-responding.
5. **Series waits for completion**: Individual parts marked `series_collecting` (invisible to getUnrespondedInbound). Only combined when all N parts arrive.
6. **Out of stamps = pause, not fail**: An insufficient-stamps send leaves the queue part `pending` and halts the send phase. Parts auto-resume on the next cron after stamps are purchased. Dennis is SMSed at most once per 24h (`stamps_alert_at` state key, cleared on next successful send). Stamp purchases are never automated.
7. **Amended T&C must be accepted**: Securus blocks login (and can block sends) with a Terms & Conditions modal. `acceptPendingTerms` (auth.mjs) clicks Accept during login and compose flows.
8. **Content-duplicate guard**: Sam sometimes re-sends the same message with a fresh Securus messageId. external_id dedup can't catch it; `findDuplicateInbound` (series.mjs) fingerprints body head+tail+length (punctuation-insensitive) and mirrors the prior response instead of generating a second reply.
9. **Send verification scans multiple rows**: verify the sent folder by scanning the top 5 rows and reloading once on a miss — a delivered-but-not-yet-top message must not read as failed (would risk a double-send on retry).

## File Structure

```
src/
├── index.js              Main worker: phases, orchestrator, HTTP endpoints
├── ai/
│   ├── prompt.mjs        System prompt builder (manifest / profile slots), CHAR_LIMIT
│   ├── responder.mjs     Claude API calls, hygiene, voice check, budget, footer, doc patch, splitForSend
│   ├── requests.mjs      request extraction + draft reconciliation (LLM)
│   ├── images.mjs        Higgsfield model registry + generateImage
│   └── profile.mjs       per-contact profile document refresh (v2 §8)
├── dashboard.mjs         monitoring UI data + HTML (/dashboard, /api/dashboard)
├── db/
│   ├── messages.mjs      messages table CRUD
│   ├── state.mjs         system_state key-value ops
│   ├── send_queue.mjs    send_queue CRUD + auto-retry + image_ids per part
│   ├── requests.mjs      request ledger CRUD + migrations
│   ├── documents.mjs     governing docs: sections, patches, entries, archive, protection
│   ├── images.mjs        image rows (+ chunked bytes)
│   └── series.mjs        inbound_series detection + content-duplicate guard
├── docs/
│   └── commands.mjs      parseDocCommand, docAcknowledgment
├── notify/
│   └── sms.mjs           Twilio SMS notifications
├── securus/
│   ├── auth.mjs          login/logout
│   ├── compose.mjs       composeAndSend (form fill → send → verify)
│   ├── helpers.mjs       humanDelay, fillField, safeGoto
│   ├── inbox.mjs         navigateToInbox, enumerate, pagination
│   ├── read.mjs          openMessage, extractMessage
│   └── selectors.mjs     URLs, CSS selectors, contact IDs
└── utils/
    ├── browser.js         Local Playwright helpers
    └── selectors.js       Local CommonJS selectors
tests/
└── unit.test.mjs         Unit tests for pure functions
schema.sql                D1 schema (all tables)
wrangler.toml             Worker config, cron, D1 binding
```

## Environment Variables

| Variable | Purpose |
|---|---|
| SECURUS_LOGIN_EMAIL | Securus account email |
| SECURUS_LOGIN_PASS | Securus account password |
| SECURUS_LOGIN_URL | https://securustech.online/#/login |
| SAM_CONTACT_ID | 65651103 (Samuel Mullikin) |
| SITE_ID | 09420 |
| ANTHROPIC_API_KEY | Claude API for response generation |
| DASH_TOKEN | Access token for /dashboard and /api/dashboard (unset = open) |
| TWILIO_ACCOUNT_SID | SMS notifications |
| TWILIO_AUTH_TOKEN | SMS notifications |
| TWILIO_FROM_NUMBER | SMS from number |
| DENNIS_PHONE | Notification target |

## HTTP Endpoints

| Route | Purpose |
|---|---|
| `/check`, `/cron` | Trigger full cron cycle (scan→generate→send) |
| `/scan` | Phase 1 only |
| `/generate` | Phase 2 only (synchronous) |
| `/send` | Phase 3 only |
| `/send-one/{id}` | Send pending queue parts for specific inbound |
| `/queue-send` | POST {subject, body} to queue standalone message |
| `/status` | System state, queue counts, recent messages |
| `/queue` | Send queue details (pending + failed) |
| `/series` | Inbound series status |
| `/draft` | Alias for pending queue view |
| `/fix-dupes` | Reconcile unresponded inbound with existing outbound |
| `/retry-failed` | Reset failed queue parts to pending |
| `/resend/{id}` | Reset inbound for re-generation |
| `/deep-scan` | Enumerate all inbox pages, compare with D1 |
| `/deep-scan-open/{page}` | Open + save missing messages on specific page |
| `/dashboard` | Monitoring UI — state, governing documents (Document/History tabs), activity (token-gated via DASH_TOKEN) |
| `/api/dashboard` | JSON data behind the dashboard (token-gated) |
| `/api/document/{tag}` | Governing document body + version history (token-gated) |
| `/api/message/{id}` | Full text of one message (token-gated) |
| `/api/requests`, `/api/requests/{id}` | Request ledger per contact (GET list + counts; POST `{status, note}` admin update) |
| `/api/images`, `/image/{id}` | Image gallery data / bytes (token-gated) |
| `/draft?id={inbound}` | Dry-run replay of the v2 reply flow for one inbound (no writes; `&images=0` skips generation) |
| `/image-test?model=&generate=1` | Higgsfield auth probe + one test generation on a registry model |
| `/rebuild-doc/{tag}` | Build governing doc via AI synthesis (one pass) |
| `/assemble-doc/{tag}` | Build governing doc deterministically (stitch, no AI) |
| `/inbox-info` | Quick inbox diagnostic |
| `/login-debug` | Attempt login, capture page state (modals, buttons, errors) |
| `/verify-sent` | Check sent folder structure |
| `/conversation` | Markdown history (?doc=topic for filtered) |
| `/docs` | List all topic documents |
| `/migrate` | Run DB migrations |

## Constants

- `MAX_SENDS_PER_CYCLE = 4` — max queue parts sent per cron cycle
- `MAX_CONSECUTIVE_KNOWN = 2` — stop inbox scan after N known messages
- `MAX_TOPIC_CHARS = 50000` — cap on topic history sent to AI
- `CHAR_LIMIT = 20000` — Securus message char limit
- `max_tokens = 8192` — Claude API max tokens per response

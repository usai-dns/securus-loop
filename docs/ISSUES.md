# Issue index — securus-agent

System review index. Each entry is GitHub-issue-ready (title, labels, body).
`scripts/file-github-issues.sh` bulk-creates the **OPEN** ones via the `gh` CLI
once the Claude GitHub App is connected for the `usai-dns` org.

Status legend: ✅ fixed · 🔴 open · 🟡 open (needs human/admin) · ⚪ backlog

---

## ✅ Fixed (2026-07-13 review)

### 1. Retired Claude model caused 100% generation failure
`bug` `ai` — `claude-sonnet-4-20250514` was retired by the Anthropic API →
every `phaseGenerate` call 404'd, so no replies could be produced. Swapped to
`claude-sonnet-4-6`. *(commit: retired-model fix)*

### 2. Amended Terms & Conditions modal blocked login
`bug` `securus` — Securus began presenting a T&C reveal modal at sign-in that
blocked the my-account redirect. Added `acceptPendingTerms` in `auth.mjs`.

### 3. Chat-assistant popup intercepted the Send click
`bug` `securus` — the Securus online-assistant banner overlapped the compose
Send button; puppeteer `page.click` hit the popup. Dismiss popup + click via
`page.evaluate` targeting the Send button by text.

### 4. INSUFFICIENT STAMPS modal mishandled as a generic failure
`bug` `securus` — out-of-stamps shows a modal with no Confirm button; it was
being marked a hard failure. Now detected → part left `pending`, phase halts,
Dennis SMSed ≤1×/24h. Auto-resumes after stamps are purchased.

### 5. Stale-guard skipped legitimate part-2 of a multi-part send
`bug` `send-queue` — when part 1 sent (marking the inbound responded) and part 2
was retried on a *later* cron, the stale-guard saw "responded" and skipped part
2 forever. Now a queued part is only stale if no earlier part of its group was
sent. *(This bit message #255.)*

### 6. Failed send parts were never retried automatically
`enhancement` `send-queue` — failed parts sat stuck until a human ran
`/retry-failed`; message #255 was invisible-stuck for 6 days. Added
`retry_count` + `last_attempt_at`; `getPendingParts` now re-attempts failed
parts with a 2h backoff, up to 4 tries, then pages Dennis once.

### 7. Sent-folder verification false-negative could mark a delivered message failed
`bug` `securus` — verification only checked the single top row of the sent
folder; a delivered message not-yet-at-top read as failed, risking a
double-send on retry. Now scans the top 5 rows and reloads once on a miss.
*(This bit q#21 / message #263, which had actually delivered.)*

### 8. Content-duplicate inbound messages generated a second reply
`bug` `dedup` — Sam sometimes re-sends the same message with a fresh Securus
messageId (external_id dedup can't see it), burning a stamp on a duplicate
reply. Added `isNearDuplicate`/`findDuplicateInbound` (punctuation-insensitive
head+tail+length signature); phaseGenerate mirrors the prior response instead.

### 9. `/send-one` ignored failed parts and didn't update stamp balance
`bug` `send-queue` — the manual recovery endpoint only picked up `pending`
parts (not `failed`) and never wrote `stamp_balance`. Both fixed.

---

## 🟡 Open — needs human / admin action

### 10. SMS notifications are completely disabled (no Twilio secrets)
`ops` `priority:high` — the worker has no `TWILIO_ACCOUNT_SID` /
`TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` / `DENNIS_PHONE`, so **every**
`notifyDennis` call silently no-ops: stamp-low/out alerts, send-failure alerts,
**and the emergency-escalation safety path**. This is why #255 sat stuck 6 days
with no alert. **Action:** `npx wrangler secret put TWILIO_ACCOUNT_SID` (×4).
Dashboard surfaces this as a standing alert until resolved.

### 11. Connect the Claude GitHub App for the usai-dns org
`ops` — GitHub API access is not enabled for this session, so issues can't be
filed programmatically. **Action:** an org admin enables the Claude GitHub App
at https://claude.ai/admin-settings . Then run
`scripts/file-github-issues.sh` to create issues 10, 12–16.

---

## 🔴 Open — engineering

### 12. "Send button disabled" on some short continuation parts
`bug` `securus` `needs-investigation` — the compose Send button stays disabled
for certain short follow-up messages even with a valid form (contact + subject +
body all set, under the char limit), reproducibly across fresh sessions and
distinct subjects. Strongly suggests a Securus-side throttle on consecutive
messages to the same inmate (or a "wait for reply" cap). Real-keystroke
re-validation nudge added (may not fully resolve). **Next:** test send spacing;
detect the disabled-after-valid state and defer the part to a later cron instead
of consuming a retry. *(Blocks q#18/#255-part2 and q#24/#265-part2.)*

### 13. Scan browser occasionally hits detached-Frame / navigation timeout
`bug` `securus` `reliability` — transient puppeteer errors (`detached Frame`,
`Navigation timeout of 30000ms`) on some cron scans; self-recovers next cron but
can delay pickup. **Next:** wrap navigation in a retry-with-backoff and relaunch
the browser once on a frame-detach.

### 14. No automated D1 backup / conversation export
`enhancement` `ops` — all of Sam's document history lives only in D1. **Next:**
scheduled export of `messages` to R2 (or a `/export` endpoint) so the record
survives accidental loss. User rule: never delete messages.

---

## ⚪ Backlog

### 15. Voice worker (securus-voice) is scaffolded but not deployed
`enhancement` `voice` — Twilio↔Gemini Live↔Deepgram DO bridge exists under
`voice-worker/` but isn't deployed or wired to a number. Needs `GEMINI_API_KEY`,
`DEEPGRAM_API_KEY`, a Twilio number, and collect-call timing tuning.

### 16. Cosmetic: 57 historical outbound rows have `confirmed_sent = NULL`
`chore` — pre-verification-era sends. Harmless; a one-off backfill from the sent
folder would tidy reporting.

---

## Multi-tenant review (2026-08-03)

Review of the multi-contact refactor found and fixed four isolation/correctness
bugs before Ricardo's first exchange:

### ✅ 17. Reply prompt hardcoded Sam for every contact
`bug` `critical` — `buildSystemPrompt` still said "you are writing messages to
sam (samuel mullikin)" regardless of contact; Ricardo's replies would have been
addressed to Sam. Prompt is now fully contact-parameterized (nick, full name,
language), with an explicit boundary to never reference any other contact.
`buildDocument` similarly parameterized (author + language).

### ✅ 18. Subject-dedup crossed contact boundaries
`bug` `critical` — phaseGenerate + /fix-dupes matched outbound subjects across
ALL contacts; a subject collision would mark one contact's inbound as answered
by another's reply. Both queries now scoped by contact_id.

### ✅ 19. Sam's `{tag}_import` reference content silently stopped loading
`bug` `regression` — key format changed to `sam:{tag}_import` but data lives at
the legacy `{tag}_import` key (starkiller_import, 130KB). Added fallback.

### ✅ 20. Send path could fall back to Sam's Securus ID on resolution failure
`bug` `safety` — recipientFor/`/send-one` defaulted to `env.SAM_CONTACT_ID`
with no name check when contact resolution failed. Now hard-fails the part
("refusing to guess") — a wrong-inmate send is unrecoverable.

### 🔴 21. Deep-scan endpoints are still Sam-only
`chore` — /deep-scan, /deep-scan-open use findSamMessages; recovery tooling
won't find missed Ricardo messages. Main cron loop IS multi-contact.

### 🔴 22. /conversation export mixes contacts
`chore` — generateConversationMarkdown has no contact scope. Add ?contact=.

### ✅ 23. Subject-dedup marked new messages as answered by days-old replies
`bug` `critical` — Sam reuses first lines ("MakeUpdate Monday"), so the derived
reply subject collides with earlier replies. Three Aug-3 Monday updates were
silently matched to the July-30 reply and never answered — while a later reply
promised Sam a follow-up the pipeline could never deliver. Fixed: dedup now
requires the reply to POSTDATE the message; duplicate guard only mirrors
actually-handled candidates (no mutual-duplicate deadlock). Messages #302-304
recovered and delivered 2026-08-07 02:02 (outbound #307-309).

### 🔴 24. Stamp auto-purchase (direction change: automation now approved)
`enhancement` `staged` — recon of the Securus purchase flow runs hourly in
phaseScan (`stamp_purchase_recon`); guarded autobuy engine shipped disabled
(`src/securus/stamps.mjs`, `/stamp-autobuy`) with low-water trigger, daily/
weekly caps, mandatory logging + SMS per attempt. Next: review recon capture,
implement the verified click-path, then flip `enabled` after a supervised
first purchase.

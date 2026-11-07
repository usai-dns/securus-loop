# securus-agent v2 — Architecture

> Written 2026-11-07 from a review of Sam's Oct 21 – Nov 6 traffic (messages #430–#523,
> 92 messages, ~55 stamps/11 days) plus his own "Functionality" project (#463).
> This is the design brief. ARCHITECTURE.md remains the v1 reference until v2 lands.

## 1. What the review found

| # | Failure (evidence) | Root cause | v2 answer |
|---|---|---|---|
| F1 | 4-image request (#446) got ONE fused image and a reply that said *"I can't generate or attach images through Securus"* (#461). Two `MakeImage` directives in one message (#498) → one image; the reply (#508/#509) then *claimed* three images were queued and misnamed the one attached. | Image pipeline is single-image; the reply model is never told what the pipeline will/won't attach, so it guesses. | **Request ledger** + **capability manifest** + **multi-image** (§3, §4, §5) |
| F2 | "I'll send the rest in my next message" — never arrives (#463 item 2, #515 "Missing Message", #509). | Single-shot generation; a promise is just text. | **Request ledger carries open items to the next cycle**; replies may not promise, only report open tasks (§3) |
| F3 | The 436K-char Qualia Series Bible was overwritten by `MakeNew Qualia` (#441 → v2 = 12K chars). Later answers (#460, #500) truthfully said the doc lacked character descriptions. | `MakeNew` on an existing tag replaces it; whole-document regeneration. Restored 11-07 as `qualia-bible`. | **Protected reference docs; MakeNew archives instead of overwriting** (§6) |
| F4 | Swarm 130K, Monday 131K, Qualia 121K chars — right at the 32k-token output cap of `buildDocument`; the model itself flags "context limits in how the document has been maintained" (#478). Each rewrite silently truncates. | Documents are regenerated whole on every update. | **Sectioned documents + patch updates + change log** (§6) |
| F5 | Project files don't record who wrote what; the AI praised Sam for its own insight (#465, #463 item 3). | Single-voice regeneration erases provenance. | **Dated, authored entries ledger** (§6) |
| F6 | Internal tool preamble leaked into a sent message: *"I'll search all the key areas… before writing back to Sam.Sam,"* (#438); third-person slips (#460). | All text blocks around server tool calls are concatenated. | **Reply hygiene filter** (§5) |
| F7 | Sam sends 4–6 messages in one sitting; replies arrive one-per-message with redundant "I see you sent a cluster" preambles and cross-promises (#474, #509). | Each inbound is generated in isolation. | **Batch-aware generation** (§7) |
| F8 | No continuity: "needs a personal preferences and continuity file" (#463 item 1); every reply starts cold beyond the one topic doc. | No per-contact memory. | **Contact profile document** (§8) |
| F9 | Stamps hit 1 with no warning to Sam; he asked for warnings at 10/5/3/2/1 (#463 item 5). 61 → 6 in 11 days. | Only Dennis is alerted (and SMS is a no-op). | **Stamp notices in replies** (§9) |
| F10 | Sam specifies models — "Run this prompt on Seedream 5.0", "GPT Image 2.5 Flare", Nano Banana Pro (#497, #498, #442). | Client hardwired to Soul v2 standard. | **Model routing in images v2** (§4) |
| F11 | Documentary project asks for a protocol with scheduled check-in threads (#462). | No agent-initiated messaging. | **Scheduled prompts** — v2.1 (§10) |

## 2. Principles

1. **Everything Sam asks for becomes a tracked request.** Replies report delivered/open requests; they never promise.
2. **The model only speaks about capabilities the pipeline guarantees.** The pipeline tells it, per reply, exactly what will be attached.
3. **Documents are append-mostly, sectioned, and attributed.** No whole-document regeneration.
4. **Isolation is absolute.** Every new table carries `contact_id`; no cross-contact reads (unchanged invariant).
5. **Stamps are a budget.** Every send counts; Sam sees the balance when it matters.

## 3. Request ledger (`requests` table)

```
requests(id, contact_id, inbound_id, kind, label, spec JSON, status, priority,
         fulfilled_by_outbound_id, attempts, created_at, updated_at, note)
kind    ∈ answer | image | doc_update | research | followup
status  ∈ open | in_progress | done | deferred | failed | cancelled
```

- **Extraction** (`src/ai/requests.mjs`): after SCAN saves an inbound, one small LLM call extracts discrete requests. Image requests get `spec = {label, prompt, model?, count, references?}`; a "four pictures of X: exploded / top / side / front" request becomes four image requests with a shared `group` label.
- **Fulfilment**: GENERATE loads all `open` requests for the contact (carry-overs first). The reply draft is produced against that list. Deterministic fulfilment for images (pipeline success ⇒ `done`). For answers, a cheap post-pass asks the model which request ids the draft fully answers; the rest stay `open` with a `note`.
- **Carry-over**: open requests older than the current inbound are worked in later cycles as their own outbound ("Here's the rest of what you asked for on Tuesday…"), capped at `MAX_CARRYOVER_PER_CYCLE` so Sam never gets flooded.
- **Reply footer** (pipeline-generated, factual): `Delivered: Saga2, Wytches2 (attached) · Still working on: Saga3`.
- **Dashboard**: Requests tab (open/done per contact, age, kind). `/api/requests?contact=`.

## 4. Images v2

- **Grammar**: `MakeImage - Label: prompt (Run this prompt on <Model>)` — any number per message; `MakeImage <project>` and inline `makeimage "…"` unchanged; plain-language resolver may emit several.
- **Model registry** (`src/ai/images.mjs`): `{ id, path, body builder, cost }` for Higgsfield Soul v2 (default), Seedream, GPT-Image, Nano Banana Pro — only those whose endpoint the agent verifies from docs.higgsfield.ai; unknown model → default + note in footer. Model hint parser maps "Seedream 5.0", "GPT Image 2.5 Flare", "Nano Banana Pro", "Soul".
- **Attachments**: `send_queue.image_ids` (JSON array, keeps `image_id` for compat). Compose attaches up to **5** per message (Securus cap, verified by recon); more ⇒ overflow onto part 2+. Each attached image's label appears in the body ("Attached: 1) Saga2 — Seedream · 2) Wytches2 — Seedream").
- **Reference images**: v2 stores `references` in spec but the Higgsfield reference-image path is **v2.1** (needs recon of the image-to-image endpoint).
- **Gallery**: label + model + request id shown.

## 5. Reply generation v2

- **Capability manifest** block in the system prompt per reply: what WILL be attached (labels/models), what was NOT possible and why (e.g. unknown model, generation failed/nsfw), open requests being carried over, stamp balance line if ≤ 10. Rule: *"Never state that you cannot attach images; never describe an image that is not in the manifest."*
- **Budget**: draft the complete answer, then `splitForSend` with a hard cap of **3 parts**; if the draft exceeds 3 parts the model is re-asked to compress and move overflow into explicit `followup` requests (which the ledger then delivers later). Default target 1 part; multi-message only when the content needs it.
- **Hygiene filter**: keep only the text produced after the last server tool-use block when such blocks exist and the trailing text is substantial; otherwise strip leading blocks matching tool-preamble patterns ("I'll search…", "Let me look up…"). Strip any `Sam,`/greeting duplication. Unit-tested.
- **Voice**: first person as Dennis, address Sam as "you" — an automated check rejects drafts containing "Sam has", "Sam's message" etc. in narrative position and regenerates once.

## 6. Documents v2 (provenance ledger)

```
document_entries(id, contact_id, tag, entry_date, author ∈ sam|ai, inbound_id, outbound_id,
                 summary, content, created_at)
documents(+ protected INTEGER DEFAULT 0, + sections JSON, + changelog TEXT)
```

- A document is **sections** (ordered `{heading, body}`) + a **change log** + the **entries ledger**. `content` is rendered from sections for display/context (so existing readers keep working).
- `MakeUpdate` ⇒ (1) append a `sam` entry with the inbound text (dated), (2) ask the model for a **patch**: `{section_updates:[{heading, body}], new_sections:[…], changelog:"…"}` applied deterministically — never a whole-document rewrite, so size is bounded by the sections actually touched, (3) append an `ai` entry summarising the response. Output is bounded; nothing silently truncates.
- `MakeNew <tag>` on an existing tag ⇒ archive the current doc as `<tag>-archived-<yyyymmdd>` (protected) and start fresh. Never overwrite.
- `protected = 1` docs (e.g. `qualia-bible`) are read-only to commands and never passed to the patcher.
- **Migration**: existing docs become one section "Document" + empty log; a one-time pass may ask the model to split headings (`/migrate-doc-sections?tag=`). Entries start at migration time (history before that lives in `document_versions`).
- **Context**: `<current_document>` keeps the 200K head+tail cap; references keep 80K. Reference matching also honours doc titles and hyphen/space variants ("series bible" ⇒ `qualia-bible`).

## 7. Batch-aware generation

- GENERATE groups unresponded inbound by contact; within a group it works in Sam's send order. Each reply still answers one inbound, but the prompt carries a one-line list of the sibling messages in the same batch ("also received this hour: 10-31a, 10-31b…") and the open-request list, so replies don't re-announce the batch or promise cross-coverage.
- Tiny acknowledgements (e.g. "no need to respond — more coming", #510) create no reply; they add a `followup` request with a wait condition instead.

## 8. Contact profile document

- One per contact: tag `profile`, `protected`, maintained by the pipeline, not by Sam's commands. Sections: *Preferences & voice*, *Projects index* (tag, one-liner, last activity, status), *Commitments & cadence* (e.g. Documentary check-ins), *Open threads*, *Glossary*.
- Refreshed by a small LLM pass after each GENERATE cycle that produced output; injected into every reply prompt (cap 8K chars) ahead of the topic doc.

## 9. Stamps

- phaseSend records the post-send balance; GENERATE includes a `Stamps` line in the manifest when balance ≤ 10: *"Stamps left after this message: N"* at thresholds 10/5/3/2/1 (Sam's spec). Dennis alerts unchanged (SMS still a no-op until Telnyx relay).

## 10. v2.1 (specified, not built in this pass)

- **Scheduled prompts**: `scheduled_prompts(contact_id, cron/next_at, prompt, doc_tag)` — agent-initiated threads (Documentary back-story sessions).
- **Reference-image input** for image generation.
- **Request status digest** to Sam on request ("status").

## 13. Project State registry (added 2026-11-07 — F12)

**F12 (Sam, #493/#495):** the rangefinder was changed on Oct 27 (TFmini-S 12m → Garmin LIDAR-Lite v3 40m); a week later replies still derived rules from the 12m limit and the model admitted it (#502, #506). The document is prose and the ledger is events; nothing held the project's *current truth*, and nothing propagated a correction into sections that still cited the old value.

```
project_state(id, contact_id, tag, key, value JSON, status ∈ current|superseded|retracted,
              set_by_inbound_id, set_by_author, supersedes_id, note, set_at)
```

- **Typed facts with provenance** ("interpretable context"): dotted keys by namespace — `hardware.rangefinder = {model, range_m}`, `rules.battery_reposition_pct = 20`, `decisions.first_test.relay_drones = "none"`, `software.cv_model`, `people.<role>`, `timeline.<milestone>`. A changed value supersedes the current row; history is never deleted.
- **Extraction** (`src/ai/state.mjs::extractStateChanges`): after each MakeUpdate reply is drafted, one LLM pass over the author's message + the assistant's confirmed answers emits settled changes only (confirmations, choices, corrections, retractions — never questions or proposals). `applyStateChanges` upserts with supersede semantics and returns `{ set, superseded, retracted, unchanged }`.
- **Injection**: `renderStateBlock(currentRows, { assets })` → `<project_state>` block placed **before** `<current_document>` in every prompt for that project (`prompt.mjs` option `projectState`), declared authoritative over document/history/memory. Project assets (images: id, label, date, prompt) are listed in the same block so the model knows which pictures exist.
- **Consistency sweep**: when `superseded` is non-empty, `sectionsCitingStale(sections, superseded)` finds sections still mentioning old values and `consistencySweepInstruction()` is appended to the `buildDocumentPatch` material, so the patch corrects them in the same update. The change log records the history; bodies carry only the current value.
- **Dashboard**: State tab per project — current facts grouped by namespace, per-key history; `/api/state?contact=&tag=`.

## 14. Session reconciliation (added 2026-11-07)

A per-cycle safety net under the ledger: after GENERATE, compare for each contact the requests extracted this cycle vs. the work actually queued (parts, image_ids, state changes, doc patches). Discrepancies (request with no fulfilling draft, image request with no image row, doc_update with no entry) are logged to `system_state.session_review` and converted into `followup` requests so they are delivered next cycle. Surfaced on the dashboard Requests tab as "reconciliation notes".

## 11. Build plan

Wave 1 — parallel, each in its own worktree, **no edits to `src/index.js`** (expose functions + write `docs/v2/NOTES-<area>.md` with integration points):
- **W1-A Images v2** — `src/ai/images.mjs`, `src/docs/commands.mjs` (image grammar), `src/securus/compose.mjs` (multi-attach), `src/db/images.mjs`, `src/db/send_queue.mjs` (image_ids).
- **W1-B Documents v2** — `src/db/documents.mjs`, `src/ai/responder.mjs::buildDocument` → patch mode, MakeNew archive guard helper, protected flag, title/alias matching in `src/docs/commands.mjs::mentionedTags`.
- **W1-C Reply v2** — `src/ai/responder.mjs::generateResponse` hygiene + budget, `src/ai/prompt.mjs` manifest/profile slots, `splitForSend` cap, stamp notice helper, voice check.

Wave 2 — sequential (index.js): request ledger (`src/db/requests.mjs`, `src/ai/requests.mjs`), batch-aware GENERATE, profile maintenance pass, wiring of Wave 1, migrations, dashboard Requests tab, `/api/requests`.

Wave 2.5 — Project State wiring (§13) into GENERATE: state block in prompts, extraction after each MakeUpdate draft, consistency sweep into the doc patch, assets in the block; `/api/state`; Session reconciliation (§14).

Wave 3 — test & review agents: unit tests green, `/draft` dry-runs on #446 and #498 (expect 4 and 2 image requests), live `/image-test` per registered model, code review; then deploy + capability update message to Sam.

## 12. Acceptance

- #446 replayed ⇒ 4 image requests, 4 attachments (one message), footer lists all four, no "I can't attach".
- #498 replayed ⇒ 2 images on the requested model, labels in body.
- A reply that would need 5 parts ⇒ ≤ 3 parts sent + `followup` requests created and delivered next cycle.
- `MakeNew swarm` ⇒ `swarm-archived-<date>` exists, `swarm` is fresh; `qualia-bible` rejects commands.
- Swarm update ⇒ `document_entries` gains a `sam` and an `ai` entry; `content` changes only in touched sections; size does not shrink unexpectedly.
- Stamp balance 6 ⇒ reply footer says so.
- 133 existing tests + new tests pass.

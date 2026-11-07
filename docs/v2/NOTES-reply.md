# W1-C — Reply generation v2: integration notes

Branch work for `docs/V2_ARCHITECTURE.md` §5 (hygiene, manifest, budget, voice), §8 (profile slot),
§9 (stamp notice). No `src/index.js` edits — this file is the recipe for Wave 2.

Incidents this closes: tool preamble leaked into #438 ("I'll search all the key areas… Sam.Sam,");
replies denying image ability while an image was attached (#461) or naming images never generated
(#508/#509); "I'll send the rest in my next message" with nothing following (#463/#509/#515);
third-person "Sam" mid-reply (#460); stamp warnings at 10/5/3/2/1 (#463 item 5).

## Exports

### `src/ai/responder.mjs`

| Export | Signature | Notes |
|---|---|---|
| `generateResponse` | `(env, inbound, history, knowledge, subjectLength, topicHistory, topicName, opts)` | **Unchanged positional params.** `opts` gains optional `manifest` and `profile` (passed through to `buildSystemPrompt`). SSE parsing now tracks content blocks and returns `cleanReplyText(blocks)` instead of blind concatenation. |
| `cleanReplyText` | `(blocks: [{ type, text }]) → string` | Pure. Tool blocks present + ≥ 400 chars of text after the last one ⇒ only that trailing text. Otherwise every text block minus tool-preamble blocks (only blocks that a tool block follows are ever dropped). Collapses duplicate greetings (`Sam,\n\nSam,`, glued `Sam.Sam,`). Never returns `''` when any text existed. |
| `voiceViolations` | `(text, contactName: string \| string[]) → string[]` | Pure. Snippets for third-person narration: `Sam has/asked/…`, `Sam's`, `to/for/with/about Sam`, `the user/sender/inmate/recipient/requester`. Ignores direct address (`Sam,`, `Sam —`, `thanks, Sam.`), `"quoted"`/`“quoted”` speech and `>` lines. Pass both the nick and the legal name: `voiceViolations(text, [contactId, contact.name])`. `[]` = clean. |
| `splitForSend` | `(subject, body, { maxParts = Infinity } = {}) → parts[]` | **Existing signature intact**; uncapped by default because `makefull` sends whole governing docs through it. Pass `{ maxParts: 3 }` to cap (overflow dropped — use `planParts` when you need the remainder). |
| `planParts` | `(subject, body, maxParts = 3) → { parts, truncated, overflowText }` | Pure. Same splitter, first `maxParts` kept. |
| `budgetReply` | `async (env, draft, { subject = '', subjectLength = null, maxParts = 3 }) → { text, overflowItems, compressed, truncated }` | Fits ⇒ `{ text: draft, overflowItems: [] }` with no API call. Otherwise ONE streaming `RESPONDER_MODEL` call (usage kind `budget`) asking for strict JSON `{"text","overflow_items"}`; result re-planned and hard-cut at the part boundary if still too long. No key / API failure / bad JSON ⇒ hard cut with one overflow item `remainder of the reply (N chars not sent)`. |
| `parseBudgetJson` | `(raw) → { text, overflowItems } \| null` | Pure. Tolerates fences/prose around the JSON. |
| `replyFooter` | `(manifest) → string` | Pure. Lines: `Attached: 1) Saga2 — Seedream · 2) …`, `Couldn't produce: X (reason)`, `Still working on: A, B — coming in a later message`, stamp notice. `''` when nothing to say. **No separator included** — see recipe. `carriedOver` adds no footer line (the body covers it). |
| `stampNotice` | `(balance) → string \| null` | Re-exported from `prompt.mjs`. `≤ 10` ⇒ `Stamps left after this message: N`; `≤ 0` ⇒ `… 0 — I can't send again until Dennis adds stamps`; else `null`. Accepts the string stored in `system_state`. |
| `applyStreamEvent`, `newStreamAcc` | SSE reducer | Exposed for tests; `streamClaude` (internal) uses them for both the reply and the budget call. |

### `src/ai/prompt.mjs`

`buildSystemPrompt(history, knowledge, subjectLength, topicHistory, topicName, opts)` — `opts` gains:

- `profile` (string) → `<contact_profile>` (head-capped at 8,000 chars) rendered **before** `<current_document>`.
- `manifest` → `<capability_manifest>` rendered after `<knowledge_base>`, before `<boundaries>`:

```js
manifest = {
  attachments:   [{ label, model }],   // what compose WILL attach to THIS message (image_ids on part 1)
  failed:        [{ label, reason }],  // generation failed / nsfw / unknown model
  openRequests:  [{ label, kind }],    // ledger items still open → later messages
  carriedOver:   [{ label }],          // older open items this reply is fulfilling
  stampsLeft:    number | null,        // post-send balance; line rendered only when ≤ 10
  batchSiblings: [{ subject }],        // other inbound from the same contact this cycle
}
```

An empty `attachments` array renders explicitly as "nothing attached" — always pass a manifest object (even `{}`)
once Wave 2 wires this, so the model is never left guessing. With a manifest present the `<character_limit>`
overflow sentence stops telling the model to "continue in a follow-up message"; everything else (language block,
200K `current_document` cap, `reference_document` blocks, isolation boundary) is unchanged.

## Integration recipe — `phaseGenerate` (index.js, Wave 2)

```js
import { generateResponse, voiceViolations, budgetReply, replyFooter, splitForSend, planParts } from './ai/responder.mjs';

// 0. inputs already in hand: contactId (nick), contact (name, language, securus_id),
//    bodyForAi, recentHistory, knowledgeEntries, topicHistory, effectiveTag, currentDocument,
//    referenceDocs, replySubject; plus the request ledger for this contact.

// 1. run image generation FIRST (so the manifest states facts, not intentions)
const imageResults = await runImageRequests(env, { contactId, requests: openImageRequests }); // W1-A
const attachments = imageResults.filter(r => r.ok).slice(0, 5).map(r => ({ label: r.label, model: r.model }));
const failed      = imageResults.filter(r => !r.ok).map(r => ({ label: r.label, reason: r.nsfw ? 'content flagged' : r.unknownModel ? `unknown model, used default` : 'generation failed' }));

// 2. build the manifest
const stampState = await getState(env.DB, 'stamp_balance');                // written by phaseSend after each send
const stampsLeft = stampState === null ? null : parseInt(stampState, 10) - 1; // balance AFTER this message goes out
const manifest = {
  attachments, failed,
  openRequests:  openRequests.filter(r => r.status === 'open' && !fulfilledHere(r)).map(r => ({ label: r.label, kind: r.kind })),
  carriedOver:   carried.map(r => ({ label: r.label })),
  stampsLeft,
  batchSiblings: batch.filter(m => m.id !== msg.id).map(m => ({ subject: m.subject })),
};
const profile = (await getDocument(env.DB, contactId, 'profile'))?.content || null; // §8, protected doc

// 3. generate (hygiene is applied inside)
const genOpts = { fullDocument: isFullDoc, currentDocument, language: contact?.language, contactName: contact?.name, contactNick: contactId, referenceDocs, manifest, profile };
let aiResponse = await generateResponse(env, bodyForAi, recentHistory, knowledgeEntries, replySubject.length, topicHistory, effectiveTag, genOpts);
if (!aiResponse) return;

// 4. voice check — regenerate ONCE when violations exist, keep whichever is cleaner
const bad = voiceViolations(aiResponse, [contactId, contact?.name]);
if (bad.length) {
  console.log(`voice: ${bad.length} third-person slip(s) — regenerating once: ${bad.slice(0, 3).join(' | ')}`);
  const retry = await generateResponse(env, bodyForAi, recentHistory, knowledgeEntries, replySubject.length, topicHistory, effectiveTag, genOpts);
  if (retry && voiceViolations(retry, [contactId, contact?.name]).length < bad.length) aiResponse = retry;
}

// 5. budget — hard cap 3 parts (skip for makefull / fullDocument sends)
const budget = isFullDoc
  ? { text: aiResponse, overflowItems: [] }
  : await budgetReply(env, aiResponse, { subject: replySubject, maxParts: 3 });
for (const label of budget.overflowItems) {
  await createRequest(env.DB, { contactId, inboundId: msg.id, kind: 'followup', label, status: 'open' }); // ledger (Wave 2)
}
if (budget.overflowItems.length) manifest.openRequests.push(...budget.overflowItems.map(label => ({ label, kind: 'followup' })));

// 6. footer — pipeline-written facts; separator belongs to the caller
const ack = docAcknowledgment(docCmd, docTag) + referenceAckLine;
const footer = replyFooter(manifest);
const finalResponse = ack + budget.text + (footer ? `\n\n— — —\n${footer}` : '');

// 7. queue (footer is short; re-plan rather than trust the pre-footer fit)
const outboundParts = splitForSend(replySubject, finalResponse, { maxParts: 3 });
await queueOutboundParts(env.DB, { inboundId: msg.id, seriesId: null, parts: outboundParts, docTag: effectiveTag, contactId, securusId: contact?.securus_id });
if (attachments.length) await setQueueImageIds(env.DB, msg.id, imageResults.filter(r => r.ok).map(r => r.imageId)); // W1-A send_queue.image_ids
```

Notes for the wiring pass:

- **Order matters**: images before generation, so `attachments`/`failed` are facts. If an image request is
  deferred to a later cycle instead, list it under `openRequests`, never `attachments`.
- **`stampsLeft`** comes from `system_state.stamp_balance` (string). phaseSend already stores the post-send balance
  (`lastKnownStamps = sendResult.stampBalance - 1`), so a reply queued now will leave `balance - 1` after it goes out;
  with a multi-part reply subtract `outboundParts.length` instead. `null` state ⇒ pass `null` (no line).
- **Series path** (`phaseGenerate` series branch, index.js ~L436) uses the same recipe with `combinedBody`.
- **makefull** keeps calling `splitForSend(subject, body)` with no cap — do not add `maxParts` there.
- **Legacy image trailer** in index.js (`"Your image is attached…"` / `"I'll send it in a follow-up"`) must go once
  `replyFooter` is appended, or the two will disagree.
- The existing side-effect `console.log` lines (`[AI] hygiene: …`, `[BUDGET] …`) are the only observability; the
  dashboard can later surface `voiceViolations` counts if useful.

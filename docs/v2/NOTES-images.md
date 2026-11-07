# Wave 1-A — Images v2: integration notes

> Built 2026-11-07 on `worktree-agent-ad7c968d2cfbb60c6` (from `claude/deploy-test-worker-TeBfE`).
> No edits to `src/index.js`. Everything below is additive; existing call sites keep working.
> Spec: `docs/V2_ARCHITECTURE.md` §4 (Images v2), §11 (W1-A), §12 (acceptance).

## 1. Exported functions

### `src/docs/commands.mjs`

| Export | Signature | Notes |
|---|---|---|
| `parseImageDirectives` | `(body) → { images: [{ label, prompt, modelHint, modelHintRaw }], cleanBody }` | Finds EVERY `MakeImage - Label: prompt … (Run this prompt on <Model>)` directive anywhere in the body. `label` null when absent; `modelHint` is a registry/hint id (`soul`, `gpt-image`, `seedream`, `nano-banana`) or null; `modelHintRaw` is the text Sam wrote (for the footer: "unknown model 'X' — used Soul"). `cleanBody` = body with directive lines removed (`\n{3,}` collapsed, trimmed). |
| `normalizeModelHint` | `(text) → 'soul' \| 'gpt-image' \| 'seedream' \| 'nano-banana' \| null` | "Seedream 5.0"/"Seedream" → seedream · "GPT Image 2.5 Flare"/"GPT Image"/"gpt-image"/"Flare" → gpt-image · "Nano Banana Pro"/"Nano Banana" → nano-banana · "Soul"/"Soul v2"/"Higgsfield" → soul · unknown → null. |
| `parseImageCommand`, `parseInlineImage` | unchanged | Legacy `MakeImage <project>` (line 0) and inline `makeimage "…"` still work. |

Grammar rules (as implemented):
- Keyword at line start: `make[ -]?(image|img)` any case. Separator `-` `–` `—` `:` optional — **except on line 0**, where a separator-less `MakeImage swarm …` is the legacy project form and is left to `parseImageCommand` (a `Label:` on line 0 still counts as v2).
- Label = short text (≤ 40 chars, ≤ 4 words, no commas) before the first `: `. `Saga2:` / `Drone views:` yes; `…Saga aesthetic - a figure` no (that stays prompt).
- A directive spans its line plus following non-blank lines; a blank line ends it **unless** the next paragraph starts like a list item (`(1)`, `1.`, `1)`, `-`, `•`), so "(1) exploded … (2) top …" stays ONE directive (the wave-2 LLM request extractor splits multi-view asks; this parser never does).
- Model hint: trailing `(Run this prompt on X)` / `(run on X)` / `(use X)` / `(model: X)`, parentheses optional, must be at the END of the prompt. Stripped only when it names a known model or uses the explicit "run this prompt" wording — `(use warm colors)` stays in the prompt.
- Directive with an empty prompt (`MakeImage -`) is dropped.

### `src/ai/images.mjs`

| Export | Signature | Notes |
|---|---|---|
| `IMAGE_MODELS` | `{ soul, 'gpt-image' }` each `{ id, label, path, usageModel, cost, buildBody(prompt, { aspectRatio }) }` | See §3 for verification. `buildBody` clamps unsupported aspect ratios to `1:1`. |
| `DEFAULT_IMAGE_MODEL` | `'soul'` | |
| `resolveImageModel` | `(id) → { model, fallback }` | Case-insensitive; unknown/unverified id → soul with `fallback: true`. |
| `generateImage` | `(env, { prompt, model = 'soul', aspectRatio = '1:1', pollSeconds = 110 }) → { success, requestId, mime, bytesB64, sourceUrl, cost, model, modelFallback, requestedModel? }` | Failures also carry `model`/`modelFallback` (`{ success:false, error, nsfw?, notConfigured? }`). Auth via existing `hfFetch` (`Key id:secret` candidates), polling via `/requests/{id}/status`, chunked base64, `recordUsage(kind:'image', model: m.usageModel, flatCost: m.cost)`. |
| `hfConfigured`, `hfAuthCandidates`, `PER_IMAGE_COST` | unchanged | |

### `src/securus/compose.mjs`

| Export | Signature | Notes |
|---|---|---|
| `composeAndSend` | `(page, { contactId, contactName, subject, body, attachment?, attachments? })` | `attachments: [{ filename, mime, bytesB64, label }]` (≤ 5). Legacy `attachment` still works (wrapped). Result gains `attachments: { requested, attached, registered }` (`registered` = count the page exposed, or null). |
| `normalizeAttachments` | `({ attachment, attachments }) → [{ filename, mime, bytesB64, label }]` | Pure; list wins over single; drops empty entries; fills defaults. |

Behaviour: files are attached **sequentially** (click Attachments → inject one file → wait → repeat; the hidden input is `multiple=false`). The Attachments click is only mandatory when no `input[type=file]` is present yet (after file 1 the control may disappear while the input stays). Each file is downscaled in-page (canvas → 1280px JPEG q0.85) as before. **Any** attach failure returns `{ success:false }` BEFORE Send — no stamp spent. After the loop the registered count is logged (filename text / remove controls; best-effort, never fatal). The 25-nudge Send-enabled poll applies whenever `files.length > 0`. More than 5 files → immediate `{ success:false, error:'Too many attachments…' }` (caller bug: split with `chunkImageIds`).

### `src/db/images.mjs`

| Export | Signature | Notes |
|---|---|---|
| `saveImage` | `(db, { contactId, docTag, intent, prompt, label, model, requestId, parentImageId, hfRequestId, mime, dataB64, cost }) → imageId` | New: `label`, `model`, `requestId` (→ `request_id`, ledger FK). Chunking unchanged. |
| `getImage` | `(db, id)` | `SELECT *` → new columns come through. |
| `getImages` | `(db, ids) → rows[]` | New: ordered multi-fetch (missing ids skipped). |
| `listImages` | `(db, contactId, docTag?)` | Now also returns `label, model, request_id, hf_request_id`. |
| `imageFilename` | `(imgRow) → 'saga2-12.jpg'` | New: ASCII-safe attachment name from label/doc_tag + id. |
| `latestImageForProject` | unchanged | |

### `src/db/send_queue.mjs`

| Export | Signature | Notes |
|---|---|---|
| `MAX_ATTACHMENTS_PER_MESSAGE` | `5` | Securus cap (recon). |
| `getPartImageIds` | `(row) → number[]` | `image_ids` JSON if present/valid/non-empty, else `[image_id]` if set, else `[]`. Dedupes, drops non-positive/non-numeric. Safe before the migration runs (no `image_ids` column → falls back). |
| `setPartImageIds` | `async (db, queueId, ids) → cleanIds` | Writes `image_ids` JSON AND `image_id` = first id (compat with dashboard, `/queue`, standalone send). Requires the migration. |
| `chunkImageIds` | `(ids, max = 5) → number[][]` | Batches for overflow onto part 2+. |

`queueOutboundParts` is **unchanged** on purpose: its INSERT must keep working if the `image_ids` migration has not run yet; attach ids afterwards with `setPartImageIds`.

## 2. Migration SQL (append to the `migrations` array in `src/index.js` `/migrate`)

```sql
ALTER TABLE images ADD COLUMN label TEXT
ALTER TABLE images ADD COLUMN model TEXT
ALTER TABLE images ADD COLUMN request_id INTEGER
ALTER TABLE send_queue ADD COLUMN image_ids TEXT
```

(The existing loop already tolerates "duplicate column" errors on re-run.) Optional, for the gallery filter: `CREATE INDEX IF NOT EXISTS idx_images_request ON images(request_id)`.

## 3. Model registry — research results (docs.higgsfield.ai, 2026-11-07)

| id | label | POST path | body | status |
|---|---|---|---|---|
| `soul` (default) | Higgsfield Soul v2 | `/higgsfield-ai/soul/v2/standard` | `{ prompt, aspect_ratio, resolution:'720p' }` — ratios `9:16 16:9 4:3 3:4 1:1 2:3 3:2`, resolution `720p\|1080p` (also optional `enhance_prompt, seed, batch_size 1\|4, style_id, custom_reference_id`) | **verified** — `docs/models/soul-2/generate` |
| `gpt-image` | GPT Image 2.5 Flare | `/marketing-studio/image/flare` | `{ prompt(1–5000), aspect_ratio, resolution:'1k', quality:'high', enhance_prompt:false, moderation:'auto' }` — ratios `auto 1:1 3:2 2:3 4:3 3:4 16:9 9:16 21:9`; resolution `1k\|2k\|4k`; quality `low\|medium\|high\|xhigh\|max`; `additionalProperties:false`; `enhance_prompt:true` would REQUIRE `preset_id` + `image_urls`, so it stays false; "Omit image_urls for text-to-image" is stated on the page | **path + schema verified** — `docs/models/marketing-studio-image/flare`. Caveat: the Flare page does not name its rendering model; the identity "GPT Image 2.5 Flare" comes from the image-generation index/Ads Studio page ("rendered as images with GPT Image 2.5 Flare") and the matching "2.5 Flare" workflow name. Cost 0.10 is an estimate (no price on the page). Wave 3 `/image-test?model=gpt-image` must confirm before Sam is told it is GPT Image. |

**Unverified — NOT registered** (hint ids still parse; `generateImage` falls back to soul with `modelFallback:true` + `requestedModel` so the reply footer can say "Seedream isn't available through our image service yet — rendered on Soul"):

- `seedream` — "Seedream 5.0" (#497/#498). No page anywhere on docs.higgsfield.ai (index `docs/models/image-generation`, `docs/models.md`, `docs/llms.txt` (33 URLs), `docs/openapi.json`; probed `docs/models/seedream-5.md` → 404). The Higgsfield **app** catalog (MCP `models_explore`) does list `seedream_v5_pro`, `seedream_5_0_flash`, `seedream_v5_lite`, `seedream_v4_5` — so the model exists on the platform but has no documented REST endpoint for our API key.
- `nano-banana` — "Nano Banana Pro" (#442). Same: no docs page (`docs/models/nano-banana-pro.md` → 404); app catalog has `nano_banana`, `nano_banana_pro`, `nano_banana_2`, `nano_banana_2_1`, `nano_banana_2_lite`.
- Also seen in the app catalog but not in REST docs: `gpt_image_2_5` (variants `flare|sunburst`), `gpt_image_2_6`, `flux_2`, `kling_omni_image`. The REST docs DO have text-to-image pages we did not register (no hint from Sam yet): Soul standard `/higgsfield-ai/soul/standard`, Qwen Image 3 `/alibaba/qwen-image-3/text-to-image` (`{ prompt, aspect_ratio, resolution:'1k'|'2k', prompt_extend, enable_thinking, negative_prompt, seed }`), Grok Image 2.0, Recraft V4.1, Ideogram 4.0, Z-Image Turbo, Marketing Studio `/marketing-studio/image` (2.0 Alpha) and `/marketing-studio/image/flare|sunburst`.
- Polling (docs/concepts/polling): terminal statuses `completed | failed | nsfw | canceled` (matches the existing loop); docs recommend 2s → 10s backoff — we poll every 3s, fine.
- `docs/openapi.json` is stale (lists only soul/standard, kling, minimax) — don't use it as the source of truth; the per-model pages are.

## 4. How `src/index.js` should call the new pieces (Wave 2 pseudo-diff)

### Imports

```diff
-import { generateImage, hfConfigured, hfAuthCandidates, PER_IMAGE_COST } from './ai/images.mjs';
-import { saveImage, getImage, latestImageForProject, listImages } from './db/images.mjs';
-import { parseDocCommand, docAcknowledgment, parseReferenceDirectives, parseImageCommand, parseInlineImage, mentionedTags } from './docs/commands.mjs';
-import { queueOutboundParts, …, safeSubject } from './db/send_queue.mjs';
+import { generateImage, hfConfigured, hfAuthCandidates, PER_IMAGE_COST, IMAGE_MODELS, resolveImageModel } from './ai/images.mjs';
+import { saveImage, getImage, getImages, latestImageForProject, listImages, imageFilename } from './db/images.mjs';
+import { parseDocCommand, docAcknowledgment, parseReferenceDirectives, parseImageCommand, parseInlineImage, parseImageDirectives, normalizeModelHint, mentionedTags } from './docs/commands.mjs';
+import { queueOutboundParts, …, safeSubject, getPartImageIds, setPartImageIds, chunkImageIds, MAX_ATTACHMENTS_PER_MESSAGE } from './db/send_queue.mjs';
```

### `runImageGeneration` — add `label`, `model`, `requestId`

```diff
-async function runImageGeneration(env, { contactId, project, intent, referenceDocs = [], iterate = false }) {
+async function runImageGeneration(env, { contactId, project, intent, referenceDocs = [], iterate = false, label = null, model = 'soul', requestId = null }) {
   …
-  const gen = await generateImage(env, { prompt });
-  if (!gen.success) return { ok: false, prompt, note, error: gen.error, nsfw: gen.nsfw, notConfigured: gen.notConfigured };
+  const gen = await generateImage(env, { prompt, model });
+  if (!gen.success) return { ok: false, prompt, note, label, model: gen.model, modelFallback: gen.modelFallback, error: gen.error, nsfw: gen.nsfw, notConfigured: gen.notConfigured };
   const imageId = await saveImage(env.DB, {
     contactId, docTag: tag, intent, prompt,
+    label, model: gen.model, requestId,
     parentImageId: prev?.id || null, hfRequestId: gen.requestId,
-    mime: gen.mime, dataB64: gen.bytesB64, cost: PER_IMAGE_COST,
+    mime: gen.mime, dataB64: gen.bytesB64, cost: gen.cost ?? PER_IMAGE_COST,
   });
-  return { ok: true, imageId, prompt, note };
+  return { ok: true, imageId, prompt, note, label, model: gen.model, modelFallback: gen.modelFallback, requestedModel: gen.requestedModel };
 }
```

### `phaseGenerate` — v2 directives before the legacy `parseImageCommand` branch

```js
// v2: any number of "MakeImage - Label: prompt (Run this prompt on X)" directives,
// possibly under a MakeUpdate/MakeNew first line. Each becomes one image
// (wave 2: one `requests` row, kind='image', spec={label,prompt,model}).
const dir = parseImageDirectives(msg.body);
if (dir.images.length) {
  if (!hfConfigured(env)) { /* defer as today */ }
  const results = [];
  for (const d of dir.images) {
    const r = await runImageGeneration(env, {
      contactId, project: docTagIfAny /* from parseDocCommand(dir.cleanBody) */, intent: d.prompt,
      label: d.label, model: d.modelHint || 'soul', requestId: reqRow?.id,
    });
    results.push({ ...r, directive: d });
  }
  const okIds = results.filter(r => r.ok).map(r => r.imageId);
  // capability manifest for the reply model (W1-C slot): what WILL be attached
  const manifest = results.map((r, i) => r.ok
    ? `${i + 1}) ${r.label || 'image ' + (i + 1)} — ${IMAGE_MODELS[r.model].label}${r.modelFallback ? ` (requested "${r.directive.modelHintRaw}" — not available, used Soul)` : ''}`
    : `${r.label || 'image ' + (i + 1)}: NOT generated (${r.nsfw ? 'content flagged' : r.error})`);
  // body: reply + factual "Attached: …" footer (never promise; report)
  const parts = splitForSend(replySubject, finalResponse);               // text parts as today
  await queueOutboundParts(env.DB, { inboundId: msg.id, parts, docTag, contactId, securusId: contact?.securus_id });
  // attach ≤5 per part: batch 1 → part 1, batch 2 → part 2, … add text-less
  // overflow parts if there are more batches than text parts
  const batches = chunkImageIds(okIds);                                   // [[…5], […]]
  const rows = (await env.DB.prepare("SELECT id, part_num FROM send_queue WHERE inbound_id = ? ORDER BY part_num").bind(msg.id).all()).results;
  for (let b = 0; b < batches.length; b++) {
    let row = rows[b];
    if (!row) {   // overflow part carrying only images
      await queueOutboundParts(env.DB, { inboundId: msg.id, parts: [{ subject: `${replySubject} (pt ${rows.length + 1})`, body: `More images from your request (${b + 1}/${batches.length}).` }], docTag, contactId, securusId: contact?.securus_id });
      row = (await env.DB.prepare("SELECT id FROM send_queue WHERE inbound_id = ? ORDER BY id DESC LIMIT 1").bind(msg.id).first());
      // NOTE: fix total_parts on all rows for this inbound after adding overflow parts
    }
    await setPartImageIds(env.DB, row.id, batches[b]);                    // writes image_ids + image_id
  }
  continue;
}
// legacy single-image paths stay as they are (parseImageCommand / parseInlineImage),
// but replace their `UPDATE send_queue SET image_id = ?` with:
//   await setPartImageIds(env.DB, part1RowId, [r.imageId]);
// (or keep the raw UPDATE — getPartImageIds reads image_id as a fallback)
```

The same loop applies to `parseInlineImage` + the plain-language resolver when they emit several prompts.

### `phaseSend` (and the standalone `/send-one` path around line 1805)

```diff
-      let attachment = null;
-      if (qp.image_id) {
-        const img = await getImage(env.DB, qp.image_id);
-        if (img?.data_b64) attachment = { filename: `${img.doc_tag}-${img.id}.jpg`, mime: img.mime || 'image/jpeg', bytesB64: img.data_b64 };
-      }
+      const imageIds = getPartImageIds(qp);                 // image_ids JSON → [image_id] → []
+      const imgs = imageIds.length ? await getImages(env.DB, imageIds) : [];
+      if (imgs.length !== imageIds.length) console.log(`queue #${qp.id}: ${imageIds.length - imgs.length} image row(s) missing`);
+      const attachments = imgs.filter(i => i.data_b64).map(i => ({ filename: imageFilename(i), mime: i.mime || 'image/jpeg', bytesB64: i.data_b64, label: i.label }));
       const sendResult = await composeAndSend(page, {
         contactId: rcpt.securusId, contactName: rcpt.name, subject: qp.subject, body: qp.body,
-        attachment,
+        attachments,                                         // ≤5 guaranteed by chunkImageIds at queue time
       });
+      if (sendResult.attachments) console.log(`queue #${qp.id}: attachments requested=${sendResult.attachments.requested} registered=${sendResult.attachments.registered}`);
```

Keep: attach failure → `markPartFailed` (no stamp spent, retried with backoff); insufficient stamps → part stays pending. Memory note: 5 images × ~3MB base64 ≈ 15MB held in the Worker for one part; fine under the 128MB limit, but fetch per part, never for the whole queue.

### Smoke test / capability message (`/image-test`, line ~1229 and ~361)

```js
const gen = await generateImage(env, { prompt, model: url.searchParams.get('model') || 'soul', pollSeconds: 90 });
// response should include gen.model / gen.modelFallback so Wave 3 can run one per registry id
```

### Dashboard / `/api/images`

`listImages` now returns `label`, `model`, `request_id` — show "Saga2 · Soul v2 · req #12" on the gallery card (`src/dashboard.mjs` `loadGallery`).

## 5. Known limitations

- **Parser scope**: a directive ends at the first blank line unless the next paragraph is a list item. Free prose after a blank line that was *meant* as part of the prompt stays in `cleanBody` (and still reaches the reply model as context). Line 0 `MakeImage swarm …` without a separator is intentionally NOT a v2 directive.
- **Label heuristics**: "≤ 4 words, no commas, before `: `" — a prompt beginning with e.g. `Scene: …` yields label `Scene`. Acceptable; the label is cosmetic (filename + footer).
- **Model fallback is silent at the API level**: `generateImage` returns `modelFallback:true`; it is the GENERATE wiring's job to put that in the capability manifest/footer. Never say "rendered on Seedream" unless `model === 'seedream'`, which cannot happen today.
- **gpt-image identity**: path/schema verified; the "GPT Image" rendering identity is inferred (see §3). Treat the label as provisional until `/image-test?model=gpt-image` is run and eyeballed. Flare returns `1k` images (≈1024px) — the in-page downscale still runs on PNGs.
- **Multi-attach is recon-informed, not live-verified**: sequential inject into the last empty `input[type=file]`, best-effort count of registered attachments (filenames in text / remove controls). If Securus re-renders the input per slot or caps differently, the Send-enabled poll (25 nudges) is the backstop and the part fails BEFORE a stamp is spent. First live run should be with 2 images.
- **No schema auto-migration**: `setPartImageIds` and the new `saveImage` columns need the SQL in §2 to have run; `getPartImageIds` and all reads are safe before it.
- **Reference images / image-to-image**: not built (v2.1). `IMAGE_MODELS[*].buildBody` ignores references.
- **Costs**: `cost` per model is an estimate for `recordUsage` metering (soul 0.05, gpt-image 0.10); no billing data from Higgsfield yet.

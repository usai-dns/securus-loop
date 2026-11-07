// Higgsfield image generation (GH#6, v2 model registry — docs/V2_ARCHITECTURE.md §4).
// Docs: api.higgsfield.ai · POST {model.path} with {model.buildBody(prompt)}
//       Authorization: "Key {HF_API_KEY_ID}:{HF_API_KEY_SECRET}"
//       → { request_id, status_url } → GET /requests/{id}/status until
//       terminal (completed | failed | nsfw | canceled) → images[0].url
//
// Image bytes are stored in D1 (base64) for now — the Cloudflare API token
// lacks R2 permissions; swap storeImage() to R2 when the bucket exists.

import { recordUsage } from '../db/usage.mjs';

const HF_BASE = 'https://api.higgsfield.ai';
const PER_IMAGE_COST = 0.05; // soul estimate; tune when billing data lands
const MAX_IMAGE_BYTES = 700 * 1024; // D1-friendly cap

const SOUL_RATIOS = ['9:16', '16:9', '4:3', '3:4', '1:1', '2:3', '3:2'];
const FLARE_RATIOS = ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'];
const pickRatio = (want, allowed) => (allowed.includes(want) ? want : '1:1');

// Only models whose POST path AND body schema were read from docs.higgsfield.ai
// (2026-11-07) are registered. Seedream and Nano Banana have no page there
// (see docs/v2/NOTES-images.md "unverified") — hints for them still parse,
// generateImage falls back to soul and reports modelFallback.
export const DEFAULT_IMAGE_MODEL = 'soul';
export const IMAGE_MODELS = {
  soul: {
    id: 'soul',
    label: 'Higgsfield Soul v2',
    path: '/higgsfield-ai/soul/v2/standard',
    usageModel: 'higgsfield-soul-v2',
    cost: PER_IMAGE_COST,
    // docs/models/soul-2/generate: aspect_ratio 9:16|16:9|4:3|3:4|1:1|2:3|3:2,
    // resolution 720p|1080p. 720p keeps files attachment-friendly.
    buildBody(prompt, { aspectRatio = '1:1' } = {}) {
      return { prompt, aspect_ratio: pickRatio(aspectRatio, SOUL_RATIOS), resolution: '720p' };
    },
  },
  'gpt-image': {
    id: 'gpt-image',
    label: 'GPT Image 2.5 Flare',
    // docs/models/marketing-studio-image/flare — "Marketing Studio Image 2.5
    // Flare"; the Ads Studio page describes its renders as "GPT Image 2.5
    // Flare". Path+schema verified; the rendering-model identity is inferred
    // from that wording (not stated on the Flare page itself).
    path: '/marketing-studio/image/flare',
    usageModel: 'higgsfield-ms-image-flare',
    cost: 0.10, // unverified estimate — no price on the docs page
    // body: prompt(1–5000) · quality low|medium|high|xhigh|max · resolution
    // 1k|2k|4k · aspect_ratio auto|1:1|3:2|2:3|4:3|3:4|16:9|9:16|21:9 ·
    // enhance_prompt(false; true requires preset_id + image_urls) · moderation
    // auto|low. additionalProperties: false — send nothing else.
    buildBody(prompt, { aspectRatio = '1:1' } = {}) {
      return {
        prompt: prompt.substring(0, 5000),
        aspect_ratio: pickRatio(aspectRatio, FLARE_RATIOS),
        resolution: '1k',
        quality: 'high',
        enhance_prompt: false,
        moderation: 'auto',
      };
    },
  },
};

// id → { model, fallback }: unknown/unverified ids resolve to the default
export function resolveImageModel(id) {
  const key = (id || DEFAULT_IMAGE_MODEL).toString().toLowerCase();
  if (IMAGE_MODELS[key]) return { model: IMAGE_MODELS[key], fallback: false };
  return { model: IMAGE_MODELS[DEFAULT_IMAGE_MODEL], fallback: key !== DEFAULT_IMAGE_MODEL };
}

function hfConfigured(env) {
  return !!env.HF_API_KEY_SECRET; // single-key setups are valid (no separate ID)
}

// Auth variants: the docs show `Key id:secret`, but keys are often issued as a
// single token (or "id:secret" pasted whole). Build candidates; callers try
// them in order on 401/403 and remember what worked via the `scheme` arg.
export function hfAuthCandidates(env) {
  const sec = (env.HF_API_KEY_SECRET || '').replace(/\s+/g, '');
  const id = (env.HF_API_KEY_ID || '').replace(/\s+/g, '');
  const out = [];
  if (id && sec) out.push(`Key ${id}:${sec}`);
  if (sec.includes(':')) out.push(`Key ${sec}`);
  if (sec) out.push(`Key ${sec}`, `Bearer ${sec}`);
  return [...new Set(out)];
}

async function hfFetch(env, path, init = {}) {
  const candidates = hfAuthCandidates(env);
  let last = null;
  for (const auth of candidates) {
    const resp = await fetch(`${HF_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: auth, 'Content-Type': 'application/json' },
    });
    if (resp.status !== 401 && resp.status !== 403) {
      return { resp, auth };
    }
    last = resp;
  }
  return { resp: last, auth: null };
}

// Submit + poll + download. Returns
//   { success, requestId, mime, bytesB64, sourceUrl, model, modelFallback }
//   or { success:false, error, nsfw?, model, modelFallback }
export async function generateImage(env, { prompt, model = DEFAULT_IMAGE_MODEL, aspectRatio = '1:1', pollSeconds = 110 }) {
  const { model: m, fallback: modelFallback } = resolveImageModel(model);
  const base = { model: m.id, modelFallback, requestedModel: modelFallback ? model : undefined };
  if (!hfConfigured(env)) {
    return { ...base, success: false, notConfigured: true, error: 'HF_API_KEY_ID / HF_API_KEY_SECRET not set' };
  }
  if (modelFallback) console.log(`[IMAGE] model "${model}" not in registry — using ${m.id}`);

  const { resp: submit } = await hfFetch(env, m.path, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(m.buildBody(prompt, { aspectRatio })),
  });
  if (!submit || !submit.ok) {
    const t = submit ? await submit.text() : 'no response';
    return { ...base, success: false, error: `submit ${submit?.status}: ${t.substring(0, 200)}` };
  }
  const job = await submit.json();
  const requestId = job.request_id;
  if (!requestId) return { ...base, success: false, error: `no request_id in response: ${JSON.stringify(job).substring(0, 150)}` };
  console.log(`[IMAGE] submitted ${requestId} (${m.id})`);

  const deadline = Date.now() + pollSeconds * 1000;
  let status = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const { resp: poll } = await hfFetch(env, `/requests/${requestId}/status`);
    if (!poll || !poll.ok) continue;
    status = await poll.json();
    if (['completed', 'failed', 'nsfw', 'canceled'].includes(status.status)) break;
  }
  if (!status || status.status !== 'completed') {
    const st = status?.status || 'timeout';
    return { ...base, success: false, error: `generation ${st}`, nsfw: st === 'nsfw', requestId };
  }

  const url = status.images?.[0]?.url;
  if (!url) return { ...base, success: false, error: 'completed but no images[0].url', requestId };
  const imgResp = await fetch(url);
  if (!imgResp.ok) return { ...base, success: false, error: `image fetch ${imgResp.status}`, requestId };
  const buf = await imgResp.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    // stored chunked in D1 (saveImage) and fine to attach; just note it
    console.log(`[IMAGE] large image ${buf.byteLength}B (soft cap ${MAX_IMAGE_BYTES})`);
  }
  // encode in chunks — spreading a multi-MB Uint8Array into fromCharCode
  // overflows the call stack (crashed the first live generation, Oct 2026)
  const u8 = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  const bytesB64 = btoa(bin);
  const mime = imgResp.headers.get('content-type') || 'image/jpeg';

  await recordUsage(env.DB, { kind: 'image', model: m.usageModel, flatCost: m.cost })
    .catch(e => console.log(`[USAGE] image record failed: ${e.message}`));

  console.log(`[IMAGE] completed ${requestId} (${m.id}): ${buf.byteLength} bytes ${mime}`);
  return { ...base, success: true, requestId, mime, bytesB64, sourceUrl: url, cost: m.cost };
}

export { hfConfigured, PER_IMAGE_COST };

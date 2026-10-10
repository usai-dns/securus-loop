// Higgsfield image generation (GH#6) — Soul v2 standard, REST.
// Docs: api.higgsfield.ai · POST /higgsfield-ai/soul/v2/standard
//       Authorization: "Key {HF_API_KEY_ID}:{HF_API_KEY_SECRET}"
//       → { request_id, status_url } → GET /requests/{id}/status until
//       terminal (completed | failed | nsfw | canceled) → images[0].url
//
// Image bytes are stored in D1 (base64) for now — the Cloudflare API token
// lacks R2 permissions; swap storeImage() to R2 when the bucket exists.

import { recordUsage } from '../db/usage.mjs';

const HF_BASE = 'https://api.higgsfield.ai';
const MODEL_PATH = '/higgsfield-ai/soul/v2/standard';
const PER_IMAGE_COST = 0.05; // metered estimate; tune when billing data lands
const MAX_IMAGE_BYTES = 700 * 1024; // D1-friendly cap

function hfConfigured(env) {
  return !!(env.HF_API_KEY_ID && env.HF_API_KEY_SECRET);
}

function hfHeaders(env) {
  return {
    Authorization: `Key ${(env.HF_API_KEY_ID || '').trim()}:${(env.HF_API_KEY_SECRET || '').trim()}`,
    'Content-Type': 'application/json',
  };
}

// Submit + poll + download. Returns
//   { success, requestId, mime, bytesB64, sourceUrl } or { success:false, error, nsfw? }
export async function generateImage(env, { prompt, size = '1152x1152', pollSeconds = 110 }) {
  if (!hfConfigured(env)) {
    return { success: false, notConfigured: true, error: 'HF_API_KEY_ID / HF_API_KEY_SECRET not set' };
  }

  const submit = await fetch(`${HF_BASE}${MODEL_PATH}`, {
    method: 'POST',
    headers: { ...hfHeaders(env), 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ prompt, width_and_height: size }),
  });
  if (!submit.ok) {
    const t = await submit.text();
    return { success: false, error: `submit ${submit.status}: ${t.substring(0, 200)}` };
  }
  const job = await submit.json();
  const requestId = job.request_id;
  if (!requestId) return { success: false, error: `no request_id in response: ${JSON.stringify(job).substring(0, 150)}` };
  console.log(`[IMAGE] submitted ${requestId}`);

  const deadline = Date.now() + pollSeconds * 1000;
  let status = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await fetch(`${HF_BASE}/requests/${requestId}/status`, { headers: hfHeaders(env) });
    if (!poll.ok) continue;
    status = await poll.json();
    if (['completed', 'failed', 'nsfw', 'canceled'].includes(status.status)) break;
  }
  if (!status || status.status !== 'completed') {
    const st = status?.status || 'timeout';
    return { success: false, error: `generation ${st}`, nsfw: st === 'nsfw', requestId };
  }

  const url = status.images?.[0]?.url;
  if (!url) return { success: false, error: 'completed but no images[0].url', requestId };
  const imgResp = await fetch(url);
  if (!imgResp.ok) return { success: false, error: `image fetch ${imgResp.status}`, requestId };
  const buf = await imgResp.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    // keep it — Securus/attachment limits handled at send; D1 cap is the guard
    console.log(`[IMAGE] large image ${buf.byteLength}B (cap ${MAX_IMAGE_BYTES})`);
  }
  const bytesB64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  const mime = imgResp.headers.get('content-type') || 'image/jpeg';

  await recordUsage(env.DB, { kind: 'image', model: 'higgsfield-soul-v2', flatCost: PER_IMAGE_COST })
    .catch(e => console.log(`[USAGE] image record failed: ${e.message}`));

  console.log(`[IMAGE] completed ${requestId}: ${buf.byteLength} bytes ${mime}`);
  return { success: true, requestId, mime, bytesB64, sourceUrl: url };
}

export { hfConfigured, PER_IMAGE_COST };

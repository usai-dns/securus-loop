// mu-law codec and sample rate conversion for Twilio <-> Gemini bridge
// Twilio: G.711 mu-law, 8kHz, mono
// Gemini input: PCM 16-bit LE, 16kHz, mono
// Gemini output: PCM 16-bit LE, 24kHz, mono

const MULAW_BIAS = 0x84;
const MULAW_MAX = 0x7FFF;
const MULAW_CLIP = 32635;

// Pre-computed mu-law decode table (256 entries)
const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let mu = ~i & 0xFF;
  let sign = mu & 0x80;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  MULAW_DECODE[i] = sign ? -sample : sample;
}

export function mulawDecode(mulawBytes) {
  const pcm = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm[i] = MULAW_DECODE[mulawBytes[i]];
  }
  return pcm;
}

export function mulawEncode(pcmSamples) {
  const mulaw = new Uint8Array(pcmSamples.length);
  for (let i = 0; i < pcmSamples.length; i++) {
    let sample = pcmSamples[i];
    let sign = 0;
    if (sample < 0) {
      sign = 0x80;
      sample = -sample;
    }
    if (sample > MULAW_CLIP) sample = MULAW_CLIP;
    sample += MULAW_BIAS;

    let exponent = 7;
    let mask = 0x4000;
    while (exponent > 0 && !(sample & mask)) {
      exponent--;
      mask >>= 1;
    }

    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    mulaw[i] = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }
  return mulaw;
}

// Linear interpolation resample
function resample(input, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const outputLen = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLen);

  for (let i = 0; i < outputLen; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    if (srcIndex + 1 < input.length) {
      output[i] = Math.round(input[srcIndex] * (1 - frac) + input[srcIndex + 1] * frac);
    } else {
      output[i] = input[srcIndex] || 0;
    }
  }
  return output;
}

// Twilio mulaw/8kHz -> PCM 16kHz (for Gemini input)
export function twilioToGemini(mulawBase64) {
  const mulawBytes = base64ToBytes(mulawBase64);
  const pcm8k = mulawDecode(mulawBytes);
  const pcm16k = resample(pcm8k, 8000, 16000);
  return pcmToBase64(pcm16k);
}

// Gemini PCM/24kHz -> Twilio mulaw/8kHz
export function geminiToTwilio(pcmBase64) {
  const pcm24k = base64ToPcm(pcmBase64);
  const pcm8k = resample(pcm24k, 24000, 8000);
  const mulaw = mulawEncode(pcm8k);
  return bytesToBase64(mulaw);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64ToPcm(b64) {
  const bytes = base64ToBytes(b64);
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

function pcmToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return bytesToBase64(bytes);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

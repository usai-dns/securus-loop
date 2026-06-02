// securus-voice: Real-time voice call worker
// Bridges Twilio voice calls to Gemini Live API via Durable Objects
// Uses Deepgram for VAD/turn detection instead of Gemini's auto turn detection

export { VoiceSession } from './session.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Twilio webhook: incoming call
    if (url.pathname === '/incoming-call') {
      return handleIncomingCall(env);
    }

    // Twilio media stream WebSocket upgrade
    if (url.pathname === '/media-stream') {
      const sessionId = url.searchParams.get('session') || crypto.randomUUID();
      const id = env.VOICE_SESSION.idFromName(sessionId);
      const stub = env.VOICE_SESSION.get(id);
      return stub.fetch(request);
    }

    // Status/health check
    if (url.pathname === '/status') {
      return Response.json({
        service: 'securus-voice',
        status: 'ok',
        version: 'v1',
        timestamp: new Date().toISOString(),
      });
    }

    // Call log
    if (url.pathname === '/calls') {
      return handleCallLog(env);
    }

    return new Response('securus-voice worker', { status: 200 });
  },
};

function handleIncomingCall(env) {
  const pauseSeconds = env.COLLECT_CALL_PAUSE_SECONDS || '8';
  const host = env.WORKER_HOST || 'securus-voice.usai-dlh.workers.dev';
  const sessionId = crypto.randomUUID();

  // TwiML: wait for Securus IVR, press 1 to accept collect call, then connect media stream
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="${pauseSeconds}"/>
  <Play digits="wwww1"/>
  <Pause length="3"/>
  <Say voice="alice">Connected.</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream?session=${sessionId}">
      <Parameter name="sessionId" value="${sessionId}"/>
    </Stream>
  </Connect>
</Response>`;

  return new Response(twiml, {
    headers: { 'Content-Type': 'application/xml' },
  });
}

async function handleCallLog(env) {
  const results = await env.DB.prepare(`
    SELECT * FROM voice_calls ORDER BY started_at DESC LIMIT 20
  `).all().catch(() => ({ results: [] }));

  return Response.json({ calls: results.results || [] });
}

// VoiceSession Durable Object
// Manages dual WebSocket bridge: Twilio <-> Gemini Live API
// Uses Deepgram for VAD/turn detection

import { twilioToGemini, geminiToTwilio } from './audio.js';
import { buildSystemInstruction, loadRecentHistory, getConversationHistory, getTopicHistory } from './prompt.js';

const GEMINI_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

const TOOL_DECLARATIONS = [
  {
    name: 'getConversationHistory',
    description: 'Search the messaging history between Dennis and Sam for messages matching a query. Returns matching messages with dates and content.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term to find in message subjects and bodies',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'getTopicHistory',
    description: 'Get all messages for a specific writing project/topic tag (e.g. "starkiller", "scribe"). Returns the full conversation history for that topic.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The topic/project tag name (e.g. "starkiller", "scribe")',
        },
      },
      required: ['topic'],
    },
  },
];

export class VoiceSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.twilioWs = null;
    this.geminiWs = null;
    this.deepgramWs = null;
    this.streamSid = null;
    this.callSid = null;
    this.sessionId = null;
    this.audioBuffer = [];
    this.audioBufferBytes = 0;
    this.isSpeaking = false;
    this.callStarted = null;
    this.geminiReady = false;
    this.deepgramReady = false;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.state.acceptWebSocket(server);
    this.twilioWs = server;
    this.callStarted = new Date().toISOString();

    const url = new URL(request.url);
    this.sessionId = url.searchParams.get('session') || crypto.randomUUID();

    console.log(`VoiceSession: accepted Twilio WebSocket, session=${this.sessionId}`);

    // Connect to Gemini and Deepgram in parallel after WebSocket is established
    this.initGemini();
    this.initDeepgram();

    return new Response(null, { status: 101, webSocket: client });
  }

  async initGemini() {
    const apiKey = this.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('VoiceSession: GEMINI_API_KEY not set');
      return;
    }

    const model = this.env.GEMINI_MODEL || 'gemini-2.5-flash-live-preview';
    const wsUrl = `${GEMINI_WS_URL}?key=${apiKey}`;

    try {
      this.geminiWs = new WebSocket(wsUrl);

      this.geminiWs.addEventListener('open', async () => {
        console.log('VoiceSession: Gemini WebSocket connected');
        await this.sendGeminiSetup(model);
      });

      this.geminiWs.addEventListener('message', (event) => {
        this.handleGeminiMessage(event.data);
      });

      this.geminiWs.addEventListener('close', (event) => {
        console.log(`VoiceSession: Gemini WebSocket closed: ${event.code} ${event.reason}`);
        this.geminiReady = false;
      });

      this.geminiWs.addEventListener('error', (event) => {
        console.error('VoiceSession: Gemini WebSocket error');
      });
    } catch (err) {
      console.error(`VoiceSession: Failed to connect to Gemini: ${err.message}`);
    }
  }

  async sendGeminiSetup(model) {
    let conversationHistory = '';
    try {
      conversationHistory = await loadRecentHistory(this.env.DB);
    } catch (err) {
      console.error(`VoiceSession: Failed to load history: ${err.message}`);
    }

    const systemInstruction = buildSystemInstruction(conversationHistory);

    const setup = {
      setup: {
        model: `models/${model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Puck',
              },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        realtimeInputConfig: {
          // Manual turn detection — we control end_of_turn via Deepgram VAD
          automaticActivityDetection: {
            disabled: true,
          },
        },
        contextWindowCompression: {
          slidingWindow: {},
          triggerTokens: 100000,
        },
      },
    };

    this.geminiWs.send(JSON.stringify(setup));
    console.log(`VoiceSession: Sent Gemini setup (system instruction: ${systemInstruction.length} chars)`);
  }

  initDeepgram() {
    const apiKey = this.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      console.error('VoiceSession: DEEPGRAM_API_KEY not set');
      return;
    }

    const params = new URLSearchParams({
      model: 'nova-3',
      encoding: 'mulaw',
      sample_rate: '8000',
      channels: '1',
      endpointing: '300',
      utterance_end_ms: '1200',
      interim_results: 'true',
      vad_events: 'true',
      smart_format: 'true',
    });

    const wsUrl = `${DEEPGRAM_WS_URL}?${params}`;

    try {
      this.deepgramWs = new WebSocket(wsUrl, {
        headers: { Authorization: `Token ${apiKey}` },
      });

      this.deepgramWs.addEventListener('open', () => {
        console.log('VoiceSession: Deepgram WebSocket connected');
        this.deepgramReady = true;
      });

      this.deepgramWs.addEventListener('message', (event) => {
        this.handleDeepgramMessage(event.data);
      });

      this.deepgramWs.addEventListener('close', (event) => {
        console.log(`VoiceSession: Deepgram WebSocket closed: ${event.code}`);
        this.deepgramReady = false;
      });

      this.deepgramWs.addEventListener('error', () => {
        console.error('VoiceSession: Deepgram WebSocket error');
      });
    } catch (err) {
      console.error(`VoiceSession: Failed to connect to Deepgram: ${err.message}`);
    }
  }

  async webSocketMessage(ws, data) {
    try {
      const msg = typeof data === 'string' ? JSON.parse(data) : JSON.parse(new TextDecoder().decode(data));

      switch (msg.event) {
        case 'connected':
          console.log('VoiceSession: Twilio stream connected');
          break;

        case 'start':
          this.streamSid = msg.start.streamSid;
          this.callSid = msg.start.callSid;
          console.log(`VoiceSession: Stream started, streamSid=${this.streamSid}, callSid=${this.callSid}`);
          break;

        case 'media':
          this.handleTwilioAudio(msg.media.payload);
          break;

        case 'dtmf':
          console.log(`VoiceSession: DTMF digit=${msg.dtmf.digit}`);
          break;

        case 'stop':
          console.log('VoiceSession: Twilio stream stopped');
          this.cleanup();
          break;

        case 'mark':
          break;
      }
    } catch (err) {
      console.error(`VoiceSession: Error handling Twilio message: ${err.message}`);
    }
  }

  async webSocketClose(ws, code, reason) {
    console.log(`VoiceSession: Twilio WebSocket closed: ${code} ${reason}`);
    this.cleanup();
    await this.saveCallRecord();
  }

  handleTwilioAudio(mulawBase64) {
    // Forward raw mulaw to Deepgram for VAD/transcription
    if (this.deepgramReady && this.deepgramWs?.readyState === WebSocket.OPEN) {
      const binary = atob(mulawBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      this.deepgramWs.send(bytes.buffer);
    }

    // Transcode and buffer for Gemini
    if (this.geminiReady && this.geminiWs?.readyState === WebSocket.OPEN) {
      const pcm16kBase64 = twilioToGemini(mulawBase64);
      this.audioBuffer.push(pcm16kBase64);
      this.audioBufferBytes += pcm16kBase64.length;

      // Send to Gemini in chunks (~300ms of audio at 16kHz = ~9600 bytes PCM = ~12800 base64)
      if (this.audioBufferBytes >= 12800) {
        this.flushAudioToGemini(false);
      }
    }
  }

  flushAudioToGemini(endOfTurn) {
    if (!this.audioBuffer.length) return;

    // Concatenate buffered base64 chunks
    // Each chunk is already PCM 16kHz base64
    for (const chunk of this.audioBuffer) {
      const msg = {
        realtimeInput: {
          mediaChunks: [{
            mimeType: 'audio/pcm;rate=16000',
            data: chunk,
          }],
        },
      };
      this.geminiWs.send(JSON.stringify(msg));
    }

    this.audioBuffer = [];
    this.audioBufferBytes = 0;

    if (endOfTurn) {
      // Signal end of user's turn to Gemini
      this.geminiWs.send(JSON.stringify({
        clientContent: {
          turnComplete: true,
        },
      }));
      console.log('VoiceSession: Sent end_of_turn to Gemini');
    }
  }

  handleDeepgramMessage(data) {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'SpeechStarted') {
        if (!this.isSpeaking) {
          this.isSpeaking = true;
          console.log('VoiceSession: Speech started (Deepgram VAD)');
          // Interrupt Gemini if it's speaking — clear Twilio audio buffer
          this.sendTwilioClear();
        }
      }

      if (msg.type === 'Results') {
        if (msg.speech_final) {
          console.log(`VoiceSession: speech_final transcript: "${msg.channel?.alternatives?.[0]?.transcript || ''}"`);
          this.isSpeaking = false;
          // Flush remaining audio and signal end of turn
          this.flushAudioToGemini(true);
        }
      }

      if (msg.type === 'UtteranceEnd') {
        console.log('VoiceSession: UtteranceEnd from Deepgram');
        if (this.isSpeaking) {
          this.isSpeaking = false;
          this.flushAudioToGemini(true);
        }
      }
    } catch (err) {
      console.error(`VoiceSession: Error handling Deepgram message: ${err.message}`);
    }
  }

  handleGeminiMessage(data) {
    try {
      const msg = JSON.parse(data);

      if (msg.setupComplete) {
        console.log('VoiceSession: Gemini setup complete');
        this.geminiReady = true;
        // Send initial greeting prompt
        this.sendGeminiInitialPrompt();
        return;
      }

      if (msg.serverContent) {
        const content = msg.serverContent;

        if (content.modelTurn?.parts) {
          for (const part of content.modelTurn.parts) {
            if (part.inlineData?.data) {
              // Audio response from Gemini — transcode and send to Twilio
              const mulawBase64 = geminiToTwilio(part.inlineData.data);
              this.sendTwilioAudio(mulawBase64);
            }
          }
        }

        if (content.turnComplete) {
          console.log('VoiceSession: Gemini turn complete');
        }
      }

      if (msg.toolCall) {
        this.handleToolCall(msg.toolCall);
      }

      if (msg.goAway) {
        console.log(`VoiceSession: Gemini goAway, timeLeft=${msg.goAway.timeLeft}`);
      }
    } catch (err) {
      console.error(`VoiceSession: Error handling Gemini message: ${err.message}`);
    }
  }

  sendGeminiInitialPrompt() {
    this.geminiWs.send(JSON.stringify({
      clientContent: {
        turns: [{
          role: 'user',
          parts: [{ text: 'Sam just connected on the phone. Greet him warmly as Dennis. Keep it brief — just say hey and ask how he\'s doing.' }],
        }],
        turnComplete: true,
      },
    }));
    console.log('VoiceSession: Sent initial greeting prompt');
  }

  async handleToolCall(toolCall) {
    const responses = [];

    for (const fc of toolCall.functionCalls || []) {
      console.log(`VoiceSession: Tool call: ${fc.name}(${JSON.stringify(fc.args)})`);

      let result;
      try {
        if (fc.name === 'getConversationHistory') {
          result = await getConversationHistory(this.env.DB, fc.args.query);
        } else if (fc.name === 'getTopicHistory') {
          result = await getTopicHistory(this.env.DB, fc.args.topic);
        } else {
          result = `Unknown function: ${fc.name}`;
        }
      } catch (err) {
        result = `Error: ${err.message}`;
      }

      responses.push({
        id: fc.id,
        name: fc.name,
        response: { result },
      });
    }

    this.geminiWs.send(JSON.stringify({
      toolResponse: {
        functionResponses: responses,
      },
    }));
    console.log(`VoiceSession: Sent ${responses.length} tool response(s)`);
  }

  sendTwilioAudio(mulawBase64) {
    if (!this.streamSid || !this.twilioWs) return;

    try {
      this.twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: {
          payload: mulawBase64,
        },
      }));
    } catch (err) {
      console.error(`VoiceSession: Error sending to Twilio: ${err.message}`);
    }
  }

  sendTwilioClear() {
    if (!this.streamSid || !this.twilioWs) return;

    try {
      this.twilioWs.send(JSON.stringify({
        event: 'clear',
        streamSid: this.streamSid,
      }));
      console.log('VoiceSession: Sent clear to Twilio (barge-in)');
    } catch (err) {
      console.error(`VoiceSession: Error sending clear to Twilio: ${err.message}`);
    }
  }

  cleanup() {
    if (this.geminiWs?.readyState === WebSocket.OPEN) {
      this.geminiWs.close();
    }
    if (this.deepgramWs?.readyState === WebSocket.OPEN) {
      this.deepgramWs.close();
    }
    this.geminiReady = false;
    this.deepgramReady = false;
  }

  async saveCallRecord() {
    try {
      await this.env.DB.prepare(`
        INSERT INTO voice_calls (session_id, call_sid, started_at, ended_at)
        VALUES (?, ?, ?, datetime('now'))
      `).bind(this.sessionId, this.callSid, this.callStarted).run();
      console.log(`VoiceSession: Saved call record for session=${this.sessionId}`);
    } catch (err) {
      console.error(`VoiceSession: Failed to save call record: ${err.message}`);
    }
  }
}

// claude API response generation

import { buildSystemPrompt } from './prompt.mjs';

export async function generateResponse(env, inboundMessage, conversationHistory, knowledgeEntries) {
  if (!env.ANTHROPIC_API_KEY) {
    console.log('[AI] no ANTHROPIC_API_KEY, skipping response generation');
    return null;
  }

  const systemPrompt = buildSystemPrompt(conversationHistory, knowledgeEntries);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `from sam, received just now:\n\n${inboundMessage}`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.log(`[AI] API error: ${resp.status} ${errText}`);
    return null;
  }

  const data = await resp.json();
  const responseText = data.content?.[0]?.text || '';

  console.log(`[AI] generated response (${responseText.length} chars)`);
  return responseText;
}

export function shouldEscalate(messageBody) {
  if (!messageBody) return false;
  const lower = messageBody.toLowerCase();
  const triggers = ['emergency', 'urgent', 'crisis', 'help me', '911', 'dying', 'hospital'];
  return triggers.some(t => lower.includes(t));
}

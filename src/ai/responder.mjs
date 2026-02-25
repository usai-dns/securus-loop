// claude API response generation

import { buildSystemPrompt, CHAR_LIMIT } from './prompt.mjs';

export async function generateResponse(env, inboundMessage, conversationHistory, knowledgeEntries, subjectLength) {
  if (!env.ANTHROPIC_API_KEY) {
    console.log('[AI] no ANTHROPIC_API_KEY, skipping response generation');
    return null;
  }

  const systemPrompt = buildSystemPrompt(conversationHistory, knowledgeEntries, subjectLength);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
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
    throw new Error(`Claude API ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json();
  const responseText = data.content?.[0]?.text || '';

  console.log(`[AI] generated response (${responseText.length} chars)`);
  return responseText;
}

// split a response into parts that each fit within the securus char limit
// subject + body must be <= 20,000 chars per message
export function splitForSend(subject, body) {
  const maxBodyPerMessage = CHAR_LIMIT - subject.length - 20; // safety margin

  if (body.length <= maxBodyPerMessage) {
    return [{ subject, body }];
  }

  // split into multiple messages at paragraph boundaries
  const parts = [];
  let remaining = body;
  let partNum = 1;

  while (remaining.length > 0) {
    const isLast = remaining.length <= maxBodyPerMessage;
    const partSubject = partNum === 1 ? subject : `${subject} (pt ${partNum})`;
    const maxBody = CHAR_LIMIT - partSubject.length - 20;

    if (remaining.length <= maxBody) {
      parts.push({ subject: partSubject, body: remaining });
      break;
    }

    // find a good split point — paragraph break, sentence end, or word boundary
    let splitAt = maxBody;

    // try paragraph break first (double newline)
    const lastPara = remaining.lastIndexOf('\n\n', splitAt);
    if (lastPara > maxBody * 0.5) {
      splitAt = lastPara;
    } else {
      // try sentence end
      const lastSentence = remaining.lastIndexOf('. ', splitAt);
      if (lastSentence > maxBody * 0.5) {
        splitAt = lastSentence + 1;
      } else {
        // try word boundary
        const lastSpace = remaining.lastIndexOf(' ', splitAt);
        if (lastSpace > maxBody * 0.5) {
          splitAt = lastSpace;
        }
      }
    }

    parts.push({ subject: partSubject, body: remaining.substring(0, splitAt).trim() });
    remaining = remaining.substring(splitAt).trim();
    partNum++;
  }

  console.log(`[AI] split response into ${parts.length} parts: ${parts.map(p => p.body.length).join(', ')} chars`);
  return parts;
}

export function shouldEscalate(messageBody) {
  if (!messageBody) return false;
  const lower = messageBody.toLowerCase();
  const triggers = ['emergency', 'urgent', 'crisis', '911', 'dying', 'hospital'];
  return triggers.some(t => lower.includes(t));
}

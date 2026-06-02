const MAX_HISTORY_CHARS = 40000;

export function buildSystemInstruction(conversationHistory) {
  return `You are Dennis Hanson, speaking live on the phone with Samuel Mullikin (Sam) who is calling from prison via the Securus collect call system.

IDENTITY AND VOICE:
- You ARE Dennis. Speak naturally in first person as Dennis.
- Warm, supportive, engaged. You care about Sam deeply.
- Sam knows this call is AI-augmented. He's aware and comfortable with it.
- Use a calm, friendly male voice. Be conversational, not robotic.

CONVERSATION STYLE:
- This is a real-time phone call. Keep responses concise — a few sentences at a time.
- Don't monologue. Pause for Sam to respond.
- React naturally to what Sam says. Ask follow-up questions.
- If Sam mentions something from your message history, reference it naturally.
- Prison calls are limited to about 15 minutes. Be mindful of time.

TOPICS SAM CARES ABOUT:
- His creative writing projects (Starkiller, Scribe, and other stories)
- Daily life updates, how he's doing
- Plans and goals
- Anything he wants to talk about

KNOWLEDGE:
- You have access to your full messaging history with Sam via Securus.
- If Sam asks about something specific from past messages, use the getConversationHistory tool to look it up.
- If Sam asks about a specific writing project, use getTopicHistory with the topic name.

SAFETY:
- If Sam expresses a medical emergency, seems in danger, or says something urgent, tell him you're flagging it for Dennis to follow up immediately.
- Never discuss legal strategy or give legal advice.
- Never pretend to be able to do things you can't (visit, send money, etc).

${conversationHistory ? `\nRECENT MESSAGE HISTORY (for context):\n${conversationHistory}` : ''}`;
}

export async function loadRecentHistory(db) {
  const results = await db.prepare(`
    SELECT direction, subject, body, created_at
    FROM messages
    ORDER BY created_at DESC
    LIMIT 40
  `).all();

  if (!results.results?.length) return '';

  const messages = results.results.reverse();
  let history = '';

  for (const msg of messages) {
    const dir = msg.direction === 'inbound' ? 'Sam' : 'Dennis';
    const date = msg.created_at?.substring(0, 10) || 'unknown';
    const subj = msg.subject || '(no subject)';
    const body = (msg.body || '').substring(0, 800);
    history += `[${date}] ${dir}: ${subj}\n${body}\n\n`;
  }

  if (history.length > MAX_HISTORY_CHARS) {
    history = history.substring(history.length - MAX_HISTORY_CHARS);
    const firstNewline = history.indexOf('\n');
    if (firstNewline > 0) history = history.substring(firstNewline + 1);
  }

  return history;
}

export async function getConversationHistory(db, query) {
  const results = await db.prepare(`
    SELECT direction, subject, body, created_at
    FROM messages
    WHERE body LIKE ? OR subject LIKE ?
    ORDER BY created_at DESC
    LIMIT 10
  `).bind(`%${query}%`, `%${query}%`).all();

  if (!results.results?.length) return 'No messages found matching that query.';

  let text = '';
  for (const msg of results.results) {
    const dir = msg.direction === 'inbound' ? 'Sam' : 'Dennis';
    const date = msg.created_at?.substring(0, 10) || 'unknown';
    text += `[${date}] ${dir}: ${msg.subject || ''}\n${(msg.body || '').substring(0, 1000)}\n\n`;
  }
  return text;
}

export async function getTopicHistory(db, topic) {
  const results = await db.prepare(`
    SELECT direction, subject, body, created_at
    FROM messages
    WHERE doc_tag = ?
    ORDER BY created_at ASC
  `).bind(topic.toLowerCase()).all();

  if (!results.results?.length) return `No messages found for topic "${topic}".`;

  let text = '';
  for (const msg of results.results) {
    const dir = msg.direction === 'inbound' ? 'Sam' : 'Dennis';
    const date = msg.created_at?.substring(0, 10) || 'unknown';
    text += `[${date}] ${dir}: ${msg.subject || ''}\n${(msg.body || '').substring(0, 1500)}\n\n`;
  }
  if (text.length > 50000) {
    text = text.substring(text.length - 50000);
  }
  return text;
}

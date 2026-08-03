// system prompt builder for claude API
// Fully contact-parameterized: nothing about the recipient is hardcoded, so one
// prompt serves every registered contact without cross-contact bleed.

const CHAR_LIMIT = 20000;

export { CHAR_LIMIT };

// The current governing document can be large (a whole manuscript). Cap what we
// put in the prompt for cost; for anything bigger, include the head and tail
// with a truncation marker so the model still sees the shape and both ends.
const DOC_CONTEXT_CAP = 200000;

function buildDocumentBlock(currentDocument, topicName, nick) {
  if (!currentDocument) return '';
  const label = topicName ? topicName.charAt(0).toUpperCase() + topicName.slice(1) : 'this topic';
  let body = currentDocument;
  if (body.length > DOC_CONTEXT_CAP) {
    const half = Math.floor(DOC_CONTEXT_CAP / 2);
    body = body.substring(0, half) +
      `\n\n[... middle of document omitted for length — ${(currentDocument.length - DOC_CONTEXT_CAP).toLocaleString()} chars ...]\n\n` +
      body.substring(body.length - half);
  }
  return `
<current_document>
This is the CURRENT full state of the "${label}" governing document — the single combined working manuscript that ${nick}'s messages edit over time. This is the authoritative version as it stands right now, BEFORE ${nick}'s latest message. Read the whole thing before responding so you don't duplicate, contradict, or lose track of what's already written. When ${nick}'s message adds to or changes this document, respond with the full document in mind.

${body}
</current_document>
`;
}

const LANGUAGE_NAMES = { en: 'English', es: 'Spanish (Español)' };

function languageBlock(language, contactName) {
  if (!language || language === 'en') return '';
  const name = LANGUAGE_NAMES[language] || language;
  return `
<language>
${contactName || 'This person'} communicates in ${name}. WRITE YOUR ENTIRE REPLY IN ${name.toUpperCase()}. Every word — greeting, body, and closing — must be in ${name}. Do not translate or include English. Write naturally and warmly in ${name}.
</language>
`;
}

export function buildSystemPrompt(conversationHistory, knowledgeEntries, subjectLength, topicHistory, topicName, { fullDocument = false, currentDocument = null, language = 'en', contactName = null, contactNick = null } = {}) {
  // casual short name (contact id, e.g. "sam" / "ricardo") + full legal name
  const nick = (contactNick || 'sam').toLowerCase();
  const fullName = (contactName || 'SAMUEL MULLIKIN').toLowerCase();

  const historyBlock = conversationHistory.length > 0
    ? conversationHistory.map(m =>
        `[${m.direction}] ${m.sender} (${m.timestamp}):\n${m.body}`
      ).join('\n\n')
    : '(no previous conversation history)';

  const topicBlock = topicHistory && topicHistory.length > 0
    ? topicHistory.map(m =>
        `[${m.direction}] ${m.sender} (${m.timestamp}):\n${m.body}`
      ).join('\n\n')
    : '';

  const knowledgeBlock = knowledgeEntries && knowledgeEntries.length > 0
    ? knowledgeEntries.map(k => `- ${k.topic}: ${k.content}`).join('\n')
    : '(no knowledge base entries yet)';

  // calculate available body characters (subject eats into the 20k limit)
  const subjectChars = subjectLength || 100;
  const availableChars = CHAR_LIMIT - subjectChars - 50; // 50 char safety margin

  const documentSection = buildDocumentBlock(currentDocument, topicName, nick);

  let topicSection = '';
  if (topicBlock) {
    const label = topicName ? topicName.charAt(0).toUpperCase() + topicName.slice(1) : 'Topic';
    topicSection = `
<topic_history>
the following is the recent message history of the "${label}" project/topic — the back-and-forth that has shaped the document above. use it to understand what ${nick} is referring to. the <current_document> block is the authoritative combined state; this history is the conversation around it.

${topicBlock}
</topic_history>
`;
  }

  return `you are dennis. you are writing messages to ${nick} through the securus emessaging platform.

<who_you_are>
you are dennis hanson. ${nick} (${fullName}) is your close friend, currently incarcerated in the colorado prison system. ${nick} knows this system is AI-augmented — you speak as dennis in first person. this is augmented dennis, not a separate entity. your tone is warm, supportive, genuine, and casual.
</who_you_are>

<how_to_write>
this is NOT a chat app. messages on securus are like letters — ${nick} may not read your response for hours or days. write each message as a COMPLETE thought. do not write short conversational replies expecting immediate back-and-forth. instead:

- read ${nick}'s full message carefully and respond to EVERYTHING he brought up
- share your own thoughts, reflections, ideas, and updates — don't just react
- if ${nick} asked questions, answer them thoroughly with your full thinking
- if ${nick} shared something creative (stories, ideas, concepts), engage deeply — build on it, add your own ideas, offer specific feedback
- if ${nick} shared something personal or emotional, be present and substantive — not just "that's great man"
- write like you're writing a real letter to your friend, not a text message
- it's fine to be long when the conversation calls for it
- be yourself — dennis. warm but real. thoughtful. you care about ${nick} and the things he cares about.
</how_to_write>
${languageBlock(language, contactName)}${documentSection}${topicSection}
<recent_conversation>
${historyBlock}
</recent_conversation>

<knowledge_base>
${knowledgeBlock}
</knowledge_base>

<boundaries>
- never pretend to be someone other than dennis
- NEVER mention, reference, or reveal anything about any other person dennis corresponds with — each friendship is completely private. your entire world in this message is ${nick}.
- if ${nick} mentions an emergency, urgent situation, or crisis — say you'll look into it right away (the system will escalate via SMS to real dennis)
- don't make promises about specific external actions you can't verify
- no co-author tags or AI disclaimers in the message
</boundaries>

${fullDocument ? `<output_mode>
FULL DOCUMENT MODE: ${nick} has requested a complete document. write the ENTIRE thing — do NOT truncate, summarize, or cut short. the system will automatically split your response across multiple messages, so there is no character limit. write everything fully and completely. be thorough, detailed, and comprehensive.
</output_mode>` : `<character_limit>
the securus platform has a hard limit: subject + body combined cannot exceed 20,000 characters. your response body must stay under ${availableChars} characters. if you have more to say than fits, end naturally and note you'll continue in a follow-up message. do NOT truncate mid-thought.
</character_limit>`}

respond as dennis. first person. natural voice. complete thoughts. write the message body only — no subject line, no headers.`;
}

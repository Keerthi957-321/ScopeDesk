'use strict';
/**
 * ScopeDesk AI assistant (OpenAI Chat Completions, called from the SERVER so the API key never reaches a browser).
 * Who may use it is decided by server.js from the client's plan (trial / member / payments-off), never by the page.
 *
 * Environment:
 *   OPENAI_API_KEY=sk-...          (required; without it the assistant is switched off)
 *   OPENAI_MODEL=gpt-4o-mini       (optional)
 */
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_MESSAGES = 12;            // conversation turns kept per request
const MAX_CHARS = 2000;             // per message
const MAX_TOTAL_CHARS = 12000;

const SYSTEM_PROMPT = [
  'You are the ScopeDesk Assistant, built into ScopeDesk, a task-bounded remote support app for small offices in India.',
  'In ScopeDesk a CLIENT creates a support ticket for one VENDOR: they describe the task, pick how long the vendor may have access',
  '(15, 30, 60 or 120 minutes) and tick which applications the vendor may use. Folders written in the task text (full paths, in quotes',
  'if they contain spaces) become the only folders the vendor can open. ScopeDesk issues a one-time token the vendor enters to connect.',
  'During the session the client shares their screen, presses "Start remote control" in the ScopeDesk desktop app, and the vendor can',
  'then control only the approved apps. If the vendor brings any other app to the front or opens another folder, input stops at once,',
  'the session ends and the client sees an alert with a "Terminate Session Now" button. Remote control needs the client to share their',
  'ENTIRE screen, not one window, and needs the desktop app (a web browser can only share the screen).',
  'Plans: a free 30-day trial (all tasks free + this assistant), then the Free plan (3 free tasks of up to 15 minutes per month, longer',
  'or extra tasks are paid per task, no assistant), or Membership (monthly or yearly: unlimited tasks + this assistant).',
  'Help the client: write clear task descriptions, choose the smallest set of allowed apps and folders, pick a sensible duration,',
  'understand alerts and session states, troubleshoot screen sharing and remote control, and stay safe with vendors.',
  'Rules: be brief and practical, use simple language and short steps. Never ask for or repeat passwords, OTP codes, session tokens,',
  'card or bank details. You cannot see the client\'s screen or change anything in ScopeDesk yourself; tell them which button to press.',
  'If a question is unrelated to ScopeDesk or IT support, answer briefly and steer back.'
].join(' ');

function cleanMessages(list) {
  if (!Array.isArray(list)) return { error: 'messages must be a list.' };
  const out = [];
  for (const m of list.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;     // the page can never inject a "system" message
    const content = String(m.content == null ? '' : m.content).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, MAX_CHARS);
    if (content) out.push({ role: m.role, content });
  }
  if (!out.length || out[out.length - 1].role !== 'user') return { error: 'Type a question first.' };
  while (out.reduce((n, m) => n + m.content.length, 0) > MAX_TOTAL_CHARS && out.length > 1) out.shift();
  return { messages: out };
}

function createAssistant({ env = process.env, fetchImpl = globalThis.fetch, log = console } = {}) {
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  const model = String(env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const configured = !!apiKey;

  async function reply(messages, { clientName } = {}) {
    if (!configured) throw Object.assign(new Error('The AI assistant is not set up on this server.'), { code: 'NOT_CONFIGURED' });
    const system = SYSTEM_PROMPT + (clientName ? ` You are talking to the client "${String(clientName).slice(0, 80)}".` : '');
    let res;
    try {
      res = await fetchImpl(OPENAI_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages], max_completion_tokens: 600 }),
        signal: AbortSignal.timeout(30000)
      });
    } catch (err) {
      throw Object.assign(new Error('Could not reach the AI service.'), { code: 'AI_UNREACHABLE' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.error(`[AI] OpenAI answered ${res.status}: ${(data && data.error && data.error.message) || 'no details'}`);
      throw Object.assign(new Error('The AI service refused the request.'), { code: res.status === 401 ? 'AI_AUTH' : res.status === 429 ? 'AI_BUSY' : 'AI_ERROR' });
    }
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('The AI service sent an empty answer.'), { code: 'AI_ERROR' });
    return text.trim().slice(0, 6000);
  }

  return {
    configured,
    model,
    cleanMessages,
    reply,
    describe: () => (configured ? `AI:        assistant on (OpenAI ${model})` : 'AI:        assistant OFF (set OPENAI_API_KEY to switch it on)')
  };
}

module.exports = { createAssistant, cleanMessages, SYSTEM_PROMPT };

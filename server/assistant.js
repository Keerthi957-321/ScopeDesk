'use strict';
/**
 * ScopeDesk AI assistant, called from the SERVER so the API key never reaches a browser.
 * Who may use it is decided by server.js from the client's plan (trial / member / payments-off), never by the page.
 *
 * Environment (set ONE of the two keys; Gemini wins if both are set):
 *   GEMINI_API_KEY=AIza...         Google Gemini (free key, no card: aistudio.google.com > Get API key)
 *   GEMINI_MODEL=gemini-2.5-flash  (optional)
 *   OPENAI_API_KEY=sk-...          OpenAI (needs billing credit)
 *   OPENAI_MODEL=gpt-4o-mini       (optional)
 * Both use the same "chat completions" request format (Gemini offers an OpenAI-compatible endpoint).
 */
const PROVIDERS = {
  gemini: { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', defaultModel: 'gemini-2.5-flash', tokenField: 'max_tokens' },
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', defaultModel: 'gpt-4o-mini', tokenField: 'max_completion_tokens' }
};
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
  const geminiKey = String(env.GEMINI_API_KEY || '').trim();
  const openaiKey = String(env.OPENAI_API_KEY || '').trim();
  const providerKey = geminiKey ? 'gemini' : openaiKey ? 'openai' : null;
  const provider = providerKey ? PROVIDERS[providerKey] : null;
  const apiKey = geminiKey || openaiKey;
  const model = provider ? String((providerKey === 'gemini' ? env.GEMINI_MODEL : env.OPENAI_MODEL) || provider.defaultModel).trim() : '';
  const configured = !!provider;

  async function reply(messages, { clientName } = {}) {
    if (!configured) throw Object.assign(new Error('The AI assistant is not set up on this server.'), { code: 'NOT_CONFIGURED' });
    const system = SYSTEM_PROMPT + (clientName ? ` You are talking to the client "${String(clientName).slice(0, 80)}".` : '');
    let res;
    try {
      res = await fetchImpl(provider.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages], [provider.tokenField]: 600 }),
        signal: AbortSignal.timeout(30000)
      });
    } catch (err) {
      throw Object.assign(new Error('Could not reach the AI service.'), { code: 'AI_UNREACHABLE' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = Array.isArray(data) ? data[0] : data;   // Gemini sometimes wraps the error in a list
      log.error(`[AI] ${provider.name} answered ${res.status}: ${(detail && detail.error && detail.error.message) || 'no details'}`);
      const msg = String((detail && detail.error && detail.error.message) || '');
      // 401/403, or Gemini's 400 "API key not valid": the key is wrong. 404: the model name does not exist for this key.
      const code = res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(msg)) ? 'AI_AUTH'
        : res.status === 429 ? (/quota|billing|credit/i.test(msg) ? 'AI_QUOTA' : 'AI_BUSY')
        : res.status === 404 ? 'AI_MODEL'
        : 'AI_ERROR';
      throw Object.assign(new Error('The AI service refused the request.'), { code });
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
    provider: providerKey,
    describe: () => (configured ? `AI:        assistant on (${provider.name} ${model})` : 'AI:        assistant OFF (set GEMINI_API_KEY or OPENAI_API_KEY to switch it on)')
  };
}

module.exports = { createAssistant, cleanMessages, SYSTEM_PROMPT };

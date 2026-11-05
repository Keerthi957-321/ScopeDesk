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
  const pinned = provider ? String((providerKey === 'gemini' ? env.GEMINI_MODEL : env.OPENAI_MODEL) || '').trim() : '';
  let model = provider ? (pinned || provider.defaultModel) : '';
  let discovered = false;               // looked up the key's model list already (once per server start)
  const configured = !!provider;
  const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  function failure(status, data) {
    const detail = Array.isArray(data) ? data[0] : data;   // Gemini sometimes wraps the error in a list
    const msg = String((detail && detail.error && detail.error.message) || '');
    log.error(`[AI] ${provider.name} answered ${status} for model "${model}": ${msg || 'no details'}`);
    // 401/403, or Gemini's 400 "API key not valid": the key is wrong. 404: the model name does not exist for this key.
    const code = status === 401 || status === 403 || (status === 400 && /api key/i.test(msg)) ? 'AI_AUTH'
      : status === 429 ? (/quota|billing|credit/i.test(msg) ? 'AI_QUOTA' : 'AI_BUSY')
      : status === 404 || (status === 400 && /model/i.test(msg) && /not (found|supported)|unknown|invalid/i.test(msg)) ? 'AI_MODEL'
      : 'AI_ERROR';
    return Object.assign(new Error('The AI service refused the request.'), { code });
  }

  async function callOnce(messages) {
    let res;
    try {
      res = await fetchImpl(provider.url, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ model, messages, [provider.tokenField]: 800 }),
        signal: AbortSignal.timeout(30000)
      });
    } catch (err) {
      throw Object.assign(new Error('Could not reach the AI service.'), { code: 'AI_UNREACHABLE' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw failure(res.status, data);
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('The AI service sent an empty answer.'), { code: 'AI_ERROR' });
    return text.trim().slice(0, 6000);
  }

  // Model names change often. When the configured one is refused, ask the provider which chat models THIS key can use and pick
  // the best: a current "flash" model for Gemini (fast, on the free tier), a "mini" model for OpenAI. Stable before preview,
  // newer version first. Text-chat models only (no image, audio, embedding or live models).
  const NOT_CHAT = /embed|tts|image|imagen|veo|lyria|audio|live|transcri|speech|vision|aqa|robotics|computer|search|moderation|whisper|dall|realtime|instruct|codex|learnlm|gemma/i;
  function versionOf(id) { const m = /(\d+(?:\.\d+)?)/.exec(id); return m ? Number(m[1]) : 0; }
  function scoreModel(id) {
    let s = versionOf(id) * 10;
    if (providerKey === 'gemini') {
      if (/flash/.test(id) && !/lite/.test(id)) s += 1000;
      else if (/flash-lite/.test(id)) s += 800;
      else if (/pro/.test(id)) s += 100;     // pro models are often not on the free tier
    } else {
      if (/mini/.test(id)) s += 1000;
      if (/nano/.test(id)) s += 600;
    }
    if (/preview|exp|beta|alpha/.test(id)) s -= 300;
    if (/\d{3,}|latest/.test(id.replace(/\d+\.\d+/, ''))) s -= 5;   // dated snapshots after the plain name
    return s;
  }
  function pickModel(ids) {
    const chat = [...new Set(ids.map((x) => String(x || '').replace(/^models\//, '')).filter(Boolean))]
      .filter((id) => !NOT_CHAT.test(id) && (providerKey !== 'gemini' || /^gemini/.test(id)) && (providerKey !== 'openai' || /^(gpt|o\d)/.test(id)));
    chat.sort((a, b) => scoreModel(b) - scoreModel(a) || a.localeCompare(b));
    return { best: chat[0] || null, all: chat };
  }
  async function listModels() {
    const urls = providerKey === 'gemini'
      ? [['https://generativelanguage.googleapis.com/v1beta/openai/models', auth],
         [`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`, {}]]
      : [['https://api.openai.com/v1/models', auth]];
    for (const [url, headers] of urls) {
      try {
        const res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const data = await res.json().catch(() => ({}));
        const rows = Array.isArray(data.data) ? data.data.map((m) => m.id)
          : Array.isArray(data.models) ? data.models.filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map((m) => m.name)
          : [];
        if (rows.length) return rows;
      } catch (_) { /* try the next way of listing */ }
    }
    return [];
  }

  async function reply(messages, { clientName } = {}) {
    if (!configured) throw Object.assign(new Error('The AI assistant is not set up on this server.'), { code: 'NOT_CONFIGURED' });
    const system = SYSTEM_PROMPT + (clientName ? ` You are talking to the client "${String(clientName).slice(0, 80)}".` : '');
    const full = [{ role: 'system', content: system }, ...messages];
    try {
      return await callOnce(full);
    } catch (err) {
      if (err.code !== 'AI_MODEL' || discovered) throw err;
      discovered = true;
      const { best, all } = pickModel(await listModels());
      log.warn(`[AI] Model "${model}" is not available for this key. Models this key can use: ${all.slice(0, 15).join(', ') || '(none listed)'}`);
      if (!best || best === model) throw err;
      log.warn(`[AI] Switching to "${best}". Set ${providerKey === 'gemini' ? 'GEMINI_MODEL' : 'OPENAI_MODEL'}=${best} to make this permanent.`);
      model = best;
      return callOnce(full);
    }
  }

  return {
    configured,
    get model() { return model; },
    pickModel,
    cleanMessages,
    reply,
    provider: providerKey,
    describe: () => (configured ? `AI:        assistant on (${provider.name} ${model})` : 'AI:        assistant OFF (set GEMINI_API_KEY or OPENAI_API_KEY to switch it on)')
  };
}

module.exports = { createAssistant, cleanMessages, SYSTEM_PROMPT };

// ScopeDesk plans + AI assistant (browser side). Display and requests only: the SERVER decides the plan, the price and who may chat.
//   Clients get the assistant by plan (trial / member); vendors always get it (no plan card for them).
//   ScopeDeskPlans.init({ api, toast, loadRazorpay })   once, from script.js (shares its API helper and Razorpay loader)
//   ScopeDeskPlans.start()                              after a CLIENT signs in: shows the plan card + assistant button
//   ScopeDeskPlans.stop()                               on sign-out: hides everything, forgets the conversation
//   ScopeDeskPlans.refresh()                            re-reads the plan (after a task or a payment)
(function () {
  const $ = (id) => document.getElementById(id);
  let deps = null;
  let status = null;
  let running = false;
  let history = [];          // the conversation, in memory only (never stored in the browser)
  let sending = false;
  const listeners = [];          // workspace.js: top-bar plan badge + Settings & Billing page
  const notify = () => listeners.forEach((fn) => { try { fn(status); } catch (_) { /* a listener must not break plans */ } });

  const PLAN_NAME = { trial: 'Free trial', free: 'Free', member: 'Member', legacy: 'All features' };
  const inr = (v) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const dateText = (ms) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const daysLeft = (ms) => Math.max(0, Math.ceil((ms - Date.now()) / 86400000));

  // ---------- plan card + dialog ----------
  function render() {
    if (role === 'vendor') { $('planCard').classList.add('hidden'); renderChatAccess(); return; }
    notify();
    if (!status) return;
    const s = status;
    $('planCard').classList.toggle('hidden', !running);
    $('planBadge').textContent = PLAN_NAME[s.plan] || s.plan;
    $('planBadge').className = `plan-badge plan-${s.plan}`;
    let detail = '';
    if (s.plan === 'trial') detail = `Free tasks + AI assistant for ${daysLeft(s.trialEndsAt)} more day${daysLeft(s.trialEndsAt) === 1 ? '' : 's'} (until ${dateText(s.trialEndsAt)}).`;
    else if (s.plan === 'member') detail = `Unlimited tasks + AI assistant until ${dateText(s.memberUntil)}.`;
    else if (s.plan === 'free') detail = `${s.freeLeft} of ${s.freeLimit} free tasks left this month. No AI assistant.`;
    else detail = 'Payments are off on this server: every task and feature is free.';
    $('planDetail').textContent = detail;
    $('btnUpgrade').classList.toggle('hidden', !s.paymentsEnabled);
    $('btnUpgrade').textContent = s.plan === 'member' ? 'Renew membership' : s.plan === 'trial' ? 'See plans' : 'Upgrade';

    $('planModalNow').textContent = `You are on: ${PLAN_NAME[s.plan] || s.plan}. ${detail}`;
    $('planFreeTasks').textContent = `${s.freeLimit} free tasks a month (up to ${s.freeMaxMinutes} min each)`;
    $('planTrialNote').textContent = `New accounts get a ${s.trialDays}-day free trial with free tasks and the AI assistant. After it ends you move to Free unless you choose Membership.`;
    const box = $('planBuyButtons');
    box.replaceChildren();
    (s.memberships || []).forEach((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-primary plan-buy-btn';
      b.dataset.plan = m.plan;
      const per = m.plan === 'yearly' ? 'year' : 'month';
      b.textContent = `Pay ₹${inr(m.priceInr)} / ${per}`;
      if (m.plan === 'yearly' && s.memberships.find((x) => x.plan === 'monthly')) {
        const monthly = s.memberships.find((x) => x.plan === 'monthly').priceInr;
        const save = Math.round(monthly * 12 - m.priceInr);
        if (save > 0) { const tag = document.createElement('span'); tag.className = 'plan-save'; tag.textContent = `save ₹${inr(save)}`; b.append(' ', tag); }
      }
      b.addEventListener('click', () => buy(m.plan));
      box.appendChild(b);
    });
    renderChatAccess();
  }

  async function refresh() {
    if (!running || !deps) return null;
    try {
      // vendors have no plan: only "may I chat" (always yes) and "is the AI switched on"
      status = await deps.api(role === 'vendor' ? '/api/chat/status' : '/api/billing/status');
      render();
    } catch (_) { /* card keeps its last state */ }
    return status;
  }

  function openPlans() { refresh(); $('planModal').classList.add('open'); }
  function closePlans() { $('planModal').classList.remove('open'); }

  async function buy(plan) {
    if (!deps) return;
    const all = [...document.querySelectorAll('.plan-buy-btn, .tier-buy')];
    all.forEach((b) => { b.disabled = true; });
    try {
      const res = await deps.api('/api/membership/checkout', { method: 'POST', body: { plan } });
      const Razorpay = await deps.loadRazorpay();
      await new Promise((resolve) => {
        let finished = false;
        const rzp = new Razorpay({
          key: res.payment.keyId, order_id: res.payment.orderId, amount: res.payment.amount, currency: res.payment.currency,
          name: res.payment.name, description: res.payment.description, prefill: res.payment.prefill || {}, theme: { color: '#008767' },
          handler: async (r) => {
            finished = true;
            try {
              await deps.api('/api/payments/verify', { method: 'POST', body: { razorpay_order_id: r.razorpay_order_id, razorpay_payment_id: r.razorpay_payment_id, razorpay_signature: r.razorpay_signature } });
              deps.toast('Payment received. Membership is active: unlimited tasks and the AI assistant are on.');
              closePlans();
            } catch (err) { deps.toast(err.message, true); }
            await refresh();
            resolve();
          },
          modal: { ondismiss: () => { if (!finished) { deps.toast('Payment window closed. Nothing was charged.'); resolve(); } }, confirm_close: true }
        });
        rzp.on('payment.failed', (r) => deps.toast(`${(r && r.error && r.error.description) || 'The payment failed.'} You can try again.`, true));
        rzp.open();
      });
    } catch (err) {
      deps.toast(err.message, true);
    } finally {
      all.forEach((b) => { b.disabled = false; });
    }
  }

  // ---------- AI assistant ----------
  // Fast by design: your question shows at once, "thinking" dots appear in the same frame, and the answer streams in word by
  // word (server-sent events) with a smooth typing reveal. Old servers without streaming fall back to one answer at once.
  const GREETING = {
    client: 'Hi! I am your ScopeDesk Assistant. I can help you write a clear task, choose which apps to allow, fix screen sharing or remote control, and explain alerts. What do you need?',
    vendor: 'Hi! I am your ScopeDesk Assistant. Pick a ticket above and I can draft a reply to the client, summarise the task, plan the fix inside the allowed apps, or write your end-of-session summary.'
  };
  // one-click actions. `draft: true` answers are messages for the other person: they get a "Use in Messages" button
  const QUICK = {
    client: [
      { label: 'Write a task description for me', prompt: 'Write a clear task description for a vendor for my problem. Ask me one question first if you need details.' },
      { label: 'Which apps should I allow?', prompt: 'Which apps should I allow for this task? Keep the list as small as possible.' },
      { label: 'Why is remote control not working?', prompt: 'Why is remote control not working? Give me the checks in order.' },
      { label: 'Draft a message to my vendor', prompt: 'Draft a short, friendly message to my vendor about this ticket. Reply with only the message text.', draft: true, needsTask: true },
      { label: 'Summarise this ticket', prompt: 'Summarise this ticket in 3 short bullet points: the problem, what has happened so far, what is next.', needsTask: true }
    ],
    vendor: [
      { label: '✎ Draft a reply to my client', prompt: 'Draft a short, polite reply to the client\'s latest message about this ticket. If there is no message yet, write a short hello saying I am ready to start. Reply with only the message text.', draft: true, needsTask: true },
      { label: '≡ Summarise this task', prompt: 'Summarise this task in 3 short bullet points: what the client needs, what I am allowed to use, how much time is left.', needsTask: true },
      { label: '✓ Write my session summary', prompt: 'Write a short end-of-session summary for the client: what I did, what they should check, and any next step. Use 3 to 5 bullet points. Reply with only the summary.', draft: true, needsTask: true },
      { label: '⚒ Plan the fix', prompt: 'Give me a short step-by-step plan to do this task using only the allowed apps and folders.', needsTask: true },
      { label: '? Ask the client for details', prompt: 'Draft a short message asking the client for the details I need to fix this (error text, a screenshot, when it started). Reply with only the message text.', draft: true, needsTask: true },
      { label: 'Remote control is not working', prompt: 'Remote control is not working for me. What should I and the client check, in order?' }
    ]
  };
  let lastQuestion = null;          // { text, prompt, draft }
  let role = 'client';
  let contextTask = null;           // ticket id the answers are about (null = none)
  let contextPicked = false;        // the user chose one: do not auto-switch any more
  let abort = null;                 // AbortController of the answer being streamed
  const canChat = () => !!(status && status.chatbot && status.chatbotConfigured);

  function renderChatAccess() {
    const s = status;
    $('chatLauncher').classList.toggle('hidden', !running);
    if (!s) return;
    const locked = !s.chatbot;
    const offline = s.chatbot && !s.chatbotConfigured;
    $('chatLocked').classList.toggle('hidden', !(locked || offline));
    $('chatForm').classList.toggle('hidden', locked || offline);
    $('btnChatUpgrade').classList.toggle('hidden', !locked || !s.paymentsEnabled || role !== 'client');
    $('chatLockedText').textContent = offline
      ? 'The AI assistant is not switched on for this server yet. The administrator needs to add GEMINI_API_KEY (free) or OPENAI_API_KEY in the server settings.'
      : (s.plan === 'free'
        ? 'Your free trial has ended. The AI assistant is part of Membership, together with unlimited tasks.'
        : 'The AI assistant is part of Membership.');
    $('chatPlanLine').textContent = role === 'vendor' ? 'Vendor assistant · fast answers'
      : s.plan === 'trial' ? `Free trial · ${daysLeft(s.trialEndsAt)} days left` : s.plan === 'member' ? 'Included in your membership' : s.plan === 'legacy' ? 'Online' : 'Members only';
    $('chatInput').placeholder = role === 'vendor' ? 'Ask anything, or pick a quick action...' : 'Ask about tasks, apps, alerts...';
    renderContext();
    renderSuggestions();
  }

  // ----- ticket context (what "this ticket" means for the quick actions) -----
  function myTasks() { try { return (deps.getTasks && deps.getTasks()) || []; } catch (_) { return []; } }
  function defaultTask(list) {
    return (list.find((t) => t.status === 'active') || list.find((t) => t.status === 'pending') || list[0] || {}).id ?? null;
  }
  function renderContext() {
    const box = $('chatContext'), sel = $('chatContextSel');
    const list = myTasks().slice(0, 25);
    box.classList.toggle('hidden', !list.length || !canChat());
    if (!list.length) { contextTask = null; return; }
    if (!contextPicked || !list.some((t) => t.id === contextTask)) contextTask = defaultTask(list);
    const label = (t) => `${t.status === 'active' ? '● ' : t.status === 'pending' ? '○ ' : ''}${String(t.title).slice(0, 42)}${String(t.title).length > 42 ? '...' : ''}`;
    const sig = list.map((t) => `${t.id}:${t.status}:${t.title}`).join('|') + `#${contextTask}`;
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    sel.replaceChildren(new Option('No ticket', ''), ...list.map((t) => new Option(label(t), String(t.id), false, t.id === contextTask)));
    sel.value = contextTask == null ? '' : String(contextTask);
  }

  // Quick actions: always one click away for vendors; for clients before the first question (then they type)
  function renderSuggestions() {
    const box = $('chatSuggestions');
    const ok = canChat() && !$('chatForm').classList.contains('hidden');
    const show = ok && (role === 'vendor' || history.length === 0);
    box.replaceChildren();
    box.classList.toggle('hidden', !show);
    box.classList.toggle('chat-quick', role === 'vendor');
    if (!show) return;
    QUICK[role].filter((q) => !q.needsTask || contextTask != null || role === 'vendor').forEach((q) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chat-chip';
      b.textContent = q.label;
      b.disabled = sending;
      if (q.needsTask && contextTask == null) { b.disabled = true; b.title = 'Pick a ticket above first'; }
      b.addEventListener('click', () => ask(q.label.replace(/^[^A-Za-z]+/, ''), { prompt: q.prompt, draft: q.draft }));
      box.appendChild(b);
    });
  }

  // Light formatting for answers: paragraphs, "- " / "1. " lists and **bold**. Built from text nodes only, so nothing in an
  // answer can ever run as HTML.
  function inline(parent, text) {
    String(text).split(/(\*\*[^*]+\*\*)/g).forEach((part) => {
      if (!part) return;
      if (/^\*\*[^*]+\*\*$/.test(part)) { const b = document.createElement('strong'); b.textContent = part.slice(2, -2); parent.appendChild(b); }
      else parent.appendChild(document.createTextNode(part.replace(/`([^`]+)`/g, '$1')));
    });
  }
  function formatAnswer(el, text) {
    let list = null;
    String(text).replace(/\r/g, '').split('\n').forEach((raw) => {
      const line = raw.trim();
      const bullet = /^[-*•]\s+(.*)$/.exec(line);
      const number = /^(\d+)[.)]\s+(.*)$/.exec(line);
      if (bullet || number) {
        const want = number ? 'OL' : 'UL';
        if (!list || list.tagName !== want) { list = document.createElement(want.toLowerCase()); el.appendChild(list); }
        const li = document.createElement('li');
        inline(li, bullet ? bullet[1] : number[2]);
        list.appendChild(li);
        return;
      }
      list = null;
      if (!line) return;
      const p = document.createElement('p');
      inline(p, line.replace(/^#+\s*/, ''));
      el.appendChild(p);
    });
  }

  let stick = true;                 // follow the answer while it streams, unless the user scrolled up to read
  function scrollDown(force) { const log = $('chatLog'); if (force || stick) log.scrollTop = log.scrollHeight; }

  function tools(row, text, { draft = false, taskId = null, ms = null } = {}) {
    const bar = document.createElement('div');
    bar.className = 'chat-tools';
    const mini = (label, fn, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = `chat-mini ${cls}`; b.textContent = label; b.addEventListener('click', () => fn(b)); bar.appendChild(b); return b; };
    mini('Copy', async (b) => {
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); }
      catch (_) { b.textContent = 'Could not copy'; }
    });
    if (draft && taskId != null && window.ScopeDeskMessages && ScopeDeskMessages.prefill) {
      mini('Use in Messages →', () => { openChat(false); ScopeDeskMessages.prefill(taskId, text.replace(/^["“]|["”]$/g, '').trim()); }, 'chat-mini-accent');
    }
    if (ms != null) { const t = document.createElement('span'); t.className = 'chat-speed'; t.textContent = `${(ms / 1000).toFixed(1)}s`; t.title = 'Time to the full answer'; bar.appendChild(t); }
    row.appendChild(bar);
  }

  function addBubble(roleName, text, { retry = false } = {}) {
    const row = document.createElement('div');
    row.className = `chat-row chat-row-${roleName}`;
    const el = document.createElement('div');
    el.className = `chat-msg chat-${roleName}`;
    if (roleName === 'assistant') formatAnswer(el, text); else el.textContent = text;
    row.appendChild(el);
    if (retry) {
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'chat-mini chat-retry';
      again.textContent = 'Try again';
      again.addEventListener('click', () => { row.remove(); if (lastQuestion) ask(lastQuestion.text, lastQuestion); });
      row.appendChild(again);
    }
    $('chatLog').appendChild(row);
    scrollDown(true);
    return row;
  }

  // "Copy details": what the server knows about the assistant (provider, model, last error code and cause), for support
  function addDetails(row, err) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chat-mini'; b.textContent = 'Copy details';
    b.addEventListener('click', async () => {
      let st = {};
      try { st = await deps.api('/api/chat/status'); } catch (e) { st = { statusError: e.message }; }
      const text = ['ScopeDesk assistant details', `Build: ${window.SCOPEDESK_BUILD || '-'}`, `Shown: ${err.message}`, `Code: ${err.code || err.status || '-'}`,
        `Role: ${st.role || '-'}; plan: ${st.plan || '-'}; allowed: ${st.chatbot}; switched on: ${st.chatbotConfigured}`,
        `Provider: ${(st.ai && st.ai.provider) || '-'}; model: ${(st.ai && st.ai.model) || '-'}`,
        `Last error: ${st.ai && st.ai.lastError ? `${st.ai.lastError.code} ${st.ai.lastError.cause || ''} (${st.ai.lastError.model}, ${st.ai.lastError.at})` : 'none'}`,
        `Last answer OK: ${(st.ai && st.ai.lastOkAt) || 'never since the server started'}`].join('\n');
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch (_) { b.textContent = 'Could not copy'; }
    });
    row.appendChild(b);
  }

  function addTyping() {
    const row = document.createElement('div');
    row.className = 'chat-row chat-row-assistant';
    const el = document.createElement('div');
    el.className = 'chat-msg chat-assistant chat-typing';
    el.setAttribute('aria-label', 'The assistant is typing');
    for (let i = 0; i < 3; i += 1) el.appendChild(document.createElement('span'));
    row.appendChild(el);
    $('chatLog').appendChild(row);
    scrollDown(true);
    return row;
  }

  // Smooth reveal: text arrives in bursts from the network; this shows it at a steady, quick pace (faster when more is
  // waiting), one animation frame at a time, so it never stutters and never falls behind.
  function typer(el) {
    let target = '', shown = 0, raf = 0, finished = false, onIdle = null;
    const caret = document.createElement('span'); caret.className = 'chat-caret'; caret.setAttribute('aria-hidden', 'true');
    const paint = () => {
      el.replaceChildren(); formatAnswer(el, target.slice(0, shown));
      if (!finished || shown < target.length) { const last = el.lastElementChild; const host = last ? (last.tagName === 'P' ? last : last.lastElementChild || last) : el; host.appendChild(caret); }
      scrollDown();
    };
    const frame = () => {
      raf = 0;
      const backlog = target.length - shown;
      if (backlog > 0) { shown += Math.max(3, Math.ceil(backlog / 5)); if (shown > target.length) shown = target.length; paint(); }
      if (shown < target.length) raf = requestAnimationFrame(frame);
      else if (finished) { paint(); if (onIdle) onIdle(); }
    };
    const kick = () => { if (document.hidden) { shown = target.length; paint(); if (finished && onIdle) onIdle(); return; } if (!raf) raf = requestAnimationFrame(frame); };
    return {
      push(t) { target += t; kick(); },
      set(t) { target = t; if (shown > target.length) shown = target.length; kick(); },
      finish() { finished = true; return new Promise((res) => { onIdle = res; kick(); if (shown >= target.length && !raf) { paint(); res(); } }); },
      text: () => target
    };
  }

  function resetChat() {
    if (abort) abort.abort();
    history = [];
    lastQuestion = null;
    $('chatLog').replaceChildren();
    addBubble('assistant', GREETING[role]);
    renderSuggestions();
  }

  function growInput() {
    const t = $('chatInput');
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
  }

  function openChat(open) {
    $('chatPanel').classList.toggle('hidden', !open);
    $('chatLauncher').setAttribute('aria-expanded', String(open));
    $('chatLauncher').classList.toggle('is-open', open);
    if (open) {
      if (!$('chatLog').children.length) resetChat();
      renderContext(); renderSuggestions();
      refresh();
      setTimeout(() => { if (!$('chatForm').classList.contains('hidden')) $('chatInput').focus(); }, 0);
    }
  }

  function setSending(on) {
    sending = on;
    const btn = $('btnChatSend');
    btn.classList.toggle('is-stop', on);
    btn.setAttribute('aria-label', on ? 'Stop the answer' : 'Send');
    btn.title = on ? 'Stop' : 'Send';
    btn.innerHTML = on ? '&#9632;' : '&#10148;';
    $('chatSuggestions').querySelectorAll('button').forEach((b) => { if (on) b.disabled = true; });
    if (!on) renderSuggestions();
  }

  // Streams one answer for `messages` into onText(fullSoFar). Falls back to the one-shot route on an older server.
  async function fetchAnswer(messages, taskId, onDelta, signal) {
    const body = { messages, taskId: taskId == null ? undefined : taskId };
    if (deps.streamApi) {
      let got = false, final = null, failure = null;
      try {
        await deps.streamApi('/api/chat/stream', body, (ev, d) => {
          if (ev === 'delta' && d.t) { got = true; onDelta(d.t); }
          else if (ev === 'done') final = d.reply;
          else if (ev === 'error') failure = Object.assign(new Error(d.error || 'The AI assistant could not answer.'), { code: d.code });
        }, signal);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (!(err.notStreaming || (err.network && !got))) throw err;    // plan / rate limit / input errors are real answers
        const res = await deps.api('/api/chat', { method: 'POST', body });
        onDelta(res.reply); return res.reply;
      }
      if (failure) throw failure;
      if (final == null && !got) throw new Error('The AI assistant could not answer right now. Please try again.');
      return final;
    }
    const res = await deps.api('/api/chat', { method: 'POST', body });
    onDelta(res.reply); return res.reply;
  }

  async function ask(text, { prompt, draft = false } = {}) {
    if (sending || !deps || !text) return;
    lastQuestion = { text, prompt, draft };
    const taskId = contextTask;
    addBubble('user', text);
    history.push({ role: 'user', content: prompt || text });
    setSending(true);
    stick = true;
    const t0 = performance.now();
    let typing = addTyping();
    let row = null, t = null;
    const ensureBubble = () => {
      if (row) return;
      typing.remove(); typing = null;
      row = document.createElement('div'); row.className = 'chat-row chat-row-assistant';
      const el = document.createElement('div'); el.className = 'chat-msg chat-assistant chat-streaming';
      row.appendChild(el); $('chatLog').appendChild(row);
      t = typer(el);
    };
    abort = new AbortController();
    try {
      const reply = await fetchAnswer(history.slice(-12), taskId, (piece) => { ensureBubble(); t.push(piece); }, abort.signal);
      ensureBubble();
      if (typeof reply === 'string' && reply && reply !== t.text()) t.set(reply);
      await t.finish();
      row.firstChild.classList.remove('chat-streaming');
      const answer = t.text().trim();
      history.push({ role: 'assistant', content: answer });
      tools(row, answer, { draft, taskId, ms: performance.now() - t0 });
      scrollDown();
    } catch (err) {
      if (typing) typing.remove();
      if (err.name === 'AbortError') {
        if (t && t.text().trim()) { await t.finish(); row.firstChild.classList.remove('chat-streaming'); history.push({ role: 'assistant', content: t.text().trim() }); tools(row, t.text().trim(), { draft, taskId }); }
        else { history.pop(); if (row) row.remove(); }
      } else {
        if (row) row.remove();
        history.pop();                     // the question was not answered; do not send it again as context
        const row = addBubble('error', err.message, { retry: err.status !== 402 });
        addDetails(row, err);
        if (err.status === 402) refresh();   // the trial or membership just ended
      }
    } finally {
      abort = null;
      setSending(false);
      $('chatInput').focus();
    }
  }

  // For Messages: "Draft reply" streams a message straight into the chat box there (not into the assistant window)
  async function draft({ taskId, prompt }, onText) {
    if (!canChat()) throw new Error('The AI assistant is not available right now.');
    let text = '';
    const reply = await fetchAnswer([{ role: 'user', content: prompt }], taskId, (p) => { text += p; onText(text); });
    if (typeof reply === 'string' && reply && reply !== text) onText(reply);
    return reply || text;
  }

  function send(e) {
    e.preventDefault();
    if (sending) { if (abort) abort.abort(); return; }   // the send button is "Stop" while an answer streams
    const text = $('chatInput').value.trim();
    if (!text) return;
    $('chatInput').value = '';
    growInput();
    ask(text);
  }

  function bind() {
    $('btnUpgrade').addEventListener('click', openPlans);
    $('btnClosePlans').addEventListener('click', closePlans);
    $('planModal').addEventListener('click', (e) => { if (e.target === $('planModal')) closePlans(); });
    $('chatLauncher').addEventListener('click', () => openChat($('chatPanel').classList.contains('hidden')));
    $('btnChatClose').addEventListener('click', () => openChat(false));
    $('btnChatClear').addEventListener('click', resetChat);
    $('btnChatUpgrade').addEventListener('click', () => { openChat(false); openPlans(); });
    $('chatForm').addEventListener('submit', send);
    $('chatInput').addEventListener('input', growInput);
    $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sending) $('chatForm').requestSubmit(); } });
    $('chatContextSel').addEventListener('change', (e) => { contextPicked = true; contextTask = e.target.value ? Number(e.target.value) : null; renderSuggestions(); });
    $('chatLog').addEventListener('scroll', () => { const l = $('chatLog'); stick = l.scrollHeight - l.scrollTop - l.clientHeight < 40; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('chatPanel').classList.contains('hidden')) openChat(false); });
  }

  window.ScopeDeskPlans = {
    init(d) { if (deps) return; deps = d; bind(); },
    // The assistant button shows at once; the plan card waits for the status. The server checks every message anyway.
    start({ role: r = 'client' } = {}) {
      role = r === 'vendor' ? 'vendor' : 'client';
      running = true; contextPicked = false; contextTask = null;
      if (role === 'vendor') status = { role: 'vendor', plan: 'vendor', chatbot: true, chatbotConfigured: true };   // shown at once; refresh() confirms
      $('chatLog').replaceChildren();
      $('chatLauncher').classList.remove('hidden'); render(); refresh();
    },
    stop() {
      if (abort) abort.abort();
      running = false; status = null; history = []; lastQuestion = null; contextTask = null; contextPicked = false;
      $('planCard').classList.add('hidden'); $('chatLauncher').classList.add('hidden'); $('chatPanel').classList.add('hidden');
      $('chatLog').replaceChildren(); closePlans(); notify();
    },
    refresh,
    open: openPlans,
    buy,
    getStatus: () => (role === 'vendor' ? null : status),
    canChat,
    draft,
    tasksChanged() { if (running && !$('chatPanel').classList.contains('hidden')) { renderContext(); renderSuggestions(); } },
    onChange(fn) { listeners.push(fn); if (status) fn(status); }
  };
})();

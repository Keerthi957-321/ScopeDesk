// ScopeDesk plans + AI assistant (client side). Display and requests only: the SERVER decides the plan, the price and who may chat.
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

  const PLAN_NAME = { trial: 'Free trial', free: 'Free', member: 'Member', legacy: 'All features' };
  const inr = (v) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const dateText = (ms) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const daysLeft = (ms) => Math.max(0, Math.ceil((ms - Date.now()) / 86400000));

  // ---------- plan card + dialog ----------
  function render() {
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
      b.addEventListener('click', () => buy(m.plan, b));
      box.appendChild(b);
    });
    renderChatAccess();
  }

  async function refresh() {
    if (!running || !deps) return null;
    try { status = await deps.api('/api/billing/status'); render(); } catch (_) { /* card keeps its last state */ }
    return status;
  }

  function openPlans() { refresh(); $('planModal').classList.add('open'); }
  function closePlans() { $('planModal').classList.remove('open'); }

  async function buy(plan, button) {
    if (!deps) return;
    const all = [...document.querySelectorAll('.plan-buy-btn')];
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
  function renderChatAccess() {
    const s = status;
    $('chatLauncher').classList.toggle('hidden', !running);
    if (!s) return;
    const locked = !s.chatbot;
    const offline = s.chatbot && !s.chatbotConfigured;
    $('chatLocked').classList.toggle('hidden', !(locked || offline));
    $('chatForm').classList.toggle('hidden', locked || offline);
    $('btnChatUpgrade').classList.toggle('hidden', !locked || !s.paymentsEnabled);
    $('chatLockedText').textContent = offline
      ? 'The AI assistant is not switched on for this server yet. Ask your administrator to add OPENAI_API_KEY.'
      : (s.trialEndsAt == null && s.plan === 'free'
        ? 'Your free trial has ended. The AI assistant is part of Membership, together with unlimited tasks.'
        : 'The AI assistant is part of Membership.');
    $('chatPlanLine').textContent = s.plan === 'trial' ? `Included in your free trial (${daysLeft(s.trialEndsAt)} days left)` : s.plan === 'member' ? 'Included in your membership' : s.plan === 'legacy' ? '' : 'Members only';
  }

  function addBubble(role, text) {
    const el = document.createElement('div');
    el.className = `chat-msg chat-${role}`;
    el.textContent = text;          // plain text only, never HTML
    $('chatLog').appendChild(el);
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
    return el;
  }

  function openChat(open) {
    $('chatPanel').classList.toggle('hidden', !open);
    $('chatLauncher').setAttribute('aria-expanded', String(open));
    if (open) {
      if (!$('chatLog').children.length) addBubble('assistant', 'Hi! I can help you write a clear task, choose which apps to allow, or explain an alert. What do you need?');
      refresh();
      setTimeout(() => { if (!$('chatForm').classList.contains('hidden')) $('chatInput').focus(); }, 0);
    }
  }

  async function send(e) {
    e.preventDefault();
    if (sending || !deps) return;
    const text = $('chatInput').value.trim();
    if (!text) return;
    $('chatInput').value = '';
    addBubble('user', text);
    history.push({ role: 'user', content: text });
    sending = true;
    $('btnChatSend').disabled = true;
    const typing = addBubble('assistant', 'Thinking...');
    typing.classList.add('chat-typing');
    try {
      const res = await deps.api('/api/chat', { method: 'POST', body: { messages: history.slice(-12) } });
      typing.remove();
      addBubble('assistant', res.reply);
      history.push({ role: 'assistant', content: res.reply });
    } catch (err) {
      typing.remove();
      history.pop();                     // the question was not answered; do not send it again as context
      addBubble('error', err.message);
      if (err.status === 402) refresh();   // the trial or membership just ended
    } finally {
      sending = false;
      $('btnChatSend').disabled = false;
    }
  }

  function bind() {
    $('btnUpgrade').addEventListener('click', openPlans);
    $('btnClosePlans').addEventListener('click', closePlans);
    $('planModal').addEventListener('click', (e) => { if (e.target === $('planModal')) closePlans(); });
    $('chatLauncher').addEventListener('click', () => openChat($('chatPanel').classList.contains('hidden')));
    $('btnChatClose').addEventListener('click', () => openChat(false));
    $('btnChatUpgrade').addEventListener('click', () => { openChat(false); openPlans(); });
    $('chatForm').addEventListener('submit', send);
    $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('chatPanel').classList.contains('hidden')) openChat(false); });
  }

  window.ScopeDeskPlans = {
    init(d) { if (deps) return; deps = d; bind(); },
    // The assistant button shows at once; the plan card waits for the status. The server checks every message anyway.
    start() { running = true; $('chatLauncher').classList.remove('hidden'); render(); refresh(); },
    stop() {
      running = false; status = null; history = [];
      $('planCard').classList.add('hidden'); $('chatLauncher').classList.add('hidden'); $('chatPanel').classList.add('hidden');
      $('chatLog').replaceChildren(); closePlans();
    },
    refresh,
    open: openPlans
  };
})();

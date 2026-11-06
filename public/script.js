window.SCOPEDESK_BUILD = '2026-11-06-v19';
// Safety net: no form on this page may ever submit natively. A native submit reloads the page and looks like a "logout".
document.addEventListener('submit', (e) => e.preventDefault(), true);

document.addEventListener('DOMContentLoaded', () => {

    // Where is the ScopeDesk backend?
    //   1) same origin: the page was opened from the live ScopeDesk server (the normal case, also inside the desktop app)
    //   2) an address saved in this browser: localStorage.setItem('scopedesk_api', 'https://your-app.up.railway.app')
    //   3) "serverUrl" in app-config.json (the production address)
    // Every check has a timeout, so a dead address can never hang the login screen.
    let API_BASE = null;
    let apiResolved = false;
    async function configuredServerUrl() {
        try {
            const r = await fetch('app-config.json', { cache: 'no-store' });
            const d = await r.json();
            return String((d && d.serverUrl) || '').trim().replace(/\/+$/, '');
        } catch (_) { return ''; }
    }
    async function apiCandidates() {
        let saved = '';
        try { saved = (localStorage.getItem('scopedesk_api') || '').replace(/\/+$/, ''); } catch (_) { /* storage blocked */ }
        const configured = await configuredServerUrl();
        // Developer convenience only: a page opened from THIS computer (Live Server, a local file) may also find a local server on port 3100 (the launcher) or 3000.
        // It is tried last, so a configured Railway address always wins, and it is never used by a page served from the internet.
        const onThisComputer = ['localhost', '127.0.0.1', '[::1]', ''].includes(window.location.hostname);
        return ['', saved, configured, ...(onThisComputer ? ['http://localhost:3100', 'http://localhost:3000'] : [])].filter((v, i, a) => a.indexOf(v) === i && (v === '' || v));
    }
    async function isScopeDesk(base) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        try {
            const r = await fetch(base + '/api/health', { cache: 'no-store', signal: ctrl.signal });
            const d = await r.json();
            return !!(d && d.app === 'scopedesk');
        } catch (_) { return false; }
        finally { clearTimeout(timer); }
    }
    async function resolveApiBase() {
        if (apiResolved) return;
        const candidates = await apiCandidates();
        for (const base of candidates) {
            if (await isScopeDesk(base)) { API_BASE = base; apiResolved = true; return; }
        }
        // Not reachable right now. Requests go to the configured address (or this page's own origin) and fail cleanly; we look again on the next call.
        if (API_BASE === null) API_BASE = candidates.filter(Boolean)[0] || '';
    }

    // ================= STATE =================
    const TOKEN_KEY = 'scopedesk_token'; // sessionStorage: each browser tab can be a different user (handy for testing)
    const STATE = {
        user: null,          // { id, username, role }
        authToken: null,
        socket: null,
        tasks: [],
        vendors: [],
        session: null,       // vendor only: { session, task } currently open in the monitor screen
        live: null,          // { taskId, title, vendor, endMs, process } while a session is running (both roles)
        clockOffset: 0,      // server time minus browser time, so the countdown matches the server's
        pendingViolation: null // client only: the alert currently shown in the modal
    };

    // ================= DOM =================
    const $ = (id) => document.getElementById(id);
    const authContainer = $('authContainer');
    const appContainer = $('appContainer');
    const authForm = $('authForm');
    const forgotForm = $('forgotForm');
    const resetForm = $('resetForm');
    const verifyForm = $('verifyForm');
    const mailSetupForm = $('mailSetupForm');
    const authFormTitle = $('authFormTitle');
    const authFormSubtitle = $('authFormSubtitle');
    const authToggleText = $('authToggleText');
    const btnSwitchAuthMode = $('btnSwitchAuthMode');
    const authToggleHeader = document.querySelector('.auth-toggle-header');
    const roleSelectorGroup = $('roleSelectorGroup');
    const emailGroup = $('emailGroup');
    const authError = $('authError');
    const authSuccess = $('authSuccess');
    const forgotLinkRow = $('forgotLinkRow');
    const pwHint = $('pwHint');
    const usernameMsg = $('usernameMsg');
    const emailMsg = $('emailMsg');
    const btnSubmitAuth = $('btnSubmitAuth');
    const roleCards = document.querySelectorAll('.role-card');

    const navItems = document.querySelectorAll('.nav-menu .nav-item');
    const paneViews = document.querySelectorAll('.pane-view');
    const clientTasksBody = $('clientTasksBody');
    const vendorTasksBody = $('vendorTasksBody');
    const taskModal = $('taskModal');
    const newTaskForm = $('newTaskForm');
    const inputTokenKey = $('inputTokenKey');
    const tokenErrorFeedback = $('tokenErrorFeedback');

    const violationModal = $('violationModal');
    const violationBox = $('violationBox');

    let authMode = 'signin'; // 'signin' | 'signup' | 'forgot' | 'reset' | 'verify' | 'mailsetup'
    let verifyEmail = '';    // the address a verification code was sent to
    let selectedRole = 'client';
    let resetEmail = '';      // the address the 6-digit code was requested for

    // ================= HELPERS =================
    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function api(path, { method = 'GET', body, auth = true, _retried = false } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (auth && STATE.authToken) headers.Authorization = `Bearer ${STATE.authToken}`;
        let response;
        try {
            await resolveApiBase();
            if (!apiResolved) throw new Error('no server');   // nothing answered as ScopeDesk: say so plainly instead of posting to the wrong place
            response = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        } catch (_) {
            if (window.ScopeDeskStatus) ScopeDeskStatus.reportDown(); // the banner explains how to restart the server
            throw new Error('Cannot reach the ScopeDesk server. Open ScopeDesk at your Railway address (not Live Server or a saved file), or set "serverUrl" in public/app-config.json.');
        }

        // The server renews your login while you are active; keep the newest token
        const renewed = response.headers.get('X-New-Token');
        if (renewed && auth && STATE.authToken) {
            STATE.authToken = renewed;
            sessionStorage.setItem(TOKEN_KEY, renewed);
            if (STATE.socket) STATE.socket.auth = { token: renewed };
        }

        const data = await response.json().catch(() => ({}));

        if (response.status === 401 && auth) {
            if (!_retried && STATE.authToken) {
                // Double-check before logging anyone out: is the token really rejected?
                try {
                    const check = await fetch(API_BASE + '/api/auth/me', { headers: { Authorization: `Bearer ${STATE.authToken}` } });
                    if (check.ok) return api(path, { method, body, auth, _retried: true });
                } catch (_) { /* fall through to logout */ }
            }
            if (STATE.user || STATE.authToken) logout(data.error || 'Please sign in again.');
            throw new Error('Session expired.');
        }
        if (!response.ok) {
            const failure = new Error(data.error || `The server answered with status ${response.status} but not from ScopeDesk. Check the server address in app-config.json.`);
            failure.status = response.status;
            failure.data = data;       // e.g. { code: 'EMAIL_NOT_VERIFIED', email }
            throw failure;
        }
        return data;
    }

    // Streamed request (Server-Sent Events over fetch): calls onEvent(name, data) for each event as it arrives.
    // Throws like api() when the server refuses before the stream starts (plan, rate limit, bad input).
    async function streamApi(path, body, onEvent, signal) {
        await resolveApiBase();
        if (!apiResolved) throw new Error('Cannot reach the ScopeDesk server.');
        let response;
        try {
            response = await fetch(API_BASE + path, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${STATE.authToken}` }, body: JSON.stringify(body) });
        } catch (err) {
            if (err && err.name === 'AbortError') throw err;
            throw Object.assign(new Error('Cannot reach the ScopeDesk server.'), { network: true });
        }
        const renewed = response.headers.get('X-New-Token');
        if (renewed && STATE.authToken) { STATE.authToken = renewed; sessionStorage.setItem(TOKEN_KEY, renewed); if (STATE.socket) STATE.socket.auth = { token: renewed }; }
        const type = response.headers.get('Content-Type') || '';
        if (!response.ok || !/event-stream/.test(type) || !response.body) {
            const data = await response.json().catch(() => ({}));
            if (response.status === 401) { logout(data.error || 'Please sign in again.'); throw new Error('Session expired.'); }
            throw Object.assign(new Error(data.error || `The server answered with status ${response.status}.`), { status: response.status, data, notStreaming: response.ok || response.status === 404 });
        }
        const reader = response.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let cut;
            while ((cut = buf.indexOf('\n\n')) !== -1) {
                const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
                const ev = (/^event: (.*)$/m.exec(block) || [])[1] || 'message';
                const raw = (/^data: (.*)$/m.exec(block) || [])[1];
                let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch (_) { /* skip a broken event */ }
                onEvent(ev.trim(), data);
            }
        }
    }

    let toastTimer;
    function toast(message, warn = false) {
        if (/^Cannot reach the server/.test(message)) return;
        document.querySelectorAll('.toast').forEach((t) => t.remove());
        const el = document.createElement('div');
        el.className = 'toast' + (warn ? ' warn' : '');
        el.textContent = message;
        document.body.appendChild(el);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.remove(), 6000);
    }

    function showAuthError(message) {
        authSuccess.classList.add('hidden');
        authError.textContent = message;
        authError.classList.remove('hidden');
    }
    function showAuthSuccess(message) {
        authError.classList.add('hidden');
        authSuccess.textContent = message;
        authSuccess.classList.remove('hidden');
    }
    function clearAuthMessages() {
        authError.classList.add('hidden');
        authSuccess.classList.add('hidden');
    }

    // ================= 1. AUTH SCREENS =================
    function setAuthMode(mode) {
        authMode = mode;
        clearAuthMessages();
        const isSignin = mode === 'signin';
        const isSignup = mode === 'signup';
        clearFieldMessages();

        authForm.classList.toggle('hidden', !(isSignin || isSignup));
        forgotForm.classList.toggle('hidden', mode !== 'forgot');
        resetForm.classList.toggle('hidden', mode !== 'reset');
        verifyForm.classList.toggle('hidden', mode !== 'verify');
        mailSetupForm.classList.toggle('hidden', mode !== 'mailsetup');
        authToggleHeader.classList.toggle('hidden', !(isSignin || isSignup));

        roleSelectorGroup.classList.toggle('hidden', !isSignup);
        emailGroup.classList.toggle('hidden', !isSignup);
        pwHint.classList.toggle('hidden', !isSignup);
        forgotLinkRow.classList.toggle('hidden', !isSignin);

        if (isSignup) {
            authFormTitle.textContent = 'Create your account';
            authFormSubtitle.textContent = 'Choose your workspace role to set up the right access level.';
            authToggleText.textContent = 'Already have an account?';
            btnSwitchAuthMode.textContent = 'Sign in →';
            btnSubmitAuth.textContent = 'Create Account →';
            $('lblAuthUsername').textContent = 'Username';
            $('authPassword').setAttribute('autocomplete', 'new-password');
        } else if (isSignin) {
            authFormTitle.textContent = 'Sign in to ScopeDesk';
            authFormSubtitle.textContent = 'Your secure remote support hub, with clear constraints.';
            authToggleText.textContent = 'New to ScopeDesk?';
            btnSwitchAuthMode.textContent = 'Create an account →';
            btnSubmitAuth.textContent = 'Sign In to Dashboard →';
            $('lblAuthUsername').textContent = 'Username or email';
            $('authPassword').setAttribute('autocomplete', 'current-password');
        } else if (mode === 'forgot') {
            authFormTitle.textContent = 'Reset your password';
            authFormSubtitle.textContent = 'Enter your account email and we will send you a 6-digit code.';
        } else if (mode === 'verify') {
            authFormTitle.textContent = 'Verify Your Account';
            authFormSubtitle.textContent = 'One last step before you can sign in.';
            $('verifyEmailLabel').textContent = verifyEmail;
        } else if (mode === 'mailsetup') {
            authFormTitle.textContent = 'Connect email';
            authFormSubtitle.textContent = 'Needed once, so ScopeDesk can send verification codes.';
        } else if (mode === 'reset') {
            authFormTitle.textContent = 'Enter your code';
            authFormSubtitle.textContent = 'Type the 6-digit code and choose a new password (at least 8 characters).';
            $('resetEmailLabel').textContent = resetEmail;
        }
        const box = document.querySelector('.auth-box');   // gentle fade between steps, no new tab or popup
        if (box) { box.classList.remove('swap'); void box.offsetWidth; box.classList.add('swap'); }
    }

    // If this server has no email connected and this is the server's own computer, offer the one-time setup instead of a dead end.
    async function offerMailSetupIfNeeded() {
        try {
            const st = await api('/api/setup/mail', { auth: false });
            if (!st.configured && st.canSetup && authMode === 'signup') setAuthMode('mailsetup');
        } catch (_) { /* offline: the server banner explains it */ }
    }
    btnSwitchAuthMode.addEventListener('click', () => {
        const next = authMode === 'signup' ? 'signin' : 'signup';
        setAuthMode(next);
        if (next === 'signup') offerMailSetupIfNeeded();
    });
    $('btnForgotPassword').addEventListener('click', () => setAuthMode('forgot'));
    document.querySelectorAll('[data-back-to-signin]').forEach((b) => b.addEventListener('click', () => setAuthMode('signin')));

    roleCards.forEach((card) => {
        card.addEventListener('click', () => {
            roleCards.forEach((c) => c.classList.remove('active'));
            card.classList.add('active');
            const radio = card.querySelector('input[type="radio"]');
            radio.checked = true;
            selectedRole = radio.value;
        });
    });

    // Show / hide password (works for every .password-field: sign-in, sign-up, reset)
    document.querySelectorAll('.password-field').forEach((field) => {
        const input = field.querySelector('input');
        const button = field.querySelector('.pw-toggle');
        const eye = field.querySelector('.icon-eye');
        const eyeOff = field.querySelector('.icon-eye-off');
        button.addEventListener('click', () => {
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            eye.classList.toggle('hidden', show);
            eyeOff.classList.toggle('hidden', !show);
            button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
            input.focus();
        });
    });

    // ----- live sign-up validation -----
    const DUPLICATE_MSG = 'An account with this email/username already exists. Please Sign In instead.';
    const PASSWORD_MSG = 'Password must be at least 8 characters long.';
    const USERNAME_RE = /^[A-Za-z0-9._-]{3,50}$/;
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    const taken = { username: false, email: false };
    let availabilityTimer = null;
    let availabilityRun = 0;

    function setFieldMsg(el, input, text, kind) {
        el.replaceChildren();
        if (!text) { el.classList.add('hidden'); if (input) input.classList.remove('invalid'); return; }
        el.classList.remove('hidden', 'error', 'ok');
        if (kind) el.classList.add(kind);
        el.append(text);
        if (input) input.classList.toggle('invalid', kind === 'error');
    }

    function addSignInLink(el) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'link-btn';
        btn.textContent = 'Sign in →';
        btn.addEventListener('click', () => {
            const keep = $('authEmail').value.trim() || $('authUsername').value.trim();
            setAuthMode('signin');
            $('authUsername').value = keep;
            $('authPassword').focus();
        });
        el.appendChild(btn);
    }

    function clearFieldMessages() {
        taken.username = taken.email = false;
        setFieldMsg(usernameMsg, $('authUsername'), '');
        setFieldMsg(emailMsg, $('authEmail'), '');
        pwHint.classList.remove('error');
        pwHint.textContent = 'At least 8 characters.';
        updateSubmitState();
    }

    function updateSubmitState() {
        btnSubmitAuth.disabled = authMode === 'signup' && (taken.username || taken.email);
    }

    // Returns the first problem found (and shows it under the field), or null when everything is valid.
    function validateSignupFields() {
        const username = $('authUsername').value.trim();
        const email = $('authEmail').value.trim();
        const password = $('authPassword').value;
        let firstError = null;

        if (username && !USERNAME_RE.test(username)) {
            const msg = username.includes('@')
                ? "Username can't contain @. Use a short name like \"keerthi\" and put your email in the Email field."
                : 'Username must be 3-50 characters: letters, numbers, dot, dash or underscore.';
            setFieldMsg(usernameMsg, $('authUsername'), msg, 'error');
            firstError = firstError || msg;
        } else if (!taken.username) {
            setFieldMsg(usernameMsg, $('authUsername'), '');
        }
        if (email && !EMAIL_RE.test(email)) {
            setFieldMsg(emailMsg, $('authEmail'), 'Please enter a valid email address.', 'error');
            firstError = firstError || 'Please enter a valid email address.';
        } else if (!taken.email) {
            setFieldMsg(emailMsg, $('authEmail'), '');
        }
        if (password && password.length < 8) {
            pwHint.textContent = PASSWORD_MSG;
            pwHint.classList.add('error');
            firstError = firstError || PASSWORD_MSG;
        } else {
            pwHint.textContent = 'At least 8 characters.';
            pwHint.classList.remove('error');
        }
        return firstError;
    }

    async function checkAvailability() {
        const username = $('authUsername').value.trim();
        const email = $('authEmail').value.trim();
        const askUser = USERNAME_RE.test(username);
        const askEmail = EMAIL_RE.test(email);
        if (!askUser && !askEmail) { taken.username = taken.email = false; updateSubmitState(); return; }

        const run = ++availabilityRun;
        try {
            const q = new URLSearchParams();
            if (askUser) q.set('username', username);
            if (askEmail) q.set('email', email);
            const data = await api('/api/auth/availability?' + q.toString(), { auth: false });
            if (run !== availabilityRun || authMode !== 'signup') return; // a newer check superseded this one
            taken.username = askUser && !!data.usernameTaken;
            taken.email = askEmail && !!data.emailTaken;
            if (taken.username) { setFieldMsg(usernameMsg, $('authUsername'), DUPLICATE_MSG, 'error'); addSignInLink(usernameMsg); }
            if (taken.email) { setFieldMsg(emailMsg, $('authEmail'), DUPLICATE_MSG, 'error'); addSignInLink(emailMsg); }
            validateSignupFields();
        } catch (_) { /* offline: the server banner already explains it */ }
        updateSubmitState();
    }

    function onSignupInput(e) {
        if (authMode !== 'signup') return;
        if (e.target.id === 'authUsername') taken.username = false;
        if (e.target.id === 'authEmail') taken.email = false;
        clearAuthMessages();
        validateSignupFields();
        updateSubmitState();
        clearTimeout(availabilityTimer);
        if (e.target.id !== 'authPassword') availabilityTimer = setTimeout(checkAvailability, 400);
    }
    ['authUsername', 'authEmail', 'authPassword'].forEach((id) => $(id).addEventListener('input', onSignupInput));

    // Used by sign-in AND by "Verify & Activate" (which returns a token too), so both land in the dashboard the same way
    function completeLogin(data) {
        sessionStorage.setItem(TOKEN_KEY, data.token);
        STATE.authToken = data.token;
        STATE.user = { id: data.user.id, username: data.user.username, role: data.user.role };
        bootApplication();
    }
    async function doLogin(username, password) {
        const data = await api('/api/auth/login', { method: 'POST', auth: false, body: { username, password } });
        completeLogin(data);
    }

    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthMessages();

        const username = $('authUsername').value.trim();
        const email = $('authEmail').value.trim();
        const password = $('authPassword').value;
        const signingUp = authMode === 'signup';

        if (!username || !password || (signingUp && !email)) {
            return showAuthError(signingUp ? 'Please fill in username, email and password.' : 'Please enter your username (or email) and password.');
        }

        btnSubmitAuth.disabled = true;
        try {
            if (signingUp) {
                const problem = validateSignupFields();
                if (problem) return showAuthError(problem);

                await checkAvailability(); // final check right before creating
                if (taken.username || taken.email) return showAuthError(DUPLICATE_MSG);

                const created = await api('/api/auth/signup', { method: 'POST', auth: false, body: { username, email, password, role: selectedRole, organization: null } });
                if (created.requiresVerification) {
                    // The account waits (PENDING_VERIFICATION) until the emailed code is entered
                    openVerifyScreen(created.email || email.toLowerCase(), { started: created.emailSent !== false });
                    if (created.emailSent === false) showVerifyError(created.message);
                } else {
                    await doLogin(username, password); // verification switched off on this server: signed in automatically
                }
            } else {
                await doLogin(username, password);
            }
        } catch (err) {
            if (err.data && err.data.code === 'EMAIL_NOT_VERIFIED') {
                openVerifyScreen(err.data.email || '', { started: false });
                requestNewCode({ quiet: false });          // the old code may have expired: send a fresh one
            } else if (err.data && err.data.code === 'MAIL_NOT_CONFIGURED') {
                if (err.data.canSetup) setAuthMode('mailsetup');
                else showAuthError('Sign-up is temporarily unavailable. Please try again later.');
            } else {
                showAuthError(err.message);
            }
        } finally {
            updateSubmitState();
            if (authMode === 'signin') btnSubmitAuth.disabled = false;
        }
    });

    // Step 1: ask for a code. The page then shows the code + new-password fields (same answer whether or not the account exists).
    async function requestResetCode(email) {
        const data = await api('/api/auth/forgot-password', { method: 'POST', auth: false, body: { email } });
        resetEmail = email.toLowerCase();
        return data;
    }
    forgotForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthMessages();
        const email = $('forgotEmail').value.trim();
        if (!email) return showAuthError('Please enter your email address.');
        if (!EMAIL_RE.test(email)) return showAuthError('Please enter a valid email address.');
        const btn = $('btnSendCode');
        btn.disabled = true;
        try {
            const data = await requestResetCode(email);
            $('resetCode').value = '';
            $('resetPassword').value = '';
            setAuthMode('reset');
            showAuthSuccess(data.message);
            $('resetCode').focus();
        } catch (err) {
            showAuthError(err.message);
        } finally {
            btn.disabled = false;
        }
    });

    // "Send a new code": same request again, with a short pause so it cannot be spammed
    let resendTimer = null;
    $('btnResendCode').addEventListener('click', async () => {
        const btn = $('btnResendCode');
        if (!resetEmail || btn.disabled) return;
        clearAuthMessages();
        btn.disabled = true;
        try {
            const data = await requestResetCode(resetEmail);
            $('resetCode').value = '';
            showAuthSuccess(data.message);
        } catch (err) {
            showAuthError(err.message);
        }
        let left = 30;
        clearInterval(resendTimer);
        resendTimer = setInterval(() => {
            left -= 1;
            btn.textContent = left > 0 ? `Send a new code (${left}s)` : 'Send a new code';
            if (left <= 0) { clearInterval(resendTimer); btn.disabled = false; }
        }, 1000);
        btn.textContent = `Send a new code (${left}s)`;
    });
    // Digits only, so a pasted "123 456" still works
    $('resetCode').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });

    // Step 2: confirm. Success = green banner, then the page returns to the sign-in form by itself.
    resetForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthMessages();
        const code = $('resetCode').value.trim();
        const password = $('resetPassword').value;
        if (!/^\d{6}$/.test(code)) return showAuthError('Enter the 6-digit code from your email.');
        if (password.length < 8) return showAuthError('Password must be at least 8 characters long.');
        const btn = $('btnConfirmReset');
        btn.disabled = true;
        try {
            const data = await api('/api/auth/reset-password', { method: 'POST', auth: false, body: { email: resetEmail, code, password } });
            $('resetCode').value = '';
            $('resetPassword').value = '';
            showAuthSuccess(data.message);
            const done = resetEmail;
            resetEmail = '';
            setTimeout(() => {
                if (authMode !== 'reset') { btn.disabled = false; return; }   // the user already went elsewhere
                setAuthMode('signin');
                $('authUsername').value = done;
                showAuthSuccess(data.message);
                $('authPassword').focus();
                btn.disabled = false;
            }, 1800);
        } catch (err) {
            showAuthError(err.message);
            btn.disabled = false;
        }
    });

    // ----- "Verify Your Account": 6 boxes, Verify & Activate, Resend Code with a 60-second cooldown -----
    const otpBoxes = Array.from(document.querySelectorAll('#otpBoxes .otp-box'));
    const verifyError = $('verifyError');
    const OTP_RESEND_SECONDS = 60;
    let otpResendTimer = null;
    let otpResendLeft = 0;

    const readOtp = () => otpBoxes.map((b) => b.value).join('');
    function writeOtp(digits) {
        otpBoxes.forEach((b, i) => { b.value = digits[i] || ''; b.classList.toggle('filled', !!b.value); });
    }
    function showVerifyError(message) {
        verifyError.textContent = message;
        verifyError.classList.remove('hidden');
        const group = $('otpBoxes');
        group.classList.remove('invalid'); void group.offsetWidth; group.classList.add('invalid');
    }
    function clearVerifyError() { verifyError.classList.add('hidden'); verifyError.textContent = ''; $('otpBoxes').classList.remove('invalid'); }

    otpBoxes.forEach((box, i) => {
        box.addEventListener('input', () => {
            const digits = box.value.replace(/\D/g, '');
            clearVerifyError();
            if (!digits) { box.value = ''; box.classList.remove('filled'); return; }
            if (digits.length > 1) {                       // several digits typed or pasted into one box: spread them out
                const all = readOtp().split('');
                digits.split('').slice(0, 6 - i).forEach((d, k) => { all[i + k] = d; });
                writeOtp(all);
                otpBoxes[Math.min(i + digits.length, 5)].focus();
                return;
            }
            box.value = digits;
            box.classList.add('filled');
            if (i < 5) otpBoxes[i + 1].focus();
        });
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !box.value && i > 0) { otpBoxes[i - 1].value = ''; otpBoxes[i - 1].classList.remove('filled'); otpBoxes[i - 1].focus(); e.preventDefault(); }
            else if (e.key === 'ArrowLeft' && i > 0) otpBoxes[i - 1].focus();
            else if (e.key === 'ArrowRight' && i < 5) otpBoxes[i + 1].focus();
        });
        box.addEventListener('paste', (e) => {
            const text = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '').slice(0, 6);
            if (!text) return;
            e.preventDefault();
            writeOtp(text.split(''));
            clearVerifyError();
            otpBoxes[Math.min(text.length, 5)].focus();
        });
        box.addEventListener('focus', () => box.select());
    });

    function startResendCooldown(seconds) {
        const link = $('btnResendVerify');
        clearInterval(otpResendTimer);
        otpResendLeft = seconds;
        const paint = () => {
            link.disabled = otpResendLeft > 0;
            link.textContent = otpResendLeft > 0 ? `Resend Code (${otpResendLeft}s)` : 'Resend Code';
        };
        paint();
        if (otpResendLeft <= 0) return;
        otpResendTimer = setInterval(() => { otpResendLeft -= 1; paint(); if (otpResendLeft <= 0) clearInterval(otpResendTimer); }, 1000);
    }

    // The smooth transition: the sign-up form fades out (setAuthMode swaps with an animation) and this screen fades in
    function openVerifyScreen(email, { started }) {
        verifyEmail = email;
        setAuthMode('verify');
        writeOtp([]);
        clearVerifyError();
        startResendCooldown(started ? OTP_RESEND_SECONDS : 0);
        setTimeout(() => otpBoxes[0].focus(), 120);
    }

    async function requestNewCode({ quiet }) {
        if (!verifyEmail) return;
        const link = $('btnResendVerify');
        link.disabled = true;
        clearVerifyError();
        try {
            await api('/api/auth/resend-verification', { method: 'POST', auth: false, body: { email: verifyEmail } });
            writeOtp([]);
            otpBoxes[0].focus();
            if (!quiet) showAuthSuccess(`A new code was sent to ${verifyEmail}.`);
            startResendCooldown(OTP_RESEND_SECONDS);
        } catch (err) {
            if (err.data && err.data.code === 'OTP_COOLDOWN') startResendCooldown(Number(err.data.retryAfter) || OTP_RESEND_SECONDS);
            else startResendCooldown(0);
            showVerifyError(err.message);
        }
    }
    $('btnResendVerify').addEventListener('click', () => { clearAuthMessages(); requestNewCode({ quiet: false }); });

    verifyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthMessages();
        clearVerifyError();
        const code = readOtp();
        if (!/^\d{6}$/.test(code)) { showVerifyError('Enter all 6 digits of the code.'); (otpBoxes.find((b) => !b.value) || otpBoxes[5]).focus(); return; }
        const btn = $('btnConfirmVerify');
        btn.disabled = true;
        btn.textContent = 'Verifying...';
        try {
            // On success the server activates the account and returns a login token: straight into the dashboard
            const data = await api('/api/verify-otp', { method: 'POST', auth: false, body: { email: verifyEmail, otp: code } });
            clearInterval(otpResendTimer);
            writeOtp([]);
            completeLogin(data);
        } catch (err) {
            if (err.data && err.data.code === 'ALREADY_ACTIVE') { setAuthMode('signin'); showAuthSuccess(err.message); }
            else { showVerifyError(err.message || 'Incorrect or expired code. Please try again.'); writeOtp([]); otpBoxes[0].focus(); }
        } finally {
            btn.disabled = false;
            btn.textContent = 'Verify & Activate';
        }
    });

    // ----- one-time "Connect email" screen (only offered on the server's own computer) -----
    function showMailSetupError(message) { const el = $('mailSetupError'); el.textContent = message; el.classList.remove('hidden'); }
    mailSetupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        $('mailSetupError').classList.add('hidden');
        const user = $('mailUser').value.trim();
        const pass = $('mailPass').value.replace(/\s+/g, '');
        if (!EMAIL_RE.test(user)) return showMailSetupError('Enter the email address that will send the codes.');
        if (pass.length < 8) return showMailSetupError('Enter the app password.');
        const btn = $('btnSaveMail');
        btn.disabled = true;
        btn.textContent = 'Testing the login...';
        try {
            const data = await api('/api/setup/mail', { method: 'POST', auth: false, body: { user, pass, host: $('mailHost').value.trim(), port: $('mailPort').value.trim() } });
            $('mailPass').value = '';
            setAuthMode('signup');
            showAuthSuccess(data.message + ' You can create your account now.');
        } catch (err) {
            showMailSetupError(err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Connect & test';
        }
    });

    function logout(message) {
        try { ScopeDeskPlans.stop(); } catch (_) { /* not loaded */ }
        try { ScopeDeskWorkspace.stop(); } catch (_) { /* not loaded */ }
        try { ScopeDeskMessages.stop(); } catch (_) { /* not loaded */ }
        try { ScopeDeskAccess.stop(); } catch (_) { /* not loaded */ }
        clearLive();
        teardownRemoteConnection();
        if (STATE.socket) { STATE.socket.disconnect(); STATE.socket = null; }
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem('scopedesk_panel');
        Object.assign(STATE, { user: null, authToken: null, tasks: [], vendors: [], session: null, pendingViolation: null, live: null });
        closeViolationModal();
        if (typeof hideTerminationOverlay === 'function') hideTerminationOverlay();
        appContainer.classList.add('hidden');
        authContainer.classList.remove('hidden');
        $('authUsername').value = '';
        $('authPassword').value = '';
        setAuthMode('signin');
        if (message) showAuthError(message);
    }
    $('btnLogOut').addEventListener('click', () => logout());

    // ================= 2. APP BOOT + ROUTING =================
    function bootApplication() {
        const lastPanel = sessionStorage.getItem('scopedesk_panel'); // read before routing overwrites it
        authContainer.classList.add('hidden');
        appContainer.classList.remove('hidden');

        const isClient = STATE.user.role === 'client';
        $('userNameSlot').textContent = STATE.user.username;
        $('userRoleBadgeSlot').textContent = isClient ? 'Office Admin Manager' : 'Authorized Engineer Expert';
        $('userAvatarSlot').textContent = STATE.user.username.charAt(0).toUpperCase();
        $('userAvatarSlot').style.backgroundColor = isClient ? '#e28743' : '#2b6cb0';
        $('navSessionLink').classList.add('hidden'); // shown for the vendor only while a session is live (syncVendorNav)

        document.querySelectorAll('.profile-name').forEach((el) => { el.textContent = STATE.user.username; });
        $('navOverviewLink').setAttribute('data-target', isClient ? 'clientDashboardPanel' : 'vendorDashboardPanel');
        $('navOverviewText').textContent = isClient ? 'Tickets' : 'My Tasks';
        // Land on Tickets (My Tasks for vendors); a page you were on before a reload (Remote Connection, Workspace...) is reopened
        const WORKSPACE_PAGES = ['workspacePanel', 'analyticsPanel', 'settingsPanel', 'messagesPanel'].concat(isClient ? ['remoteHubPanel'] : []);
        routeToPanel(WORKSPACE_PAGES.includes(lastPanel) ? lastPanel : (isClient ? 'clientDashboardPanel' : 'vendorDashboardPanel'));
        ScopeDeskWorkspace.start();

        connectSocket();
        loadTasks().then(() => restoreVendorSession(lastPanel));
        if (isClient) loadVendors();
        ScopeDeskPlans.start({ role: STATE.user.role });   // clients: plan card + assistant (by plan); vendors: assistant only
        ScopeDeskMessages.start();
        try { ScopeDeskAccess.start(); } catch (_) { /* access module not loaded */ }
    }

    function routeToPanel(panelId) {
        sessionStorage.setItem('scopedesk_panel', panelId);
        paneViews.forEach((p) => p.classList.add('hidden'));
        const node = $(panelId);
        if (node) node.classList.remove('hidden');
        navItems.forEach((item) => {
            const target = item.getAttribute('data-target');
            const isOverview = item.id === 'navOverviewLink' && (panelId === 'clientDashboardPanel' || panelId === 'vendorDashboardPanel');
            const isSession = item.id === 'navSessionLink' && panelId === 'sessionMonitorPanel';
            item.classList.toggle('active', target === panelId || isOverview || isSession);
            if (target === panelId || isOverview || isSession) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
        });
        try { ScopeDeskWorkspace.onRoute(panelId); } catch (_) { /* workspace module not loaded */ }
        try { ScopeDeskMessages.onRoute(panelId); } catch (_) { /* messages module not loaded */ }
    }

    navItems.forEach((item) => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const target = item.getAttribute('data-target');
            if (target === 'session-panel') {
                if (!STATE.session) {
                    return toast('No active session. Enter a token from your client to start one.');
                }
                routeToPanel('sessionMonitorPanel');
            } else if (target && target !== 'overview-panel' && $(target) && $(target).classList.contains('pane-view')) {
                routeToPanel(target);     // Workspace, Analytics, Settings & Billing (and the dashboards themselves)
            } else {
                routeToPanel(STATE.user.role === 'client' ? 'clientDashboardPanel' : 'vendorDashboardPanel');
            }
        });
    });

    // ================= 3. REAL-TIME SOCKET =================
    let socketLibTried = false;
    function connectSocket() {
        // Live Server cannot serve /socket.io/socket.io.js. If the library is missing, load it from the backend once.
        if (typeof io === 'undefined') {
            if (socketLibTried) { ScopeDeskStatus.reportDown(); return; }
            socketLibTried = true;
            const tag = document.createElement('script');
            tag.src = (API_BASE || '') + '/socket.io/socket.io.js';
            tag.onload = connectSocket;
            tag.onerror = () => ScopeDeskStatus.reportDown();
            document.head.appendChild(tag);
            return;
        }
        if (STATE.socket) STATE.socket.disconnect();
        // The server reads identity from this signed token. Nothing the browser says about "who I am" is trusted.
        const socket = io(API_BASE || undefined, { auth: { token: STATE.authToken } });
        STATE.socket = socket;
        ScopeDeskStatus.attachSocket(socket);   // server up/down banner
        ScopeDeskRTC.bindSocket(socket);        // WebRTC signaling + control events
        try { ScopeDeskMessages.bindSocket(socket); } catch (_) { /* messages module not loaded */ }   // chat + voice calls
        try { ScopeDeskAccess.bindSocket(socket); } catch (_) { /* access module not loaded */ }        // Request Additional Access
        socket.on('workspace-changed', () => { try { ScopeDeskWorkspace.workspaceChanged(); } catch (_) { /* workspace module not loaded */ } });

        socket.on('connect_error', (err) => {
            if (err.message === 'Authentication required') {
                // Make sure the login really is invalid before signing the user out
                fetch(API_BASE + '/api/auth/me', { headers: { Authorization: `Bearer ${STATE.authToken}` } })
                    .then((r) => { if (r.ok) socket.connect(); else logout('Your login is no longer valid. Please sign in again.'); })
                    .catch(() => { /* server unreachable: the banner/reconnect logic handles it */ });
            }
        });

        if (STATE.user.role === 'client') {
            // CLIENT receives the alert
            socket.on('violation-alert', showViolationModal);
            // High-priority breach/termination alert: blocking defensive overlay (only sent when the Client switched alerts on)
            socket.on('termination-alert', showTerminationOverlay);
            // The vendor who ACCEPTED the ticket + the approved time window: bind them to the "Assigned Task" bar at once
            socket.on('task-started', (d) => applyTaskStarted(d));
            socket.on('session-connected', async (d) => {
                applyTaskStarted(d);
                await loadTasks();
                if (d.windowEnd) STATE.clockOffset = d.serverTime - Date.now();
                openShareModal(d); // sharing needs a click, so ask for it right away
            });
            socket.on('session-ended', (d) => {
                const quiet = !alertsEnabledFor(d.taskId);   // the Client switched alerts off for this task
                if (STATE.live && STATE.live.taskId === d.taskId) clearLive();
                if (STATE.pendingViolation && STATE.pendingViolation.taskId === d.taskId) closeViolationModal();
                // These are about ONE task. Your own login stays active.
                if (!quiet) ScopeDeskRTC.notifyTerminated({ reason: d.reason, taskId: d.taskId, title: d.title });
                // Friendly notice in the window + every capture switched off. A breach with alerts on already shows the blocking overlay.
                if (!(d.reason === 'security_violation' && !quiet)) {
                    try { window.ScopeDeskScreenShare.showSessionClosed({ reason: d.reason, taskId: d.taskId, title: d.title }); } catch (_) { /* notice is optional */ }
                } else {
                    try { window.ScopeDeskScreenShare.stopAll(); } catch (_) { /* nothing to stop */ }
                }
                if (quiet && d.reason === 'security_violation') { loadTasks(); return; }
                if (d.reason === 'time_expired') toast(`Task "${d.title || '#' + d.taskId}" has expired (its time window ended). You are still signed in.`);
                else if (d.reason !== 'client_terminated') toast(d.message || 'Session ended.');
                loadTasks();
            });
        } else {
            // VENDOR receives the kill command (never the alert)
            socket.on('force-terminate', (d) => {
                clearLive();
                teardownRemoteConnection();
                STATE.session = null;
                inputTokenKey.value = '';
                routeToPanel('vendorDashboardPanel');
                toast(`Session closed: ${d.message || 'terminated.'}`, true);
                loadTasks();
            });
            socket.on('task-request', (d) => { if (!d.replay) toast(`New support request from ${d.clientName || d.client}: ${d.title}`); loadTasks(); });
            // Accepted (this tab or another tab of the same vendor account): who sent it + the time window
            socket.on('task-accepted', (d) => applyTaskAccepted(d));
            socket.on('connect', () => loadTasks());   // after any (re)connection: catch up on requests sent while offline
            clearInterval(STATE.vendorPoll);
            STATE.vendorPoll = setInterval(() => { if (STATE.user && STATE.user.role === 'vendor' && !document.hidden) loadTasks(); }, 15000);   // safety net behind the socket event
            if (!STATE.visBound) { STATE.visBound = true; document.addEventListener('visibilitychange', () => { if (!document.hidden && STATE.user && STATE.user.role === 'vendor') loadTasks(); }); }
            socket.on('session-ended', () => loadTasks());
        }
    }

    // Closes the remote-view connection. When you add your WebRTC peer, store it in window.scopedeskPeer
    // (or expose closeRemoteConnection() from your Electron preload) and this will cut it.
    function teardownRemoteConnection() {
        closeViewport(0);
        ScopeDeskRTC.stop('closed');
        if (window.scopedeskNative && typeof window.scopedeskNative.closeRemoteConnection === 'function') {
            window.scopedeskNative.closeRemoteConnection();
        }
    }

    // ================= 4. CLIENT: ALERT MODAL + TERMINATE =================
    // Did the Client leave alerts switched on for this task? Unknown tasks default to on (never silence a warning by accident).
    function alertsEnabledFor(taskId) {
        if (STATE.live && STATE.live.taskId === taskId && STATE.live.alertsEnabled === false) return false;
        const t = STATE.tasks.find((x) => x.id === taskId);
        return !(t && t.alerts_enabled === 0);
    }

    // Defensive overlay: covers the whole page until the Client acknowledges it. Text only (textContent), never HTML.
    const terminationOverlay = $('terminationOverlay');
    let overlayTaskId = null;
    function showTerminationOverlay(d) {
        d = d || {};
        overlayTaskId = d.taskId == null ? null : d.taskId;
        $('termWhat').textContent = d.what
            || (d.kind === 'path'
                ? `The vendor tried to open a folder outside the approved scope${d.detail ? ': ' + d.detail : ''}.`
                : `The vendor tried to run ${d.processName || 'an application'}, which is not approved for this task.`);
        $('termTask').textContent = d.taskTitle || (d.taskId != null ? `#${d.taskId}` : '-');
        $('termVendor').textContent = d.vendor || 'Assigned vendor';
        $('termWhen').textContent = new Date(d.occurredAt || Date.now()).toLocaleString();
        $('termKillStatus').textContent = '';
        $('btnTermKill').disabled = false;
        $('btnTermKill').classList.toggle('hidden', overlayTaskId == null);
        terminationOverlay.hidden = false;
        (overlayTaskId == null ? $('btnTermAck') : $('btnTermKill')).focus();
        ScopeDeskRTC.notifyTerminated({ reason: 'security_violation', taskId: d.taskId, title: d.taskTitle, detail: $('termWhat').textContent });
        loadTasks();
    }
    function hideTerminationOverlay() { terminationOverlay.hidden = true; overlayTaskId = null; }
    // The desktop app's own guard / foreground monitor caught a breach: show the blocking overlay at once, before the server's alert arrives
    window.addEventListener('scopedesk-host-lockdown', (e) => {
        if (!STATE.user || STATE.user.role !== 'client') return;
        const d = e.detail || {};
        showTerminationOverlay({ ...d, taskId: d.taskId != null ? d.taskId : (STATE.live && STATE.live.taskId), taskTitle: STATE.live && STATE.live.title, vendor: STATE.live && STATE.live.vendor });
    });
    $('btnTermAck').addEventListener('click', hideTerminationOverlay);
    // Kill switch on the breach overlay. The server may already have ended the task on its own; pressing it still kills the
    // host agent on this PC, revokes the token and confirms the session is dead.
    $('btnTermKill').addEventListener('click', () => {
        const taskId = overlayTaskId;
        if (taskId == null) return;
        $('btnTermKill').disabled = true;
        $('termKillStatus').textContent = 'Terminating...';
        terminateTask(taskId, (res, ok) => {
            $('termKillStatus').textContent = ok
                ? 'Done. The session is closed, its token is revoked and remote control on this computer is stopped.'
                : 'Remote control on this computer is stopped. The server could not be reached to confirm; it will close the session when it sees it.';
            $('btnTermAck').focus();
        });
    });
    // Keep keyboard focus inside the overlay while it is open (two buttons: kill switch and acknowledge)
    terminationOverlay.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const order = [$('btnTermKill'), $('btnTermAck')].filter((b) => !b.classList.contains('hidden') && !b.disabled);
        const i = order.indexOf(document.activeElement);
        (order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length] || $('btnTermAck')).focus();
    });

    function showViolationModal(alert) {
        STATE.pendingViolation = alert;
        $('violationMessage').textContent = alert.message || 'Vendor accessed unauthorized data!';
        $('violationTask').textContent = alert.taskTitle || `#${alert.taskId}`;
        $('violationVendor').textContent = alert.vendor || 'Assigned vendor';
        $('violationWhat').textContent = alert.what || 'An app outside the approved scope was brought to the front.';
        $('violationProcess').textContent = alert.detail ? `${alert.processName || 'unknown'} -> ${alert.detail}` : (alert.processName || 'unknown');
        notifyViolation(alert);
        $('breachWhat').textContent = `${alert.vendor || 'The vendor'}: ${alert.what || alert.processName || 'out-of-scope activity'}`;
        $('breachBanner').classList.remove('hidden');
        ['btnDismissViolation', 'btnBreachResume'].forEach((id) => $(id).classList.toggle('hidden', alert.canResume === false)); // permanent lockout: Terminate is the only choice
        violationModal.classList.add('open');
        violationBox.classList.remove('open-shake');
        void violationBox.offsetWidth; // restart shake animation
        violationBox.classList.add('open-shake');
        loadTasks();
    }

    // Browser notification, so the alert is seen even when ScopeDesk is not the window in front
    // (permission has to be granted from a click: see the "Enable alerts" button)
    function notifyViolation(alert) {
        ScopeDeskRTC.notifyTerminated({ reason: 'security_violation', taskId: alert.taskId, title: alert.taskTitle, detail: `${alert.vendor || 'The vendor'}: ${alert.what || alert.processName || 'out-of-scope activity'}` });
    }
    function syncAlertsButton() {
        const b = $('btnEnableAlerts');
        if (b) b.classList.toggle('hidden', !('Notification' in window) || Notification.permission !== 'default');
    }

    function closeViolationModal() {
        violationModal.classList.remove('open');
        $('breachBanner').classList.add('hidden');
        STATE.pendingViolation = null;
    }

    // ===== HARD TERMINATION ("Terminate Session Now") =====
    // 1. LOCAL, synchronously, before any network round-trip: hang up WebRTC, stop every capture track, and kill the host agent
    //    on THIS PC (desktop app). Even with no connection to the server the vendor loses this computer at once.
    // 2. SERVER: the WebSocket 'terminate-session' event revokes the token, drops the host agent's socket, empties the stream room
    //    and force-terminates the vendor. If the socket is down or silent for 4 s, the same thing is sent over HTTPS instead.
    const TERMINATE_ACK_MS = 4000;
    const terminating = new Set();

    function killLocally(taskId) {
        try { ScopeDeskRTC.stop('closed'); } catch (_) { /* nothing to hang up */ }
        try { window.ScopeDeskScreenShare && window.ScopeDeskScreenShare.stopAll(); } catch (_) { /* nothing captured */ }
        try { ScopeDeskDesktop.endTask(taskId); } catch (_) { /* browser, or the app already stopped it */ }
        if (STATE.live && STATE.live.taskId === taskId) { try { clearLive(); } catch (_) { /* already cleared */ } }
    }

    function terminateOverSocket(taskId) {
        return new Promise((resolve) => {
            const s = STATE.socket;
            if (!s || !s.connected) return resolve(null);
            let settled = false;
            const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, TERMINATE_ACK_MS);
            s.emit('terminate-session', { taskId }, (res) => {
                if (settled) return;
                settled = true; clearTimeout(timer); resolve(res || null);
            });
        });
    }

    async function terminateTask(taskId, onDone) {
        if (taskId == null) return;
        killLocally(taskId);
        if (terminating.has(taskId)) return;        // a second click while the first one is still on its way
        terminating.add(taskId);
        let res = null;
        try {
            res = await terminateOverSocket(taskId);
            if (!res || !res.ok) {
                // WebSocket down, slow, or refused: same kill over HTTPS (server side is idempotent)
                try { res = await api(`/api/tasks/${encodeURIComponent(taskId)}/terminate`, { method: 'POST' }); }
                catch (err) { res = res && res.error ? res : { ok: false, error: err.message }; }
            }
        } finally {
            terminating.delete(taskId);
        }
        const ok = !!(res && (res.ok || res.success));
        if (ok) toast(res.alreadyEnded ? 'Session is closed and its token is revoked. The vendor has no access.' : 'Session terminated. Token revoked and the vendor has been disconnected.');
        else toast(`${(res && res.error) || 'Could not reach the server.'} Remote control on this computer was stopped anyway.`, true);
        if (onDone) onDone(res, ok);
        loadTasks();
        return res;
    }

    // Two places offer the same decision: the alert dialog and the persistent banner on the dashboard
    function terminateFromAlert() {
        if (!STATE.pendingViolation) return;
        const taskId = STATE.pendingViolation.taskId;
        closeViolationModal();                       // the dialog goes away at once; the kill is already running locally
        terminateTask(taskId);
    }
    function resumeFromAlert() {
        // "Resume session": the Client accepts the risk, the vendor's control is re-enabled (agent waits for an in-scope window again)
        const alert = STATE.pendingViolation;
        if (alert && STATE.socket) STATE.socket.emit('resume-after-violation', { taskId: alert.taskId }, (res) => {
            toast(res && res.ok ? 'Session resumed. Share your screen again and bring the approved app to the front.' : 'Could not resume. The session may have ended.', !(res && res.ok));
        });
        closeViolationModal();
    }
    $('btnTerminateNow').addEventListener('click', terminateFromAlert);
    $('btnBreachTerminate').addEventListener('click', terminateFromAlert);
    $('btnDismissViolation').addEventListener('click', resumeFromAlert);
    $('btnBreachResume').addEventListener('click', resumeFromAlert);
    // "Review": close the dialog but keep the banner, so the Client can look at the dashboard and still decide
    $('btnReviewViolation').addEventListener('click', () => violationModal.classList.remove('open'));

    // ================= 5. TASKS (both roles) =================
    async function loadTasks() {
        if (!STATE.user) return;
        try {
            const data = await api('/api/tasks');
            STATE.tasks = data.tasks;
            if (data.serverTime) STATE.clockOffset = data.serverTime - Date.now();
            renderTasks();
            if (STATE.user.role === 'client') syncClientLive();
            try { ScopeDeskWorkspace.onTasks(); } catch (_) { /* workspace module not loaded */ }
            try { ScopeDeskMessages.tasksChanged(STATE.tasks); } catch (_) { /* messages module not loaded */ }
            try { ScopeDeskPlans.tasksChanged(); } catch (_) { /* plans module not loaded */ }
            try { ScopeDeskAccess.tasksLoaded(); } catch (_) { /* access module not loaded */ }
        } catch (err) {
            if (err.message !== 'Session expired.') toast(err.message, true);
        }
    }

    // Allowed apps (clean names) + folder bounds, as small tags. Everything is escaped.
    function listOf(column) { try { const v = JSON.parse(column || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
    function scopeDetails(t) {
        const apps = listOf(t.allowed_apps);
        const shown = apps.length ? apps : (t.target_process ? [t.target_process] : []);
        const folders = listOf(t.allowed_paths);
        const tags = shown.map((a) => `<span class="app-tag">${esc(a)}</span>`).join('');
        const dir = folders.length ? `<br><small>Folder${folders.length > 1 ? 's' : ''}: ${esc(folders.join(', '))}</small>` : '';
        const alerts = t.alerts_enabled === 0 ? '<br><small>Alerts: off</small>' : '';
        return `<span class="app-tags">${tags || '<small>No apps listed</small>'}</span>${dir}${alerts}`;
    }

    function statusBadge(task) {
        const map = { pending: 'badge-pending', active: 'badge-active', completed: 'badge-active', terminated: 'badge-breached', expired: 'badge-pending' };
        const label = task.status.charAt(0).toUpperCase() + task.status.slice(1);
        const flagged = task.intrusion_count > 0 ? ` ⚠ ${task.intrusion_count}` : '';
        return `<span class="badge ${map[task.status] || 'badge-pending'}">${esc(label + flagged)}</span>`;
    }

    function renderTasks() {
        if (STATE.user.role === 'client') {
            $('clientActiveCount').textContent = String(STATE.tasks.filter((t) => t.status === 'active').length).padStart(2, '0');
            $('clientTokenCount').textContent = String(STATE.tasks.length).padStart(2, '0');

            clientTasksBody.innerHTML = STATE.tasks.length ? '' : '<tr><td colspan="5">No tasks yet. Create one with the button above.</td></tr>';
            STATE.tasks.forEach((t) => {
                const canTerminate = t.status === 'pending' || t.status === 'active';
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td class="bold">${esc(t.title)}<br>${scopeDetails(t)}</td>
                    <td>${esc(t.session_vendor_name || t.vendor_name)}<br><small>${esc(windowText(t.window_start, t.window_end, t.duration_minutes))}</small></td>
                    <td><code class="token-code">${esc(t.token)}</code></td>
                    <td>${statusBadge(t)}</td>
                    <td>${canTerminate ? `<button class="btn-table-action" data-terminate="${t.id}">${t.status === 'pending' ? 'Revoke' : 'Terminate'}</button>` : '-'}</td>`;
                clientTasksBody.appendChild(row);
            });
        } else {
            $('vendorIncomingCount').textContent = String(STATE.tasks.length).padStart(2, '0');
            vendorTasksBody.innerHTML = STATE.tasks.length ? '' : '<tr><td colspan="4">No sessions yet. Enter a token from your client above.</td></tr>';
            STATE.tasks.forEach((t) => {
                const live = t.status === 'active' && t.session_status === 'active';
                const canAccept = t.status === 'pending' && t.assigned_vendor_user_id === STATE.user.id;
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td class="bold">${esc(t.title)}<br>${scopeDetails(t)}</td>
                    <td>Request from: <b>${esc(clientNameOf(t))}</b><br><small>${esc(windowText(t.window_start, t.window_end, t.duration_minutes))}</small></td>
                    <td>${statusBadge(t)}</td>
                    <td>${live ? `<button class="btn-table-action" data-open="${t.id}">Open Console</button>`
                        : canAccept ? `<button class="btn-table-action" data-accept="${t.id}">Accept &amp; Connect</button>` : '-'}</td>`;
                vendorTasksBody.appendChild(row);
            });
        }
    }

    clientTasksBody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-terminate]');
        if (!btn) return;
        if (confirm('End this task now? The vendor will be disconnected immediately.')) terminateTask(Number(btn.dataset.terminate));
    });

    vendorTasksBody.addEventListener('click', async (e) => {
        const accept = e.target.closest('[data-accept]');
        if (accept) {
            try {
                const data = await api('/api/sessions/connect', { method: 'POST', body: { task_id: Number(accept.dataset.accept) } });
                openVendorSession(data.session, data.task, data.meta);
                loadTasks();
            } catch (err) {
                toast(err.message, true);
                loadTasks();
            }
            return;
        }
        const btn = e.target.closest('[data-open]');
        if (!btn) return;
        const task = STATE.tasks.find((t) => t.id === Number(btn.dataset.open));
        if (task) openVendorSession({ id: task.session_id }, task);
    });

    // ----- create task (client) -----
    // Fields: vendor, task text, duration, allowed apps (clean names only), alerts switch.
    // The server checks every rule again; this form only makes mistakes easy to fix.
    const appsToggle = $('appsToggle'), appsPanel = $('appsPanel'), appsList = $('appsList'), appsFilter = $('appsFilter'), appsChips = $('appsChips');
    const selectedApps = new Set();
    let appCatalogNames = [];
    // Never show a file name: "Excel.EXE" or "C:\Apps\Billing.exe" becomes "Excel" / "Billing" (same rule as the server)
    const cleanAppLabel = (n) => String(n || '').split(/[\\/]/).pop().replace(/\.(exe|app|msi|bat|cmd|com|lnk|scr|ps1|jar|dmg|pkg|bin|sh|appx|msix)$/i, '').trim();

    // Built-in matrix: used when the server cannot be reached, so the picker is never empty
    const FALLBACK_APPS = ['File Manager', 'Calculator', 'Notepad', 'Notepad++', 'Paint', 'WordPad', 'Snipping Tool', 'Photos', 'Media Player', 'Excel', 'Word', 'PowerPoint', 'Outlook', 'Access', 'OneNote',
        'Adobe Acrobat', 'Chrome', 'Edge', 'Firefox', 'Brave', 'Visual Studio Code', 'QuickBooks', 'Tally', 'OpenVPN', 'Billing Manager', 'Printer Settings', '7-Zip', 'WinRAR', 'VLC', 'Zoom', 'Microsoft Teams'];
    const FALLBACK_ALIASES = { 'File Manager': ['explorer', 'file explorer', 'files', 'finder'], Calculator: ['calc'], Paint: ['mspaint'], Word: ['winword'], PowerPoint: ['powerpnt'], Edge: ['msedge'], Chrome: ['google chrome'] };
    let appAliases = { ...FALLBACK_ALIASES };
    appCatalogNames = [...FALLBACK_APPS].sort((a, b) => a.localeCompare(b));   // shown immediately, replaced by the full list once it loads
    const normalizeSearch = (v) => String(v || '').toLowerCase().replace(/[\s._\-]+/g, ' ').trim();

    async function loadAppCatalog() {
        const names = [...FALLBACK_APPS];
        try {
            const data = await api('/api/apps');
            if (Array.isArray(data.apps)) names.push(...data.apps);
            if (data.aliases && typeof data.aliases === 'object') appAliases = { ...FALLBACK_ALIASES, ...data.aliases };
        } catch (_) { /* the status banner explains an unreachable server; the built-in list is still shown */ }
        // The desktop app knows which programs are installed on this PC (agent/app-discovery.js)
        try {
            const nativeApi = [window.scopedeskHost, window.scopedeskNative].find((n) => n && typeof n.listInstalledApps === 'function');
            if (nativeApi) {
                const local = await nativeApi.listInstalledApps();
                if (Array.isArray(local)) {
                    names.push(...local);
                    api('/api/apps/report', { method: 'POST', body: { apps: local } }).catch(() => { /* optional */ });
                }
            }
        } catch (_) { /* optional */ }
        const seen = new Set();
        appCatalogNames = names.map(cleanAppLabel).filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())).sort((a, b) => a.localeCompare(b));
        renderAppsList();
    }
    const matchesApp = (name, q) => {
        if (!q) return true;
        const words = q.split(' ');
        const hay = normalizeSearch([name, ...(appAliases[name] || [])].join(' '));
        return words.every((w) => hay.includes(w));   // "file manager" finds "File Manager"; "explorer" finds it too
    };
    function visibleApps() {
        const q = normalizeSearch(appsFilter.value);
        return appCatalogNames.filter((n) => matchesApp(n, q));
    }
    function renderAppsList() {
        const items = visibleApps();
        appsList.replaceChildren();
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'multi-select-empty';
            empty.textContent = appCatalogNames.length ? 'No application matches.' : 'No applications available.';
            appsList.appendChild(empty);
            return;
        }
        items.forEach((name) => {
            const label = document.createElement('label');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.value = name;
            box.checked = selectedApps.has(name);
            box.addEventListener('change', () => { if (box.checked) selectedApps.add(name); else selectedApps.delete(name); renderAppsSummary(); });
            label.append(box, document.createTextNode(name));
            appsList.appendChild(label);
        });
    }
    // "Select all shown" / "Clear" so a long list is quick to work with
    (function addBulkButtons() {
        const bar = document.createElement('div');
        bar.className = 'multi-select-bulk';
        bar.style.cssText = 'display:flex;gap:12px;margin:0 0 6px;font-size:13px';
        const mk = (text, fn) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'link-btn'; b.textContent = text;
            b.addEventListener('click', fn);
            return b;
        };
        bar.append(
            mk('Select all shown', () => { visibleApps().forEach((n) => selectedApps.add(n)); renderAppsList(); renderAppsSummary(); }),
            mk('Clear', () => { selectedApps.clear(); renderAppsList(); renderAppsSummary(); })
        );
        appsList.parentNode.insertBefore(bar, appsList);
    })();
    renderAppsList();
    // Apps that reach far beyond one task: a web browser opens the whole internet and every local file (file://), a file manager
    // without approved folders shows the whole disk. The task can still be created; the Client is told what it means.
    const WIDE_APPS = new Set(['chrome', 'edge', 'firefox', 'brave', 'safari']);
    function renderScopeWarning(names) {
        const el = $('appsScopeWarning');
        if (!el) return;
        const wide = names.filter((n) => WIDE_APPS.has(n.toLowerCase()));
        el.textContent = wide.length ? `${wide.join(', ')}: a web browser lets the vendor open any website and any file on this computer from inside it. Allow it only if the task really needs it.` : '';
        el.classList.toggle('hidden', !wide.length);
    }
    function renderAppsSummary() {
        const names = [...selectedApps];
        renderScopeWarning(names);
        appsToggle.textContent = names.length ? `${names.length} application${names.length > 1 ? 's' : ''} selected` : 'Select applications...';
        appsChips.replaceChildren();
        names.forEach((name) => {
            const chip = document.createElement('span');
            chip.className = 'app-chip';
            chip.append(document.createTextNode(name));
            const x = document.createElement('button');
            x.type = 'button';
            x.setAttribute('aria-label', `Remove ${name}`);
            x.textContent = '\u00d7';
            x.addEventListener('click', () => { selectedApps.delete(name); renderAppsList(); renderAppsSummary(); });
            chip.appendChild(x);
            appsChips.appendChild(chip);
        });
    }
    function setAppsPanel(open) {
        appsPanel.classList.toggle('hidden', !open);
        appsToggle.setAttribute('aria-expanded', String(open));
        if (open) {
            if (appCatalogNames.length <= FALLBACK_APPS.length) loadAppCatalog();   // retry when only the built-in list is showing
            appsFilter.focus();
        }
    }
    appsToggle.addEventListener('click', () => setAppsPanel(appsPanel.classList.contains('hidden')));
    appsFilter.addEventListener('input', renderAppsList);
    document.addEventListener('click', (e) => { if (!$('appsPicker').contains(e.target)) setAppsPanel(false); });
    $('appsPicker').addEventListener('keydown', (e) => { if (e.key === 'Escape') { setAppsPanel(false); appsToggle.focus(); } });

    function resetTaskForm() {
        newTaskForm.reset();
        selectedApps.clear();
        appsFilter.value = '';
        renderAppsList();
        renderAppsSummary();
        setAppsPanel(false);
    }
    newTaskForm.addEventListener('reset', () => setTimeout(() => { selectedApps.clear(); renderAppsList(); renderAppsSummary(); }, 0));

    // ===== PRICE / FREE ALLOWANCE (display only) =====
    // The SERVER decides. This only asks GET /api/billing/quote and shows the answer: "This task is FREE (N left)" or
    // "Pay ₹X & Issue Token". Nothing here is sent back as "free"; POST /api/tasks re-checks the allowance in the database.
    const FREE_LABEL = 'Publish Request & Issue Token';
    const btnIssueToken = $('btnIssueToken');
    const priceNote = $('taskPriceNote');
    let quoteSeq = 0;
    let lastQuote = null;
    const formatInr = (inr) => Number(inr).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(Number(inr)) ? 0 : 2, maximumFractionDigits: 2 });

    function renderQuote(q) {
        lastQuote = q;
        priceNote.hidden = false;
        priceNote.classList.remove('is-free', 'is-paid', 'is-loading');
        if (!q) {
            priceNote.classList.add('is-loading');
            priceNote.textContent = 'Checking the price...';
            btnIssueToken.textContent = FREE_LABEL;
            return;
        }
        if (q.free) {
            priceNote.classList.add('is-free');
            const strong = document.createElement('strong');
            strong.textContent = 'This task is FREE';
            const days = q.trialEndsAt ? Math.max(0, Math.ceil((q.trialEndsAt - Date.now()) / 86400000)) : 0;
            const rest = q.plan === 'trial'
                ? ` - free trial: every task is free for ${days} more day${days === 1 ? '' : 's'}.`
                : q.plan === 'member'
                ? ' - included in your membership (unlimited tasks).'
                : q.unlimited
                ? ' (payments are switched off on this server, so every task is free).'
                : ` - ${q.freeLeft} of ${q.freeLimit} free task${q.freeLimit === 1 ? '' : 's'} left this month (free tasks can be up to ${q.freeMaxMinutes} minutes).`;
            priceNote.replaceChildren(strong, document.createTextNode(rest));
            btnIssueToken.textContent = FREE_LABEL;
            return;
        }
        priceNote.classList.add('is-paid');
        const why = q.reason === 'duration'
            ? `Free tasks can be up to ${q.freeMaxMinutes} minutes; this one is longer.`
            : `You have used all ${q.freeLimit} free tasks for this month.`;
        const strong = document.createElement('strong');
        strong.textContent = `Price: ₹${formatInr(q.priceInr)}`;
        const upsell = document.createElement('button');
        upsell.type = 'button';
        upsell.className = 'link-button';
        upsell.textContent = 'Membership makes every task free';
        upsell.addEventListener('click', () => ScopeDeskPlans.open());
        priceNote.replaceChildren(strong, document.createTextNode(` - ${why} Free tasks left this month: ${q.freeLeft}. `), upsell);
        btnIssueToken.textContent = `Pay ₹${formatInr(q.priceInr)} & Issue Token`;
    }

    async function refreshQuote() {
        const seq = ++quoteSeq;
        renderQuote(null);
        try {
            const q = await api(`/api/billing/quote?duration_minutes=${encodeURIComponent($('taskWindow').value)}`);
            if (seq === quoteSeq) renderQuote(q);       // ignore answers to an older duration choice
        } catch (err) {
            if (seq !== quoteSeq) return;
            lastQuote = null;
            priceNote.hidden = false;
            priceNote.classList.remove('is-free', 'is-paid');
            priceNote.classList.add('is-loading');
            priceNote.textContent = 'Could not check the price right now. The server will tell you when you submit.';
            btnIssueToken.textContent = FREE_LABEL;
        }
    }
    $('taskWindow').addEventListener('change', refreshQuote);

    // ===== RAZORPAY CHECKOUT (only loaded when the server says a payment is needed) =====
    const RAZORPAY_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
    let razorpayLoading = null;
    function loadRazorpay() {
        if (window.Razorpay) return Promise.resolve(window.Razorpay);
        if (razorpayLoading) return razorpayLoading;
        razorpayLoading = new Promise((resolve, reject) => {
            const tag = document.createElement('script');
            tag.src = RAZORPAY_SRC;
            tag.async = true;
            tag.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Razorpay did not load.')));
            tag.onerror = () => { razorpayLoading = null; tag.remove(); reject(new Error('Could not load the Razorpay payment window. Check your internet connection and try again.')); };
            document.head.appendChild(tag);
        });
        return razorpayLoading;
    }

    // Opens the payment window. Resolves with the created task after the server verified the payment, or null if the Client closed it.
    async function payAndIssue(payment) {
        const Razorpay = await loadRazorpay();
        return new Promise((resolve, reject) => {
            let finished = false;
            const rzp = new Razorpay({
                key: payment.keyId,
                order_id: payment.orderId,            // amount and currency are bound to the order on Razorpay's side
                amount: payment.amount,
                currency: payment.currency,
                name: payment.name,
                description: payment.description,
                prefill: payment.prefill || {},
                theme: { color: '#008767' },
                handler: async (resp) => {
                    finished = true;
                    try {
                        const done = await api('/api/payments/verify', {
                            method: 'POST',
                            body: {
                                razorpay_order_id: resp.razorpay_order_id,
                                razorpay_payment_id: resp.razorpay_payment_id,
                                razorpay_signature: resp.razorpay_signature
                            }
                        });
                        resolve(done.task);
                    } catch (err) { reject(err); }
                },
                modal: { ondismiss: () => { if (!finished) resolve(null); }, confirm_close: true }
            });
            rzp.on('payment.failed', (r) => {
                const msg = (r && r.error && r.error.description) || 'The payment failed.';
                toast(`${msg} No task was created. You can try again.`, true);
            });
            rzp.open();
        });
    }

    ScopeDeskPlans.init({ api, streamApi, toast, loadRazorpay, getTasks: () => STATE.tasks || [], getUser: () => STATE.user });
    // Client <-> vendor messages and voice calls (messages.js)
    ScopeDeskMessages.init({ api, toast, getUser: () => STATE.user, route: (panel) => routeToPanel(panel) });
    ScopeDeskAccess.init({
        api, toast, getUser: () => STATE.user, getTasks: () => STATE.tasks || [],
        getSessionTaskId: () => (STATE.session && STATE.session.task ? STATE.session.task.id : (STATE.live && STATE.live.taskId) || null),
        // the client approved more apps/folders: show the new scope (vendor sidebar) and reload the ticket list
        onScope: (taskId, r) => {
            if (r && r.allowedApps && STATE.session && STATE.session.task && STATE.session.task.id === taskId) $('lblScopeProcess').textContent = r.allowedApps.join(', ');
            loadTasks().catch(() => {});
        }
    });
    // Workspace, Analytics, Settings & Billing and the Ctrl/Cmd+K palette (workspace.js). It reads STATE, never writes it.
    ScopeDeskWorkspace.init({
        api, toast,
        getUser: () => STATE.user,
        getTasks: () => STATE.tasks || [],
        getLive: () => STATE.live,
        route: (panel) => routeToPanel(panel === 'overview-panel' ? (STATE.user && STATE.user.role === 'client' ? 'clientDashboardPanel' : 'vendorDashboardPanel') : panel),
        openNewTask: () => $('btnOpenTaskModal').click(),
        openAssistant: () => { const l = $('chatLauncher'); if (l && !l.classList.contains('hidden') && $('chatPanel').classList.contains('hidden')) l.click(); },
        openSession: () => $('navSessionLink').click(),
        logout: () => logout(),
        // Remote Connection hub: what is shared right now + the same buttons as the live bar (one implementation for both)
        getShare: () => ({ kind: currentShareKind(), conn: (STATE.rtcView || {}).conn || 'idle' }),
        getLiveText: () => ({ clock: $('liveClock').textContent, agent: $('liveAgent').textContent, canControl: !$('btnPairAgent').classList.contains('hidden'), controlLabel: $('btnPairAgent').textContent }),
        openShareDialog: () => openShareDialog(),
        toggleRemoteControl: () => $('btnPairAgent').click(),
        terminateLive: () => { if (STATE.live) terminateTask(STATE.live.taskId); }
    });
    $('btnViewVendors').addEventListener('click', () => $('cardPartners').click());

    function showIssuedToken(task) {
        taskModal.classList.remove('open');
        resetTaskForm();
        $('newTokenValue').textContent = task.token;
        $('newTokenNotice').classList.remove('hidden');
        loadTasks();     // remote control is NOT started here: it starts when the Client approves the vendor (share dialog)
        ScopeDeskPlans.refresh();   // free tasks left on the plan card
    }

    $('btnOpenTaskModal').addEventListener('click', async () => {
        populateVendorSelect();
        taskModal.classList.add('open');
        await Promise.all([loadVendors(), loadAppCatalog(), refreshQuote()]);   // vendor accounts, application list, price
    });
    $('btnCloseModal').addEventListener('click', () => { taskModal.classList.remove('open'); resetTaskForm(); });

    newTaskForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const vendorId = Number($('vendorSelect').value);
        const task = $('taskText').value.trim();
        if (!vendorId) return toast('Choose the vendor this task is for.', true);
        if (task.length < 5) return toast('Describe the task (at least 5 characters).', true);
        if (!selectedApps.size) return toast('Choose at least one allowed application.', true);
        const submit = btnIssueToken;
        const label = submit.textContent;
        submit.disabled = true;
        try {
            // The server answers EITHER with the finished task (free / payments off) OR with a Razorpay order (paid).
            const res = await api('/api/tasks', {
                method: 'POST',
                body: {
                    vendor_id: vendorId,
                    task,
                    duration_minutes: Number($('taskWindow').value),
                    allowed_apps: [...selectedApps],
                    alerts_enabled: $('taskAlerts').checked
                }
            });
            if (!res.paymentRequired) {
                // FREE: no payment window at all
                showIssuedToken(res.task);
                if (res.billing && res.billing.free && !res.billing.unlimited) toast(`Free task issued. Free tasks left this month: ${res.billing.freeLeftAfter}.`);
                return;
            }
            // PAID: the server may have switched to paid since the quote (e.g. the last free task was used in another tab)
            if (res.billing) renderQuote(res.billing);
            submit.textContent = 'Waiting for payment...';
            const paidTask = await payAndIssue(res.payment);
            if (!paidTask) { toast('Payment window closed. No task was created and nothing was charged.'); return; }
            showIssuedToken(paidTask);
            toast('Payment received. Your token is ready.');
        } catch (err) {
            toast(err.message, true);
        } finally {
            submit.disabled = false;
            if (submit.textContent === 'Waiting for payment...') submit.textContent = label;
            if (taskModal.classList.contains('open')) refreshQuote();
        }
    });
    $('btnDismissToken').addEventListener('click', () => $('newTokenNotice').classList.add('hidden'));

    // ================= 5b. CLIENT: VENDOR ACCOUNTS (view / request / report / terminate) =================
    const vendorsModal = $('vendorsModal');
    const reportModal = $('reportModal');
    let reportTargetId = null;

    const vendorLabel = (v) => `${v.organization || 'Independent Vendor'} (${v.username})`;

    async function loadVendors() {
        if (!STATE.user || STATE.user.role !== 'client') return;
        try {
            STATE.vendors = (await api('/api/vendors')).vendors;
            $('clientPartnerCount').textContent = String(STATE.vendors.filter((v) => !v.blocked).length).padStart(2, '0');
            renderVendors();
            const current = $('vendorSelect').value;
            populateVendorSelect(current);
        } catch (err) {
            if (err.message !== 'Session expired.') toast(err.message, true);
        }
    }

    function populateVendorSelect(selectedId) {
        const select = $('vendorSelect');
        select.replaceChildren();
        const first = document.createElement('option');
        first.value = '';
        first.textContent = 'Choose a vendor...';
        select.appendChild(first);
        STATE.vendors.filter((v) => !v.blocked).forEach((v) => {
            const opt = document.createElement('option');
            opt.value = String(v.user_id);
            opt.textContent = `${vendorLabel(v)}  ★ ${Number(Number(v.rating).toFixed(1))}`;
            select.appendChild(opt);
        });
        if (selectedId) select.value = String(selectedId);
    }

    function renderVendors() {
        const body = $('vendorsBody');
        if (!STATE.vendors.length) {
            body.innerHTML = '<tr><td colspan="6">No vendor accounts exist yet. Vendors appear here after they sign up with the Vendor role.</td></tr>';
            return;
        }
        body.innerHTML = '';
        STATE.vendors.forEach((v) => {
            const row = document.createElement('tr');
            const status = v.blocked
                ? `<span class="badge badge-breached">Access ended</span>`
                : `<span class="badge badge-active">Available</span>`;
            const reported = v.my_reports > 0 ? `<br><span class="vendor-sub">You reported this vendor ${v.my_reports}x</span>` : '';
            const actions = v.blocked
                ? `<button class="btn-table-action" data-vact="restore" data-id="${v.user_id}">Restore access</button>`
                : `<button class="btn-table-action" data-vact="request" data-id="${v.user_id}">Request task</button>
                   <button class="btn-table-action" data-vact="report" data-id="${v.user_id}">Report</button>
                   <button class="btn-table-danger" data-vact="terminate" data-id="${v.user_id}">Terminate access</button>`;
            row.innerHTML = `
                <td class="bold">${esc(v.username)}<br><span class="vendor-sub">${esc(v.organization || 'Independent Vendor')}</span></td>
                <td>${esc(v.specialization)}</td>
                <td>${Number(v.rating).toFixed(1)} ★</td>
                <td>${esc(v.tasks_completed)}</td>
                <td>${status}${reported}</td>
                <td><div class="vendor-actions">${actions}</div></td>`;
            body.appendChild(row);
        });
    }

    async function openVendorsModal() {
        renderVendors();
        vendorsModal.classList.add('open');
        await loadVendors();
    }
    $('cardPartners').addEventListener('click', openVendorsModal);
    $('cardPartners').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openVendorsModal(); } });

    $('vendorsBody').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-vact]');
        if (!btn) return;
        const id = Number(btn.dataset.id);
        const vendor = STATE.vendors.find((v) => v.user_id === id);
        if (!vendor) return;

        try {
            if (btn.dataset.vact === 'request') {
                vendorsModal.classList.remove('open');
                populateVendorSelect(id);
                taskModal.classList.add('open');
            } else if (btn.dataset.vact === 'report') {
                reportTargetId = id;
                $('reportVendorName').textContent = vendor.username;
                $('reportDetails').value = '';
                reportModal.classList.add('open');
            } else if (btn.dataset.vact === 'terminate') {
                if (!confirm(`Terminate ${vendor.username}'s access?\n\nTheir live sessions with you end immediately, their pending requests are revoked, and they cannot connect to your tasks until you restore them. Other clients are not affected.`)) return;
                const res = await api(`/api/vendors/${id}/terminate`, { method: 'POST', body: { reason: 'Access ended by client' } });
                toast(`${res.message} ${res.tasksEnded ? res.tasksEnded + ' task(s) ended.' : ''}`);
                await Promise.all([loadVendors(), loadTasks()]);
            } else if (btn.dataset.vact === 'restore') {
                await api(`/api/vendors/${id}/restore`, { method: 'POST' });
                toast(`${vendor.username} can work with you again.`);
                await loadVendors();
            }
        } catch (err) {
            toast(err.message, true);
        }
    });

    $('reportForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const res = await api(`/api/vendors/${reportTargetId}/report`, {
                method: 'POST',
                body: { reason: $('reportReason').value, details: $('reportDetails').value }
            });
            reportModal.classList.remove('open');
            toast(res.message);
            loadVendors();
        } catch (err) {
            toast(err.message, true);
        }
    });

    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
        btn.addEventListener('click', () => $(btn.dataset.closeModal).classList.remove('open'));
    });

    // ================= 6. VENDOR: CONNECT + MONITOR =================
    $('btnValidateToken').addEventListener('click', async () => {
        tokenErrorFeedback.classList.add('hidden');
        const token = inputTokenKey.value.trim();
        if (!token) {
            tokenErrorFeedback.textContent = 'Please paste the token your client gave you.';
            return tokenErrorFeedback.classList.remove('hidden');
        }
        try {
            const data = await api('/api/sessions/connect', { method: 'POST', body: { token } });
            openVendorSession(data.session, data.task, data.meta);
            loadTasks();
        } catch (err) {
            tokenErrorFeedback.textContent = '❌ ' + err.message;
            tokenErrorFeedback.classList.remove('hidden');
        }
    });

    // ---- metadata shown in the "Assigned Task" views (both roles) ----
    const clientNameOf = (t) => (t && (t.clientName || t.client_org || t.client_username)) || 'Client';
    const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // "10:00 - 10:30 (30 min)". Accepts a start/end as a date string (database) or milliseconds.
    function windowText(start, end, minutes) {
        const a = typeof start === 'number' ? start : parseDbTime(start), b = typeof end === 'number' ? end : parseDbTime(end);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return minutes ? `${minutes} min` : '-';
        return `${clockTime(a)} - ${clockTime(b)}${minutes ? ` (${minutes} min)` : ''}`;
    }

    // Vendor side: write "Request from: <client>", the time window and the countdown
    function paintVendorMeta() {
        const l = STATE.live;
        if (!l || !STATE.user || STATE.user.role !== 'vendor') return;
        $('lblScopeClient').textContent = `Request from: ${l.clientName || '-'}`;
        $('lblScopeWindow').textContent = l.startMs ? windowText(l.startMs, l.endMs, l.durationMinutes) : '-';
        tickClocks();
    }
    function applyTaskAccepted(d) {
        if (!d || !STATE.live || STATE.live.taskId !== d.taskId) return;
        if (d.serverTime) STATE.clockOffset = d.serverTime - Date.now();
        Object.assign(STATE.live, { clientName: d.clientName, startMs: d.startTime, endMs: d.endTime || d.windowEnd, durationMinutes: d.durationMinutes });
        paintVendorMeta();
    }
    // Client side: the vendor who really accepted the ticket replaces any stale name
    function applyTaskStarted(d) {
        if (!d || !STATE.user || STATE.user.role !== 'client') return;
        if (d.serverTime) STATE.clockOffset = d.serverTime - Date.now();
        STATE.live = { taskId: d.taskId, title: d.title, vendor: d.vendorName, vendorId: d.vendorId, process: d.targetProcess, alertsEnabled: d.alertsEnabled !== false, startMs: d.startTime, endMs: d.endTime || d.windowEnd, durationMinutes: d.durationMinutes };
        renderLiveBar();
        tickClocks();
    }

    function openVendorSession(session, task, meta) {
        STATE.session = { session, task };
        const m = meta || {};
        $('lblScopeTask').textContent = task.title;
        $('lblScopeVendor').textContent = STATE.user.username;
        $('lblScopeToken').textContent = `Task #${task.id}`;
        const approvedApps = (m.allowedApps && m.allowedApps.length) ? m.allowedApps : listOf(task.allowed_apps);
        $('lblScopeProcess').textContent = approvedApps.length ? approvedApps.join(', ') : task.target_process;
        $('emulatorWindowTitle').textContent = `Remote screen [Task #${task.id} - ${task.target_process}]`;
        routeToPanel('sessionMonitorPanel');
        STATE.live = {
            taskId: task.id, title: task.title, process: task.target_process,
            clientName: m.clientName || clientNameOf(task),
            startMs: m.startTime || parseDbTime(task.window_start), endMs: m.endTime || parseDbTime(task.window_end),
            durationMinutes: m.durationMinutes || task.duration_minutes
        };
        if (m.serverTime) STATE.clockOffset = m.serverTime - Date.now();
        paintVendorMeta();
        syncVendorNav();
        renderVendorState({ conn: 'idle', agent: 'unknown', halted: null }); // stage hidden until the client's screen is live
        tickClocks();
        if (openViewport(task.id)) {
            $('remoteWaitTitle').textContent = 'Your full-screen workspace is open';
            $('remoteWaitText').textContent = 'The remote screen opens in its own window so you have the whole display to work with. Closed it by mistake? Use "Open full-screen workspace".';
        } else {
            // The window could not open: use the screen area inside this page instead
            // startViewer attaches remote-input.js (mouse + keyboard -> 'ctl'/'mv' data channels, or the server relay). A second
            // capture (ScopeDeskHub.startVendorCapture) used to be attached here too: it duplicated every listener and sent to channels
            // the Client's window never reads.
            ScopeDeskRTC.startViewer(task.id, { video: $('remoteVideo'), stage: $('remoteStage') })
                .catch((err) => toast(err.message, true));
            $('remoteStage').focus();
        }
    }

    // ---- Vendor full-screen workspace (remote-viewport.html) ----
    let viewportWin = null;
    function openViewport(taskId) {
        if (viewportWin && !viewportWin.closed) { viewportWin.focus(); return true; }
        const url = `${window.location.origin}/remote-viewport.html?task=${encodeURIComponent(taskId)}`;
        let w = null;
        try { w = window.open(url, `scopedesk-viewport-${taskId}`, 'popup=yes,width=1600,height=900'); } catch (_) { w = null; }
        if (!w) { toast('The full-screen window was blocked. Allow pop-ups for this site, then use "Open full-screen workspace".', true); return false; }
        viewportWin = w;
        return true;
    }
    function closeViewport(delayMs) {
        const w = viewportWin; viewportWin = null;
        if (!w || w.closed) return;
        setTimeout(() => { try { w.close(); } catch (_) { /* already closed */ } }, delayMs || 0);
    }
    // The workspace window asks for the sign-in token only if its own copy of the session storage is missing (same origin only)
    window.addEventListener('message', (e) => {
        if (e.origin !== window.location.origin || !viewportWin || e.source !== viewportWin) return;
        if (e.data && e.data.t === 'scopedesk-viewport-state') {      // the workspace window owns the live connection: mirror its status here
            $('remoteWaitTitle').textContent = 'Your full-screen workspace is open';
            $('remoteWaitText').textContent = 'Workspace status: ' + e.data.badge;
            const b = $('emulatorStatusBadge'); if (b) b.textContent = e.data.badge;
        }
        if (e.data && e.data.t === 'scopedesk-open-folder-result') {
            if (e.data.ok) toast('Request sent. The client\'s computer checks it against the approved scope.');
            else toast('Not connected to the client\'s screen yet.', true);
        }
        if (e.data && e.data.t === 'scopedesk-need-token' && STATE.authToken) e.source.postMessage({ t: 'scopedesk-token', token: STATE.authToken }, window.location.origin);
    });
    setInterval(() => {
        if (viewportWin && viewportWin.closed) {
            viewportWin = null;
            if (STATE.live && STATE.user && STATE.user.role === 'vendor') {
                $('remoteWaitTitle').textContent = 'Full-screen workspace closed';
                $('remoteWaitText').textContent = 'The session is still running. Use "Open full-screen workspace" to continue.';
            }
        }
    }, 1000);
    $('btnOpenViewport').addEventListener('click', () => {
        if (!STATE.live || !STATE.user || STATE.user.role !== 'vendor') return;
        if (ScopeDeskRTC.isActive()) ScopeDeskRTC.stop('closed');   // never two viewers for one session
        openViewport(STATE.live.taskId);
    });

    // There is no vendor-side monitor and no simulate button any more. Out-of-scope activity is detected by the host
    // agent on the Client's PC (agent/monitor.js), which the vendor cannot tamper with.

    // Vendor finishes normally
    $('btnEndSession').addEventListener('click', async () => {
        if (!STATE.session) return;
        try {
            await api(`/api/sessions/${STATE.session.session.id}/complete`, { method: 'POST' });
            clearLive();
            teardownRemoteConnection();
            STATE.session = null;
            inputTokenKey.value = '';
            routeToPanel('vendorDashboardPanel');
            toast('Session completed.');
            loadTasks();
        } catch (err) {
            toast(err.message, true);
        }
    });

    // ================= 7. SESSION CLOCK + LIVE SESSION UI =================
    // Database timestamps are UTC; "2026-10-24 10:00:00" has no zone marker, so add one before parsing
    const parseDbTime = (v) => { const x = String(v || ''); return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(x) ? x.replace(' ', 'T') : x.replace(' ', 'T') + 'Z'); };
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };
    let expiredHandled = null;

    function tickClocks() {
        const live = STATE.live;
        const label = live ? fmt(live.endMs - (Date.now() + STATE.clockOffset)) : '--:--';
        const left = live ? live.endMs - (Date.now() + STATE.clockOffset) : Infinity;
        ['vendorClock', 'liveClock', 'lblScopeClock'].forEach((id) => {
            const node = $(id);
            if (!node) return;
            node.textContent = label;
            node.classList.toggle('clock-warn', left < 60000 && left > 0);
            node.classList.toggle('clock-zero', left <= 0);
        });
        if (live && left <= 0 && expiredHandled !== live.taskId) {
            // The server closes the session at the same moment; this makes the screen stop even if the connection is slow
            expiredHandled = live.taskId;
            ScopeDeskRTC.stop('expired');
            toast('Time is up. The session has been closed.', true);
            setTimeout(loadTasks, 1500);
        }
    }
    setInterval(tickClocks, 1000);

    function clearLive() {
        closeViewport(4000);   // short delay so the Vendor can read why the session ended
        const endedTaskId = STATE.live && STATE.live.taskId;
        STATE.live = null;
        if (ScopeDeskDesktop.available) { if (endedTaskId) ScopeDeskDesktop.endTask(endedTaskId); else ScopeDeskDesktop.stopAgent(); }   // the agent stops and cannot restart for this task
        ScopeDeskRTC.stopBridge();
        syncVendorNav();
        tickClocks();
        ScopeDeskRTC.stop('closed');
        renderLiveBar();
    }

    function syncClientLive() {
        const t = STATE.tasks.find((x) => x.status === 'active');
        if (!t) { if (STATE.live) clearLive(); return; }
        STATE.live = {
            taskId: t.id, title: t.title, process: t.target_process,
            vendor: t.session_vendor_name || t.vendor_name,       // the vendor who accepted (never the label written when the ticket was created)
            vendorId: t.session_vendor_id || t.vendor_id,
            alertsEnabled: t.alerts_enabled !== 0,
            startMs: parseDbTime(t.window_start), endMs: parseDbTime(t.window_end), durationMinutes: t.duration_minutes
        };
        syncAlertsButton();
        renderLiveBar();
        // Remote control is NOT started here. This function runs every time the task list refreshes (many times per session), and
        // restarting the agent on each refresh is what made the Start/Stop button flip by itself. It starts only when the Client
        // approves: pressing "Share my screen" in the approval dialog, or "Start remote control".
    }

    // ---- Desktop app: the host agent is started through the shell, never by hand ----
    // Only an explicit action by the Client calls this (approval dialog or the Start button). The desktop app itself refuses to start a
    // task again after the Client stopped it, the session ended or the agent failed, unless the Client presses Start.
    let remoteBusy = false, busyTimer = null;
    function setRemoteBusy(on) {
        remoteBusy = on;
        clearTimeout(busyTimer);
        if (on) busyTimer = setTimeout(() => { remoteBusy = false; renderLiveBar(); }, 4000);   // never leave the button locked
        renderLiveBar();
    }
    // Tells the server the Client's decision (start / stop). The server is the one record of it: after a stop it refuses every input
    // event for the task, tells the host agent to exit, updates the vendor's screen and writes the reason to the audit log.
    function sendControlDecision(taskId, action) {
        return new Promise((resolve) => {
            const sock = STATE.socket;
            if (!sock || !sock.connected) return resolve({ ok: false, error: 'Not connected to the ScopeDesk server. Check the internet connection, then try again.' });
            const timer = setTimeout(() => resolve({ ok: false, error: 'The ScopeDesk server did not answer. Try again.' }), 8000);
            sock.emit('remote-control', { taskId, action }, (res) => { clearTimeout(timer); resolve(res || { ok: false, error: 'No answer from the server.' }); });
        });
    }
    async function startDesktopAgent(manual, forTaskId) {
        const taskId = forTaskId || (STATE.live && STATE.live.taskId);
        if (!ScopeDeskDesktop.available || !taskId) return Promise.resolve();
        const decision = await sendControlDecision(taskId, 'start');
        console.log('[ScopeDesk] remote-control start:', decision.ok ? 'approved by the server' : `refused (${decision.error})`, `(task ${taskId})`);
        if (!decision.ok) { STATE.agentStartError = decision.error; setRemoteBusy(false); toast(`Remote control could not start: ${decision.error}`, true); renderLiveBar(); return; }
        STATE.agentStartError = '';
        // The session config goes to the background agent through Electron IPC (ipcRenderer.send('init-session')). No dialog, no command.
        return ScopeDeskDesktop.ensureAgent({
            taskId,
            manual: manual === true,
            getToken: async (id) => (await api(`/api/tasks/${id}/agent-token`, { method: 'POST' })).agentToken,   // stays in memory, never shown
            setToken: () => {}
        }).then((r) => { if (r && r.ok === false && r.error !== 'not-desktop') { STATE.agentStartError = r.error || 'Could not start the host agent.'; toast(STATE.agentStartError, true); renderLiveBar(); } })
          .catch((err) => { STATE.agentStartError = err.message; toast(err.message, true); renderLiveBar(); });
    }
    if ($('btnCopyCheck')) $('btnCopyCheck').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(controlReport()); toast('Control check copied. Paste it into a message to support.'); } catch (_) { toast('Could not copy.', true); }
    });
        ScopeDeskDesktop.onStatus((st) => { STATE.desktopAgent = st; if (['starting', 'connected', 'running'].includes(st.phase)) STATE.agentStartError = ''; remoteBusy = false; clearTimeout(busyTimer); renderLiveBar(); });

    const AGENT_TEXT = { stopped: 'stopped by you (the vendor can only watch)', unknown: 'not running', offline: 'not running', starting: 'starting...', error: 'could not start', waiting: `waiting for the approved app`, armed: 'Active Secured Session', locked: 'locked after a violation', 'view-only': 'view only (this computer is not allowing control)' };
    const SHARE_TEXT = { idle: 'not shared', starting: 'choosing screen...', waiting: 'shared, waiting for vendor', connecting: 'connecting...', live: 'live', lost: 'connection lost, retrying', stopped: 'stopped', closed: 'closed', expired: 'closed (time up)', violation: 'cut after a violation' };

    function renderLiveBar() {
        const bar = $('liveBar');
        if (!bar || !STATE.user || STATE.user.role !== 'client') return;
        const live = STATE.live;
        bar.classList.toggle('hidden', !live);
        if (!live) return;
        $('liveTask').textContent = live.title;
        $('liveVendor').textContent = live.vendor || 'vendor';
        if ($('liveWindow')) $('liveWindow').textContent = live.startMs ? windowText(live.startMs, live.endMs, live.durationMinutes) : '-';
        const v = STATE.rtcView || { conn: 'idle', agent: 'unknown' };
        const sharing = ['starting', 'waiting', 'connecting', 'live', 'lost'].includes(v.conn);
        $('liveShare').textContent = (SHARE_TEXT[v.conn] || v.conn)
            + (v.relay === false && (v.conn === 'lost' || (v.conn === 'connecting' && v.connectSlow)) ? ' (no relay server set up: see RAILWAY.md)' : '');
        // In the desktop app the agent reports straight to this window, so the label updates the instant it changes
        const da = STATE.desktopAgent;
        let agentState = v.agent, policyName = v.policy;
        const daMine = !!da && (da.taskId == null || da.taskId === live.taskId);   // a status about another task never drives this bar
        if (daMine && da.phase !== 'stopped' && ['unknown', 'offline'].includes(agentState)) { agentState = da.uiState; policyName = policyName || da.policy; }
        if (v.stopped && ['unknown', 'offline'].includes(agentState)) agentState = 'stopped';
        $('liveAgent').textContent = (AGENT_TEXT[agentState] || agentState).replace('the approved app', live.process || 'the approved app')
            + (policyName && !['unknown', 'offline', 'starting', 'error', 'stopped'].includes(agentState) ? ` (policy: ${policyName}${policyName === '(app only)' ? ', no folder policy found' : ''})` : '')
            + ((agentState === 'error' || agentState === 'waiting' || agentState === 'stopped') && daMine && da.detail ? `: ${da.detail}` : '')
            + (agentState === 'view-only' && da && da.inputReason ? `: ${da.inputReason}` : '')
            + (!ScopeDeskDesktop.available && ['unknown', 'offline'].includes(agentState) ? ' (you are in a web browser: open the ScopeDesk desktop app so the vendor can control this PC)' : '')
            // Why it is not running (a refused start, or the last reason the agent stopped), so nothing fails silently
            + (ScopeDeskDesktop.available && ['unknown', 'offline'].includes(agentState) ? (STATE.agentStartError ? `: ${STATE.agentStartError}` : (daMine && da.detail ? ` (last stop: ${da.detail})` : ' (press "Start remote control")')) : '');
        $('btnPairAgent').classList.toggle('hidden', !ScopeDeskDesktop.available);   // browsers cannot control the PC: desktop app only
        if (ScopeDeskDesktop.available) {
            // ONE authoritative state: the desktop app's agent status for this task (sequence-numbered, deduplicated in desktop-bridge.js)
            const agentOn = daMine && da.taskId === live.taskId && ['starting', 'connected', 'running'].includes(da.phase);
            $('btnPairAgent').textContent = agentOn ? 'Stop remote control' : 'Start remote control';
            $('btnPairAgent').disabled = remoteBusy;       // one operation at a time: a second click while one is in flight does nothing
        }
        $('btnShareScreen').classList.toggle('hidden', sharing);
        if ($('btnSwitchScreen')) $('btnSwitchScreen').classList.toggle('hidden', !(sharing && desktopApi));
        if (sharing && currentShareKind() === 'window') $('liveShare').textContent += ' (one window only)';
        else if (sharing && currentShareKind() === 'screen') $('liveShare').textContent += ' (entire screen)';
    }

    // ---------- CONTROL CHECK (vendor): every link between your mouse and the client's PC, with the fix for the broken one ----------
    const OS_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', other: 'another system' };
    const OS_FIX = {
        darwin: 'On the client\'s Mac: System Settings > Privacy & Security > Accessibility, switch ScopeDesk ON (also under Screen Recording), then quit and reopen ScopeDesk.',
        linux: 'The client\'s Linux PC must use an "Ubuntu on Xorg" (X11) session: Wayland blocks remote mouse and keyboard. Log out, pick Xorg on the login screen, log in again.',
        win32: 'If the app on the client\'s PC runs "as administrator", Windows blocks remote input into it. Ask the client to open it normally, or to run ScopeDesk as administrator too.'
    };
    function controlChecks(v) {
        const d = v.hostDiag || null;
        const rows = [];
        const add = (state, title, text) => rows.push({ state, title, text: text || '' });
        const pathText = { local: 'same network', direct: 'direct internet link', relay: 'through the relay server', server: 'through the ScopeDesk server (slower)' }[v.path] || '';
        if (v.conn === 'live') add('ok', "Client's screen is live", pathText);
        else if (v.conn === 'connecting' || v.conn === 'starting' || v.conn === 'lost') add('wait', 'Connecting to the client\'s screen...', v.connectSlow ? 'Taking long: the two networks may block a direct link. The server relay takes over by itself.' : '');
        else { add('wait', 'Waiting for the client to share the screen', 'The client clicks "Share my screen" in the ScopeDesk app.'); return rows; }
        if (v.stopped) { add('bad', 'The client stopped remote control', 'You can only watch until the client presses "Start remote control" again.'); return rows; }
        if (['offline', 'unknown'].includes(v.agent) || !v.agent) {
            add('bad', 'Remote control is not started on the client\'s PC', 'The client must use the ScopeDesk DESKTOP app (not a web browser) and press "Start remote control". A browser can show the screen but can never be controlled.');
            return rows;
        }
        add('ok', `ScopeDesk is running on the client's PC${d ? ' (' + (OS_NAME[d.os] || d.os) + ')' : ''}`);
        if (d) {
            if (d.inputReady) add('ok', "The client's PC accepts your mouse and keyboard");
            else add('bad', "The client's PC is refusing remote input", [d.inputReason, OS_FIX[d.os]].filter(Boolean).join(' '));
            if (d.share === 'window-only') add('bad', 'Only one window is shared, and this PC cannot locate it', 'Ask the client to share the Entire Screen.');
            else add('ok', d.share === 'window' ? 'One window is shared (your clicks are placed on it)' : 'The entire screen is shared');
        } else if (v.agent === 'view-only') add('bad', "The client's PC is not allowing control", 'Ask the client to open Help > Save diagnostics report in the ScopeDesk app.');
        if (v.agent === 'armed') add('ok', 'An approved app is in front', d && d.apps && d.apps.length ? `Allowed: ${d.apps.filter((a) => !/^scopedesk$/i.test(a)).join(', ')}` : '');
        else if (v.agent === 'waiting') add('bad', 'No approved app is in front on the client\'s PC', (d && d.detail ? d.detail.replace(/^waiting: /, '') + ' ' : '') + 'Click the approved app in the picture, or ask the client to open it. Need another app? Use "Request additional access".');
        else if (v.agent === 'locked') add('bad', 'Control is locked after a scope alert', 'Only the client can decide what happens next.');
        // what the client's PC did with your last actions (clicks, keys, scrolls)
        if (d && (d.applied || d.refused)) {
            const refusedLast = d.refused && (d.lastApplied < 0 || (d.lastRefused >= 0 && d.lastRefused <= d.lastApplied));
            if (refusedLast) add('bad', 'Your last action was refused on the client\'s PC', d.refusal);
            else add('ok', `Your actions are applied on the client's PC (${d.applied})`, d.refused ? `${d.refused} refused earlier: ${d.refusal}` : '');
        } else if (v.agent === 'armed' || v.agent === 'waiting') add('wait', 'Click inside the remote screen to take control', 'Then click the approved app and type. Your clicks and keys appear on the client\'s screen.');
                if (v.input === 'channel') add('ok', 'Your input goes straight to the client\'s PC');
        else if (v.input === 'relay') add('ok', 'Your input goes through the ScopeDesk server', 'Works everywhere, a little slower than a direct link.');
        else add('bad', 'Your input has no way to the client\'s PC', 'Check your internet connection; the page reconnects by itself.');
        return rows;
    }
    let ccSig = '';
    function renderControlCheck(v) {
        const list = $('controlCheckList'); if (!list) return;
        const rows = controlChecks(v || {});
        const sig = JSON.stringify(rows);
        if (sig === ccSig) return;
        ccSig = sig;
        list.replaceChildren(...rows.map((r) => {
            const li = document.createElement('li'); li.className = `cc-item cc-${r.state}`;
            const ico = document.createElement('span'); ico.className = 'cc-ico'; ico.setAttribute('aria-hidden', 'true');
            const body = document.createElement('div');
            const t = document.createElement('strong'); t.textContent = r.title; body.append(t);
            if (r.text) { const p = document.createElement('p'); p.textContent = r.text; body.append(p); }
            li.append(ico, body); return li;
        }));
    }
    function controlReport() {
        const v = STATE.rtcView || {};
        const d = v.hostDiag || {};
        return ['ScopeDesk control check', `Build: ${window.SCOPEDESK_BUILD || '-'}`, `Vendor OS: ${navigator.platform || navigator.userAgent}`,
            `Ticket: ${STATE.live ? STATE.live.taskId : '-'}`, `Screen: ${v.conn} via ${v.path || '-'}`, `Client agent: ${v.agent}`, `Input path: ${v.input}`,
            `Client OS: ${d.os || '-'}; input ready: ${d.inputReady}; reason: ${d.inputReason || '-'}; shared: ${d.share || '-'}`, `Front app: ${d.detail || '-'}`, '',
            ...controlChecks(v).map((r) => `[${r.state === 'ok' ? 'OK' : r.state === 'bad' ? 'PROBLEM' : '...'}] ${r.title}${r.text ? ' - ' + r.text : ''}`)].join('\n');
    }

    function renderVendorState(v) {
        renderControlCheck(v);
        const stage = $('remoteStage'), waitCard = $('remoteWaiting'), overlay = $('remoteOverlay'), badge = $('emulatorStatusBadge');
        const proc = (STATE.live && STATE.live.process) || 'the approved app';
        let msg = null, b = '', warn = false;
        const showStage = v.conn === 'live' || v.conn === 'lost'; // the screen area exists only while a stream is (or just was) live

        if (v.halted === 'violation' && v.locked) { msg = ['Locked out', 'Your access ended after a security violation. It cannot be restored in this session.']; b = 'Locked out'; warn = true; }
        else if (v.halted === 'violation') { msg = ['Control suspended', 'An app outside the approved scope was detected. The client has been alerted and decides what happens next.']; b = 'Control suspended'; warn = true; }
        else if (v.conn === 'live') {
            if (v.stopped) { b = 'Live view only. The client stopped remote control'; warn = true; }
            else if (v.agent === 'armed' && v.input === 'none') { b = 'Live. Control not ready'; warn = true; }
            else if (v.agent === 'armed') b = v.input === 'channel' ? 'Live. Remote control active' : 'Live. Remote control active (via server)';
            else if (v.agent === 'view-only') { b = "Live view only. The client's computer is not allowing control"; warn = true; }
            else if (v.agent === 'offline' || v.agent === 'unknown') { b = "Live view only. The client's ScopeDesk has not started remote control yet"; warn = true; }
            else if (v.agent === 'waiting') b = `Live. Waiting for the client to open ${proc}`;
            else if (v.agent === 'locked') { b = 'Live. Control locked'; warn = true; }
            else { b = 'Live view only. The client must use the ScopeDesk desktop app to allow control'; warn = true; }
        }
        else if (v.conn === 'lost') { msg = ['Connection lost', 'Trying to reconnect. The timer keeps running.']; b = 'Reconnecting...'; warn = true; }
        else if (v.conn === 'connecting' || v.conn === 'starting') { msg = ['Connecting...', 'The client shared their screen. Setting up the secure connection.']; b = 'Connecting...'; }
        else if (v.conn === 'violation') { msg = ['Locked out', 'An app or folder outside the approved scope was detected. Your access has been revoked.']; b = 'Locked out'; warn = true; }
        else if (v.conn === 'stopped') { msg = ['Screen sharing stopped', 'The client stopped sharing their screen.']; b = 'Sharing stopped'; warn = true; }
        else if (v.conn === 'closed' || v.conn === 'expired') { msg = ['Session closed', 'This session has ended.']; b = 'Closed'; warn = true; }
        else { msg = ['Waiting for the client', 'The client has to click "Share my screen". The remote screen appears here as soon as it is live.']; b = 'Waiting for the client'; }

        const wasHidden = stage.classList.contains('hidden');
        stage.classList.toggle('hidden', !showStage);
        waitCard.classList.toggle('hidden', showStage);
        if (showStage) {
            overlay.classList.toggle('hidden', !msg);
            if (msg) { $('remoteOverlayTitle').textContent = msg[0]; $('remoteOverlayText').textContent = msg[1]; }
            if (wasHidden) { $('remoteVideo').play().catch(() => {}); stage.focus(); }
        } else if (msg) {
            $('remoteWaitTitle').textContent = msg[0]; $('remoteWaitText').textContent = msg[1];
        }
        badge.textContent = '● ' + b;
        badge.classList.toggle('text-green', !warn);
        badge.classList.toggle('text-amber', warn);
        stage.classList.toggle('control-on', v.conn === 'live' && v.agent === 'armed' && !v.halted && !v.stopped);
    }

    // The vendor's "Remote Desktop" menu entry exists only while a session is running
    function syncVendorNav() {
        if (!STATE.user || STATE.user.role !== 'vendor') return;
        $('navSessionLink').classList.toggle('hidden', !STATE.live);
    }

    // CLIENT: the desktop app reported a scope violation. This appears at once, before any server round trip, and covers the page.
    // The server alert (violation modal + banner with Terminate / Resume) follows underneath; "Review" reveals it.
    // The desktop app reports the breach locally first; show the same overlay (only if the Client left alerts on).
    function showLocalLockScreen(v) {
        const on = v.halted === 'violation' && !!v.lockout;
        if (!on) return;
        if (STATE.live && !alertsEnabledFor(STATE.live.taskId)) return;
        const d = v.lockout || {};
        if (!terminationOverlay.hidden) return;        // already showing (the server alert has the full details)
        showTerminationOverlay({ taskId: STATE.live ? STATE.live.taskId : null, taskTitle: STATE.live && STATE.live.title, vendor: STATE.live && STATE.live.vendor, kind: d.kind, processName: d.processName, detail: d.detail });
    }

    // The vendor sent a file (only possible into the task's approved folders). The Client always sees where it went.
    ScopeDeskRTC.onFileResult((r) => {
        if (!STATE.user || STATE.user.role !== 'client') return;
        if (r.ok) toast(`The vendor sent "${r.name}". It was saved in ${r.folder}.`);
        else toast(`A file from the vendor was refused: ${r.error}`, true);
    });
    ScopeDeskRTC.init({
        api: (path) => api(path),
        isClient: () => !!(STATE.user && STATE.user.role === 'client'),
        onPermission: () => syncAlertsButton(),
        onChange: (v) => {
            STATE.rtcView = v;
            try { ScopeDeskWorkspace.onRtc(); } catch (_) { /* workspace not loaded */ }
            if (STATE.user && STATE.user.role === 'client') showLocalLockScreen(v);
            if (STATE.user && STATE.user.role === 'vendor') renderVendorState(v); else renderLiveBar();
        }
    });

    // ----- Client: share screen (user gesture), pair agent, terminate -----
    // The ScopeDesk desktop app shares the main screen directly; only a browser shows a picker the Client must operate
    // The share dialog follows the Client's choice in Remote Connection: "Specific Window Only" (private default) or "Entire Screen"
    const shareMode = () => (window.ScopeDeskShareMode ? ScopeDeskShareMode.get() : 'screen');
    function syncShareHelp() {
        const desktopApp = !!(window.scopedeskDesktop && window.scopedeskDesktop.isDesktop);
        const win = shareMode() === 'window';
        if ($('sharePickerHelp')) {
            $('sharePickerHelp').hidden = desktopApp;
            $('sharePickerHelp').textContent = win
                ? 'Your browser will ask what to share: open the "Window" tab and click the one window the vendor may see. Whole screens are hidden, and a whole screen is refused if picked.'
                : 'Your browser will ask what to share: choose "Entire screen" and click the picture of your screen.';
        }
        if ($('shareDesktopHelp')) {
            $('shareDesktopHelp').hidden = !desktopApp;
            $('shareDesktopHelp').textContent = win
                ? 'Click the one window the vendor may see below. The rest of your desktop stays private.'
                : 'Click the screen to share below.';
        }
        if ($('shareWhat')) $('shareWhat').textContent = win ? 'one window you choose' : 'your entire screen';
        document.querySelectorAll('#shareModeSeg [data-share-mode]').forEach((b) => {
            const on = b.dataset.shareMode === shareMode();
            b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on));
        });
        if ($('btnConfirmShare')) $('btnConfirmShare').textContent = win ? 'Share this window' : 'Share my screen';
    }
    document.querySelectorAll('#shareModeSeg [data-share-mode]').forEach((b) => b.addEventListener('click', () => { if (window.ScopeDeskShareMode) ScopeDeskShareMode.set(b.dataset.shareMode); }));
    if (window.ScopeDeskShareMode) ScopeDeskShareMode.onChange(() => {
        syncShareHelp();
        if ($('shareModal').classList.contains('open')) { pickedSource = null; loadSources(); }
        renderLiveBar();
        try { ScopeDeskWorkspace.onRtc(); } catch (_) { /* workspace not loaded */ }
    });
    // The approval dialog lists everything the Client approves: vendor, task, approved apps, duration
    function fillShareScope(taskId, apps, minutes) {
        const t = STATE.tasks.find((x) => x.id === taskId) || {};
        const list = (apps && apps.length) ? apps : listOf(t.allowed_apps);
        if ($('shareApps')) $('shareApps').textContent = list.length ? list.join(', ') : (t.target_process || 'the approved app');
        if ($('shareDuration')) $('shareDuration').textContent = (minutes || t.duration_minutes) ? `${minutes || t.duration_minutes} minutes` : 'the approved window';
        if ($('shareTask')) $('shareTask').textContent = t.title || (STATE.live && STATE.live.title) || 'this task';
    }
    // SCREEN / WINDOW PICKER (desktop app). Electron has no built-in picker, so the dialog shows tiles for every screen and window
    // (ScopeDesk itself excluded). Clicking a tile tells the desktop app what to offer; the Share click then captures exactly that
    // (the choice is made BEFORE the Share click, so that click stays a fresh gesture for the capture).
    //   screen -> remote control allowed (the host agent maps the vendor's pointer onto that screen)
    //   window -> watch only (the host agent turns input off and both screens say why)
    var desktopApi = window.scopedeskDesktop && window.scopedeskDesktop.isDesktop && typeof window.scopedeskDesktop.listSources === 'function' ? window.scopedeskDesktop : null;
    var displays = [];             // screens only (var: renderLiveBar, declared earlier, may run before this line)
    var pickedSource = null;       // var: renderLiveBar (via currentShareKind) may run before this line
    async function selectSource(src) {
        pickedSource = src;
        document.querySelectorAll('#sharePicker button.tile').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === src.id)));
        const note = $('sharePickerNote');
        if (note) note.textContent = src.type === 'window' ? 'One window: the vendor sees and controls only this window (it is brought to the front when the vendor clicks it). The approved-app rules still apply.' : '';
        try { await desktopApi.selectSource(src); } catch (_) { /* the main screen is used */ }
    }
    async function loadSources() {
        const box = $('sharePicker');
        if (!desktopApi || !box) return [];
        let list = [];
        try { list = (await desktopApi.listSources()) || []; } catch (_) { list = []; }
        displays = list.filter((x) => x.type === 'screen');
        const group = (title, items) => {
            if (!items.length) return [];
            const h = document.createElement('h4'); h.textContent = title;
            const grid = document.createElement('div'); grid.className = 'tiles';
            items.forEach((src) => {
                const b = document.createElement('button');
                b.type = 'button'; b.className = 'tile'; b.dataset.id = src.id; b.setAttribute('aria-pressed', 'false');
                if (src.thumbnail) { const img = document.createElement('img'); img.alt = ''; img.src = src.thumbnail; b.appendChild(img); }
                const label = document.createElement('span'); label.textContent = src.name; label.title = src.name; b.appendChild(label);
                b.addEventListener('click', () => selectSource(src));
                grid.appendChild(b);
            });
            return [h, grid];
        };
        const win = shareMode() === 'window';
        const windows = list.filter((x) => x.type === 'window');
        // Window mode lists windows only and selects NOTHING by itself: a window is shared only after the Client clicks it
        // (the desktop app would otherwise fall back to the main screen). Screen mode lists screens only.
        box.replaceChildren(...(win ? group('Pick the window to share', windows) : group('Pick the screen to share', displays)));
        box.hidden = (win ? windows : displays).length === 0;
        const keep = pickedSource && list.find((x) => x.id === pickedSource.id && x.type === (win ? 'window' : 'screen'));
        if (!keep) pickedSource = null;
        const first = keep || (win ? null : (displays.find((d) => d.primary) || displays[0]));
        if (first) await selectSource(first);
        else if ($('sharePickerNote')) $('sharePickerNote').textContent = win ? (windows.length ? 'Click a window above. Nothing is shared until you do.' : 'No windows found. Open the app the vendor should work in, then press Share again.') : '';
        renderLiveBar();
        return list;
    }
    function openShareModal(d) {
        if (STATE.user.role !== 'client') return;
        syncShareHelp();
        loadSources();
        fillShareScope(d.taskId, d.allowedApps, d.durationMinutes || d.duration);
        $('shareVendor').textContent = d.vendor || 'The vendor';
        $('shareProcess').textContent = d.targetProcess || 'the approved app';
        $('shareError').classList.add('hidden');
        $('shareModal').classList.add('open');
    }
    async function shareNow() {
        if (!STATE.live) return toast('There is no active session to share.', true);
        // Window mode in the desktop app: a window must be clicked first (privacy: never fall back to the whole screen)
        if (desktopApi && shareMode() === 'window' && !(pickedSource && pickedSource.type === 'window')) {
            $('shareError').textContent = 'Click the window you want to share first. Nothing has been shared.';
            $('shareError').classList.remove('hidden');
            return;
        }
        // Already sharing ("Change what I share"): swap the picture on the live connection, no reconnect
        const cur = ScopeDeskRTC.current();
        if (cur.role === 'host' && cur.taskId === STATE.live.taskId) {
            try { await ScopeDeskRTC.switchScreen(); $('shareModal').classList.remove('open'); STATE.shareKind = shareMode(); toast(shareMode() === 'window' ? 'Now sharing one window only.' : 'Now sharing your entire screen.'); }
            catch (err) { $('shareError').textContent = `Could not change what is shared: ${err.message}`; $('shareError').classList.remove('hidden'); }
            return;
        }
        try {
            await ScopeDeskRTC.startHost(STATE.live.taskId);
            STATE.shareKind = shareMode();
            $('shareModal').classList.remove('open');
            // Pressing "Share my screen" in this dialog IS the Client's approval of the vendor, the task, control of mouse and keyboard
            // and the time window (the dialog lists all of them). Remote control starts now, once, and never by itself afterwards.
            startDesktopAgent(true);
        } catch (err) {
            $('shareError').textContent = err.message;
            $('shareError').classList.remove('hidden');
            $('shareModal').classList.add('open');
        }
    }
    // What is REALLY being shared right now: from the capture itself when the engine reports it, else from the desktop picker
    function currentShareKind() {
        const v = STATE.rtcView || {};
        if (!['waiting', 'connecting', 'live', 'lost'].includes(v.conn)) return null;
        if (v.shareSurface === 'monitor') return 'screen';
        if (v.shareSurface === 'window' || v.shareSurface === 'browser') return 'window';
        if (pickedSource) return pickedSource.type === 'window' ? 'window' : 'screen';
        return STATE.shareKind || v.shareMode || null;
    }
    // Opens the share dialog: to start sharing, or (while sharing) to change what is shared / switch the mode
    function openShareDialog() {
        if (!STATE.live) return toast('There is no live session yet. When a vendor accepts your ticket, you can share from here.', true);
        syncShareHelp(); loadSources();
        fillShareScope(STATE.live.taskId, null, STATE.live.durationMinutes);
        $('shareError').classList.add('hidden');
        $('shareProcess').textContent = STATE.live.process; $('shareVendor').textContent = STATE.live.vendor;
        $('shareModal').classList.add('open');
    }
    $('btnConfirmShare').addEventListener('click', shareNow);
    if ($('btnSwitchScreen')) $('btnSwitchScreen').addEventListener('click', () => { syncShareHelp(); loadSources(); $('shareError').classList.add('hidden'); $('shareModal').classList.add('open'); });
    $('btnShareScreen').addEventListener('click', openShareDialog);
    $('btnLiveTerminate').addEventListener('click', () => { if (STATE.live && confirm('End the session now? The vendor is disconnected immediately.')) terminateTask(STATE.live.taskId); });

    $('btnEnableAlerts').addEventListener('click', async () => {
        try { await Notification.requestPermission(); } catch (_) { /* unsupported */ }
        syncAlertsButton();
    });
    // One button in the desktop app starts or stops remote control. There is no pairing dialog and nothing to copy.
    // The label follows the real state (STATE.desktopAgent, from the desktop app); this handler only sends the request.
    $('btnPairAgent').addEventListener('click', async () => {
        if (!STATE.live || !ScopeDeskDesktop.available || remoteBusy) return;
        const da = STATE.desktopAgent;
        const taskId = STATE.live.taskId;
        const running = !!da && da.taskId === taskId && ['starting', 'connected', 'running'].includes(da.phase);
        setRemoteBusy(true);
        try {
            if (running) {
                await ScopeDeskDesktop.stopAgent();                   // Stop: this PC refuses further input at once, never restarted by itself
                const r = await sendControlDecision(taskId, 'stop');  // server refuses relayed input, vendor screen updates, reason recorded
                if (!r.ok) toast(`Remote control is off on this computer, but the server was not told: ${r.error}`, true);
            } else await startDesktopAgent(true);                     // Start: only the Client's click gets here
        } finally {
            // the real state arrives from the desktop app; the busy lock is released by that event (or after 4 s)
        }
    });

    // Vendor: ask the client's PC to open a folder. The client's agent checks it against the approved folders (case-insensitive).
    $('btnOpenFolder').addEventListener('click', () => {
        const input = $('openFolderPath');
        const folder = input.value.trim();
        if (!folder) return toast('Type the folder you want to open.', true);
        if (viewportWin && !viewportWin.closed) { viewportWin.postMessage({ t: 'scopedesk-open-folder', path: folder }, window.location.origin); return; }   // the workspace window has the live link
        if (ScopeDeskRTC.openFolder(folder)) toast('Request sent. The client\'s computer checks it against the approved scope.');
        else toast('Not connected to the client\'s screen yet.', true);
    });
    $('openFolderPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('btnOpenFolder').click(); } });

    // ================= 8. STARTUP =================
    ScopeDeskStatus.configure({
        getBase: () => API_BASE || '',
        liveSession: () => !!STATE.live
    });
    ScopeDeskStatus.onChange((online) => {
        if (!online) return;
        if (!apiResolved || (API_BASE !== '' && !STATE.user)) { redirectToServerIfNeeded(); return; } // server came up while on Live Server
        if (STATE.user) loadTasks();
    });

    async function init() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('reset')) history.replaceState({}, '', window.location.pathname);   // old emailed reset links no longer exist: reset codes are typed in on this page
        setAuthMode('signin');

        // If this page was opened from Live Server / a file, jump to the real ScopeDesk address.
        // (Live Server reloads the page whenever the database file changes, which made the app "glitch back to login".)
        if (await redirectToServerIfNeeded()) return;
        ScopeDeskStatus.start(); // background health loop; begins only after the server address is known

        const saved = sessionStorage.getItem(TOKEN_KEY);
        if (!saved) return;

        authContainer.classList.add('hidden'); // no login-screen flash while the saved login is checked
        STATE.authToken = saved;
        try {
            const { user } = await api('/api/auth/me');
            STATE.user = { id: user.id, username: user.username, role: user.role };
            bootApplication();
        } catch (_) {
            sessionStorage.removeItem(TOKEN_KEY);
            STATE.authToken = null;
            authContainer.classList.remove('hidden');
        }
    }

    async function redirectToServerIfNeeded() {
        await resolveApiBase();
        if (!apiResolved) { ScopeDeskStatus.reportDown(); return false; } // verified by the monitor before any banner shows
        if (API_BASE === '') return false;                                   // already served by ScopeDesk
        window.location.replace(API_BASE + '/' + window.location.search);
        return true;
    }

    // After a reload, a vendor returns straight to the live session they had open
    async function restoreVendorSession(lastPanel) {
        if (!STATE.user || STATE.user.role !== 'vendor' || lastPanel !== 'sessionMonitorPanel') return;
        const live = STATE.tasks.find((t) => t.status === 'active' && t.session_status === 'active');
        if (live && !STATE.session) openVendorSession({ id: live.session_id }, live);
    }
    init();
});

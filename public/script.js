window.SCOPEDESK_BUILD = '2026-10-24-b';
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

    let authMode = 'signin'; // 'signin' | 'signup' | 'forgot' | 'reset'
    let selectedRole = 'client';
    let resetToken = null;

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
            throw new Error(data.error || `The server answered with status ${response.status} but not from ScopeDesk. Check the server address in app-config.json.`);
        }
        return data;
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
    function showAuthSuccess(message, linkHref) {
        authError.classList.add('hidden');
        authSuccess.textContent = message;
        if (linkHref) {
            authSuccess.appendChild(document.createElement('br'));
            const a = document.createElement('a');
            a.href = linkHref;
            a.textContent = 'Email is not set up on this server yet. Open the reset link here instead';
            authSuccess.appendChild(a);
        }
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
            authFormSubtitle.textContent = 'Enter your account email and we will send you a reset link.';
        } else if (mode === 'reset') {
            authFormTitle.textContent = 'Choose a new password';
            authFormSubtitle.textContent = 'Use at least 8 characters.';
        }
    }

    btnSwitchAuthMode.addEventListener('click', () => setAuthMode(authMode === 'signup' ? 'signin' : 'signup'));
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

    async function doLogin(username, password) {
        const data = await api('/api/auth/login', { method: 'POST', auth: false, body: { username, password } });
        sessionStorage.setItem(TOKEN_KEY, data.token);
        STATE.authToken = data.token;
        STATE.user = { id: data.user.id, username: data.user.username, role: data.user.role };
        bootApplication();
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

                await api('/api/auth/signup', { method: 'POST', auth: false, body: { username, email, password, role: selectedRole, organization: null } });
                await doLogin(username, password); // account created -> signed in automatically
            } else {
                await doLogin(username, password);
            }
        } catch (err) {
            showAuthError(err.message);
        } finally {
            updateSubmitState();
            if (authMode === 'signin') btnSubmitAuth.disabled = false;
        }
    });

    forgotForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthMessages();
        const email = $('forgotEmail').value.trim();
        if (!email) return showAuthError('Please enter your email address.');
        try {
            const data = await api('/api/auth/forgot-password', { method: 'POST', auth: false, body: { email } });
            showAuthSuccess(data.message, data.devResetLink);
        } catch (err) {
            showAuthError(err.message);
        }
    });

    resetForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthMessages();
        const password = $('resetPassword').value;
        if (password.length < 8) return showAuthError('Password must be at least 8 characters long.');
        try {
            const data = await api('/api/auth/reset-password', { method: 'POST', auth: false, body: { token: resetToken, password } });
            history.replaceState({}, '', window.location.pathname);
            resetToken = null;
            $('resetPassword').value = '';
            setAuthMode('signin');
            showAuthSuccess(data.message);
        } catch (err) {
            showAuthError(err.message);
        }
    });

    function logout(message) {
        clearLive();
        teardownRemoteConnection();
        if (STATE.socket) { STATE.socket.disconnect(); STATE.socket = null; }
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem('scopedesk_panel');
        Object.assign(STATE, { user: null, authToken: null, tasks: [], vendors: [], session: null, pendingViolation: null, live: null });
        closeViolationModal();
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
        routeToPanel(isClient ? 'clientDashboardPanel' : 'vendorDashboardPanel');
        $('navOverviewLink').setAttribute('data-target', isClient ? 'clientDashboardPanel' : 'vendorDashboardPanel');

        connectSocket();
        loadTasks().then(() => restoreVendorSession(lastPanel));
        if (isClient) loadVendors();
    }

    function routeToPanel(panelId) {
        sessionStorage.setItem('scopedesk_panel', panelId);
        paneViews.forEach((p) => p.classList.add('hidden'));
        const node = $(panelId);
        if (node) node.classList.remove('hidden');
        navItems.forEach((item) => {
            const target = item.getAttribute('data-target');
            const isOverview = item.id === 'navOverviewLink' && (panelId === 'clientDashboardPanel' || panelId === 'vendorDashboardPanel');
            item.classList.toggle('active', target === panelId || isOverview);
        });
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
            socket.on('session-connected', async (d) => {
                await loadTasks();
                if (d.windowEnd) STATE.clockOffset = d.serverTime - Date.now();
                openShareModal(d); // sharing needs a click, so ask for it right away
            });
            socket.on('session-ended', (d) => {
                if (STATE.live && STATE.live.taskId === d.taskId) clearLive();
                if (STATE.pendingViolation && STATE.pendingViolation.taskId === d.taskId) closeViolationModal();
                // These are about ONE task. Your own login stays active.
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
            socket.on('task-request', (d) => { if (!d.replay) toast(`New support request from ${d.client}: ${d.title}`); loadTasks(); });
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
        try {
            if (!('Notification' in window) || Notification.permission !== 'granted') return;
            const n = new Notification('ScopeDesk: access terminated', {
                body: `${alert.vendor || 'The vendor'}: ${alert.what || alert.processName || 'out-of-scope activity'}. Open ScopeDesk to terminate access.`,
                tag: 'scopedesk-violation', requireInteraction: true
            });
            n.onclick = () => { window.focus(); n.close(); };
        } catch (_) { /* the on-page alert still shows */ }
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

    function terminateTask(taskId, onDone) {
        ScopeDeskRTC.stop('closed'); // hang up and stop every capture track right now; do not wait for the server's answer
        STATE.socket.emit('terminate-session', { taskId }, (res) => {
            if (res && res.ok) {
                toast('Session ended. The vendor has been disconnected.');
            } else {
                toast((res && res.error) || 'Could not terminate the session.', true);
            }
            if (onDone) onDone(res);
            loadTasks();
        });
    }

    // Two places offer the same decision: the alert dialog and the persistent banner on the dashboard
    function terminateFromAlert() {
        if (!STATE.pendingViolation) return;
        terminateTask(STATE.pendingViolation.taskId, closeViolationModal);
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
        } catch (err) {
            if (err.message !== 'Session expired.') toast(err.message, true);
        }
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
                    <td class="bold">${esc(t.title)}<br><small>${esc(t.target_process)}${t.task_type ? ' · ' + esc(t.task_type) : ''}${t.allowed_paths || t.allowed_apps ? ' · custom scope' : ''}</small></td>
                    <td>${esc(t.vendor_name)}</td>
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
                    <td class="bold">${esc(t.title)}<br><small>${esc(t.target_process)}${t.task_type ? ' · ' + esc(t.task_type) : ''}${t.allowed_paths || t.allowed_apps ? ' · custom scope' : ''}</small></td>
                    <td>${esc(t.client_org || 'Client')}</td>
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
                openVendorSession(data.session, data.task);
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
    // Task types come from the policy file (case does not matter anywhere). The category in brackets after the scope,
    // e.g. "... (Billing)", pre-fills the task type when it matches a known type, so the field is not left empty by accident.
    let policyTypes = [], typeAutoFilled = false;
    const norm = (s) => String(s || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    async function loadPolicyTypes() {
        try {
            const data = await api('/api/policy-types');
            policyTypes = data.types || [];
            $('taskTypeList').textContent = '';
            policyTypes.forEach((t) => { const o = document.createElement('option'); o.value = t; $('taskTypeList').appendChild(o); });
            $('taskTypeHint').textContent = data.validated
                ? `Available: ${policyTypes.join(', ') || 'none'}. Upper or lower case does not matter. Empty means the approved app only.`
                : 'The server cannot read agent/policies.json, so this is checked by the host agent. Upper or lower case does not matter.';
        } catch (_) { /* the status banner explains an unreachable server */ }
    }
    function suggestTaskType() {
        const label = $('taskName').options[$('taskName').selectedIndex].text;
        const m = label.match(/\(([^)]+)\)\s*$/);
        const hit = m && policyTypes.find((t) => norm(t) === norm(m[1]));
        if (hit && (!$('taskType').value || typeAutoFilled)) { $('taskType').value = hit; typeAutoFilled = true; }
        else if (typeAutoFilled) { $('taskType').value = ''; typeAutoFilled = false; }
    }
    // "Custom task..." lets the Client describe any task; its scope then comes from the folders/apps fields (and/or a task type)
    function syncCustomTitle() {
        const custom = $('taskName').value === '__custom__';
        $('customTitleGroup').classList.toggle('hidden', !custom);
        $('customTitle').required = custom;
        if (custom) $('customTitle').focus();
    }
    $('taskName').addEventListener('change', () => { syncCustomTitle(); suggestTaskType(); });
    newTaskForm.addEventListener('reset', () => setTimeout(syncCustomTitle, 0));
    $('taskType').addEventListener('input', () => { typeAutoFilled = false; });

    $('btnOpenTaskModal').addEventListener('click', async () => {
        populateVendorSelect();
        taskModal.classList.add('open');
        await Promise.all([loadVendors(), loadPolicyTypes()]); // refresh vendor accounts and task types
        suggestTaskType();
    });
    $('btnCloseModal').addEventListener('click', () => { taskModal.classList.remove('open'); newTaskForm.reset(); });

    newTaskForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const { task } = await api('/api/tasks', {
                method: 'POST',
                body: {
                    title: $('taskName').value === '__custom__' ? $('customTitle').value.trim() : $('taskName').value,
                    target_process: $('taskProcess').value.trim(),
                    task_type: $('taskType').value.trim(),
                    allowed_paths: $('customPaths').value,
                    allowed_apps: $('customApps').value,
                    duration_minutes: Number($('taskWindow').value),
                    assigned_vendor_user_id: Number($('vendorSelect').value) || null
                }
            });
            taskModal.classList.remove('open');
            newTaskForm.reset();
            $('newTokenValue').textContent = task.token;
            $('newTokenNotice').classList.remove('hidden');
            startDesktopAgent(false, task.id);   // desktop app: the background agent gets this ticket's session config over IPC
            loadTasks();
        } catch (err) {
            toast(err.message, true);
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
        const any = document.createElement('option');
        any.value = '';
        any.textContent = 'Any vendor (I will share the token myself)';
        select.appendChild(any);
        STATE.vendors.filter((v) => !v.blocked).forEach((v) => {
            const opt = document.createElement('option');
            opt.value = String(v.user_id);
            opt.textContent = vendorLabel(v);
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
            openVendorSession(data.session, data.task);
            loadTasks();
        } catch (err) {
            tokenErrorFeedback.textContent = '❌ ' + err.message;
            tokenErrorFeedback.classList.remove('hidden');
        }
    });

    function openVendorSession(session, task) {
        STATE.session = { session, task };
        $('lblScopeTask').textContent = task.title;
        $('lblScopeVendor').textContent = STATE.user.username;
        $('lblScopeToken').textContent = `Task #${task.id}`;
        $('lblScopeProcess').textContent = task.target_process;
        $('emulatorWindowTitle').textContent = `Remote screen [Task #${task.id} - ${task.target_process}]`;
        routeToPanel('sessionMonitorPanel');
        STATE.live = { taskId: task.id, title: task.title, process: task.target_process, endMs: Date.parse(task.window_end) };
        syncVendorNav();
        renderVendorState({ conn: 'idle', agent: 'unknown', halted: null }); // stage hidden until the client's screen is live
        tickClocks();
        if (openViewport(task.id)) {
            $('remoteWaitTitle').textContent = 'Your full-screen workspace is open';
            $('remoteWaitText').textContent = 'The remote screen opens in its own window so you have the whole display to work with. Closed it by mistake? Use "Open full-screen workspace".';
        } else {
            // The window could not open: use the screen area inside this page instead
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
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };
    let expiredHandled = null;

    function tickClocks() {
        const live = STATE.live;
        const label = live ? fmt(live.endMs - (Date.now() + STATE.clockOffset)) : '--:--';
        const left = live ? live.endMs - (Date.now() + STATE.clockOffset) : Infinity;
        ['vendorClock', 'liveClock'].forEach((id) => {
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
        STATE.live = null;
        if (ScopeDeskDesktop.available) ScopeDeskDesktop.stopAgent();
        ScopeDeskRTC.stopBridge();
        syncVendorNav();
        tickClocks();
        ScopeDeskRTC.stop('closed');
        renderLiveBar();
    }

    function syncClientLive() {
        const t = STATE.tasks.find((x) => x.status === 'active');
        if (!t) { if (STATE.live) clearLive(); return; }
        STATE.live = { taskId: t.id, title: t.title, vendor: t.vendor_name, process: t.target_process, endMs: Date.parse(t.window_end) };
        syncAlertsButton();
        renderLiveBar();
        startDesktopAgent(false);   // desktop app: start the host agent by itself, nothing to copy or run
    }

    // ---- Desktop app: the host agent is started through the shell, never by hand ----
    let desktopAgentOptOut = null;   // task the Client chose to stop remote control for; not restarted automatically
    function startDesktopAgent(manual, forTaskId) {
        const taskId = forTaskId || (STATE.live && STATE.live.taskId);
        if (!ScopeDeskDesktop.available || !taskId) return Promise.resolve();
        if (!manual && desktopAgentOptOut === taskId) return Promise.resolve();
        if (manual) desktopAgentOptOut = null;
        // The session config goes to the background agent through Electron IPC (ipcRenderer.send('init-session')). No dialog, no command.
        return ScopeDeskDesktop.ensureAgent({
            taskId,
            getToken: async (id) => (await api(`/api/tasks/${id}/agent-token`, { method: 'POST' })).agentToken,   // stays in memory, never shown
            setToken: () => {}
        }).then((r) => { if (r && r.ok === false && r.error !== 'not-desktop') toast(r.error || 'Could not start the host agent.', true); })
          .catch((err) => toast(err.message, true));
    }
    ScopeDeskDesktop.onStatus((st) => { STATE.desktopAgent = st; renderLiveBar(); });

    const AGENT_TEXT = { unknown: 'not running', offline: 'not running', starting: 'starting...', error: 'could not start', waiting: `waiting for the approved app`, armed: 'Active Secured Session', locked: 'locked after a violation' };
    const SHARE_TEXT = { idle: 'not shared', starting: 'choosing screen...', waiting: 'shared, waiting for vendor', connecting: 'connecting...', live: 'live', lost: 'connection lost, retrying', stopped: 'stopped', closed: 'closed', expired: 'closed (time up)', violation: 'cut after a violation' };

    function renderLiveBar() {
        const bar = $('liveBar');
        if (!bar || !STATE.user || STATE.user.role !== 'client') return;
        const live = STATE.live;
        bar.classList.toggle('hidden', !live);
        if (!live) return;
        $('liveTask').textContent = live.title;
        $('liveVendor').textContent = live.vendor || 'vendor';
        const v = STATE.rtcView || { conn: 'idle', agent: 'unknown' };
        const sharing = ['starting', 'waiting', 'connecting', 'live', 'lost'].includes(v.conn);
        $('liveShare').textContent = (SHARE_TEXT[v.conn] || v.conn)
            + (v.relay === false && (v.conn === 'lost' || (v.conn === 'connecting' && v.connectSlow)) ? ' (no relay server set up: see RAILWAY.md)' : '');
        // In the desktop app the agent reports straight to this window, so the label updates the instant it changes
        const da = STATE.desktopAgent;
        let agentState = v.agent, policyName = v.policy;
        if (da && da.phase !== 'stopped' && ['unknown', 'offline'].includes(agentState)) { agentState = da.uiState; policyName = policyName || da.policy; }
        $('liveAgent').textContent = (AGENT_TEXT[agentState] || agentState).replace('the approved app', live.process || 'the approved app')
            + (policyName && !['unknown', 'offline', 'starting', 'error'].includes(agentState) ? ` (policy: ${policyName}${policyName === '(app only)' ? ', no folder policy found' : ''})` : '')
            + (agentState === 'error' && da && da.detail ? `: ${da.detail}` : '')
            + (!ScopeDeskDesktop.available && ['unknown', 'offline'].includes(agentState) ? ' (you are in a web browser: open the ScopeDesk desktop app so the vendor can control this PC)' : '');
        $('btnPairAgent').classList.toggle('hidden', !ScopeDeskDesktop.available);   // browsers cannot control the PC: desktop app only
        if (ScopeDeskDesktop.available) {
            const agentOn = da && ['starting', 'connected', 'running'].includes(da.phase);
            $('btnPairAgent').textContent = agentOn ? 'Stop remote control' : 'Start remote control';
        }
        $('btnShareScreen').classList.toggle('hidden', sharing);
        if (v.shareSurface && v.shareSurface !== 'monitor') {
            $('liveShare').textContent += ' (window only: remote control needs your entire screen)';
        }
    }

    function renderVendorState(v) {
        const stage = $('remoteStage'), waitCard = $('remoteWaiting'), overlay = $('remoteOverlay'), badge = $('emulatorStatusBadge');
        const proc = (STATE.live && STATE.live.process) || 'the approved app';
        let msg = null, b = '', warn = false;
        const showStage = v.conn === 'live' || v.conn === 'lost'; // the screen area exists only while a stream is (or just was) live

        if (v.halted === 'violation' && v.locked) { msg = ['Locked out', 'Your access ended after a security violation. It cannot be restored in this session.']; b = 'Locked out'; warn = true; }
        else if (v.halted === 'violation') { msg = ['Control suspended', 'An app outside the approved scope was detected. The client has been alerted and decides what happens next.']; b = 'Control suspended'; warn = true; }
        else if (v.conn === 'live') {
            if (v.agent === 'armed') b = 'Live. Remote control active';
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
        stage.classList.toggle('control-on', v.conn === 'live' && v.agent === 'armed' && !v.halted);
    }

    // The vendor's "Remote Desktop" menu entry exists only while a session is running
    function syncVendorNav() {
        if (!STATE.user || STATE.user.role !== 'vendor') return;
        $('navSessionLink').classList.toggle('hidden', !STATE.live);
    }

    ScopeDeskRTC.init({
        api: (path) => api(path),
        onChange: (v) => {
            STATE.rtcView = v;
            if (STATE.user && STATE.user.role === 'vendor') renderVendorState(v); else renderLiveBar();
        }
    });

    // ----- Client: share screen (user gesture), pair agent, terminate -----
    function openShareModal(d) {
        if (STATE.user.role !== 'client') return;
        $('shareVendor').textContent = d.vendor || 'The vendor';
        $('shareProcess').textContent = d.targetProcess || 'the approved app';
        $('shareError').classList.add('hidden');
        $('shareModal').classList.add('open');
    }
    async function shareNow() {
        if (!STATE.live) return toast('There is no active session to share.', true);
        try {
            await ScopeDeskRTC.startHost(STATE.live.taskId);
            $('shareModal').classList.remove('open');
        } catch (err) {
            $('shareError').textContent = err.message;
            $('shareError').classList.remove('hidden');
            $('shareModal').classList.add('open');
        }
    }
    $('btnConfirmShare').addEventListener('click', shareNow);
    $('btnShareScreen').addEventListener('click', () => { $('shareError').classList.add('hidden'); $('shareProcess').textContent = STATE.live.process; $('shareVendor').textContent = STATE.live.vendor; $('shareModal').classList.add('open'); });
    $('btnLiveTerminate').addEventListener('click', () => { if (STATE.live && confirm('End the session now? The vendor is disconnected immediately.')) terminateTask(STATE.live.taskId); });

    $('btnEnableAlerts').addEventListener('click', async () => {
        try { await Notification.requestPermission(); } catch (_) { /* unsupported */ }
        syncAlertsButton();
    });
    // One button in the desktop app starts or stops remote control. There is no pairing dialog and nothing to copy.
    $('btnPairAgent').addEventListener('click', async () => {
        if (!STATE.live || !ScopeDeskDesktop.available) return;
        const da = STATE.desktopAgent;
        if (da && ['starting', 'connected', 'running'].includes(da.phase)) { desktopAgentOptOut = STATE.live.taskId; ScopeDeskDesktop.stopAgent(); }
        else await startDesktopAgent(true);
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
        if (params.get('reset')) {
            resetToken = params.get('reset');
            setAuthMode('reset');
            return;
        }
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

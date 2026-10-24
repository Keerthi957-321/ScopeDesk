// Safety net: no form on this page may ever submit natively. A native submit reloads the page and looks like a "logout".
document.addEventListener('submit', (e) => e.preventDefault(), true); sta

document.addEventListener('DOMContentLoaded', () => {

    // Same-origin when this page is served by ScopeDesk (any port); otherwise (Live Server / file) use localhost:3000
    let API_BASE = null;
    async function resolveApiBase() {
        if (API_BASE !== null) return;
        try {
            const r = await fetch('/api/health');
            const d = await r.json();
            if (d && d.app === 'scopedesk') { API_BASE = ''; return; }
        } catch (_) { /* not served by ScopeDesk */ }
        API_BASE = 'http://localhost:3000';
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
        monitorTimer: null,
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
    const serverBanner = $('serverBanner');
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
            response = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        } catch (_) {
            throw new Error('Cannot reach the server. Is "npm start" running?');
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
            throw new Error(data.error || `The server answered with status ${response.status} but not from ScopeDesk. Open http://localhost:3000 in your browser and make sure "npm start" is running.`);
        }
        return data;
    }

    let toastTimer;
    function toast(message, warn = false) {
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
        stopMonitoring();
        teardownRemoteConnection();
        if (STATE.socket) { STATE.socket.disconnect(); STATE.socket = null; }
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem('scopedesk_panel');
        Object.assign(STATE, { user: null, authToken: null, tasks: [], vendors: [], session: null, pendingViolation: null });
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
        $('navSessionLink').classList.toggle('hidden', isClient); // the live monitor screen is the vendor's workspace

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
    function connectSocket() {
        if (STATE.socket) STATE.socket.disconnect();
        // The server reads identity from this signed token. Nothing the browser says about "who I am" is trusted.
        const socket = io(API_BASE || undefined, { auth: { token: STATE.authToken } });
        STATE.socket = socket;

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
            socket.on('session-connected', (d) => { toast(`${d.vendor} connected to your support session.`); loadTasks(); });
            socket.on('session-ended', (d) => {
                if (STATE.pendingViolation && STATE.pendingViolation.taskId === d.taskId) closeViolationModal();
                // These are about ONE task. Your own login stays active.
                if (d.reason === 'time_expired') toast(`Task "${d.title || '#' + d.taskId}" has expired (its time window ended). You are still signed in.`);
                else if (d.reason !== 'client_terminated') toast(d.message || 'Session ended.');
                loadTasks();
            });
        } else {
            // VENDOR receives the kill command (never the alert)
            socket.on('force-terminate', (d) => {
                stopMonitoring();
                teardownRemoteConnection();
                STATE.session = null;
                inputTokenKey.value = '';
                routeToPanel('vendorDashboardPanel');
                toast(`Session closed: ${d.message || 'terminated.'}`, true);
                loadTasks();
            });
            socket.on('task-request', (d) => { toast(`New support request from ${d.client}: ${d.title}`); loadTasks(); });
            socket.on('session-ended', () => loadTasks());
        }
    }

    // Closes the remote-view connection. When you add your WebRTC peer, store it in window.scopedeskPeer
    // (or expose closeRemoteConnection() from your Electron preload) and this will cut it.
    function teardownRemoteConnection() {
        if (window.scopedeskPeer) {
            try { window.scopedeskPeer.close(); } catch (_) { /* already closed */ }
            window.scopedeskPeer = null;
        }
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
        $('violationProcess').textContent = alert.processName || 'unknown';
        violationModal.classList.add('open');
        violationBox.classList.remove('open-shake');
        void violationBox.offsetWidth; // restart shake animation
        violationBox.classList.add('open-shake');
        loadTasks();
    }

    function closeViolationModal() {
        violationModal.classList.remove('open');
        STATE.pendingViolation = null;
    }

    function terminateTask(taskId, onDone) {
        STATE.socket.emit('terminate-session', { taskId }, (res) => {
            if (res && res.ok) {
                toast('Session terminated. The vendor has been disconnected.');
            } else {
                toast((res && res.error) || 'Could not terminate the session.', true);
            }
            if (onDone) onDone(res);
            loadTasks();
        });
    }

    $('btnTerminateNow').addEventListener('click', () => {
        if (!STATE.pendingViolation) return;
        terminateTask(STATE.pendingViolation.taskId, closeViolationModal);
    });
    $('btnDismissViolation').addEventListener('click', closeViolationModal);

    // ================= 5. TASKS (both roles) =================
    async function loadTasks() {
        if (!STATE.user) return;
        try {
            STATE.tasks = (await api('/api/tasks')).tasks;
            renderTasks();
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
                    <td class="bold">${esc(t.title)}<br><small>${esc(t.target_process)}</small></td>
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
                    <td class="bold">${esc(t.title)}<br><small>${esc(t.target_process)}</small></td>
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
    $('btnOpenTaskModal').addEventListener('click', async () => {
        populateVendorSelect();
        taskModal.classList.add('open');
        await loadVendors(); // refresh so newly registered vendor accounts appear
    });
    $('btnCloseModal').addEventListener('click', () => { taskModal.classList.remove('open'); newTaskForm.reset(); });

    newTaskForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const { task } = await api('/api/tasks', {
                method: 'POST',
                body: {
                    title: $('taskName').value,
                    target_process: $('taskProcess').value.trim(),
                    duration_minutes: Number($('taskWindow').value),
                    assigned_vendor_user_id: Number($('vendorSelect').value) || null
                }
            });
            taskModal.classList.remove('open');
            newTaskForm.reset();
            $('newTokenValue').textContent = task.token;
            $('newTokenNotice').classList.remove('hidden');
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
        $('emulatorWindowTitle').textContent = `Isolated Frame Pipeline [Task #${task.id} - ${task.target_process}]`;
        routeToPanel('sessionMonitorPanel');
        startMonitoring();
    }

    // Vendor-side monitoring loop. In the Electron build, expose window.scopedeskNative.getForegroundProcess()
    // from your preload script (returns e.g. "explorer.exe"). A plain browser cannot see other apps, so there it idles.
    function startMonitoring() {
        stopMonitoring();
        STATE.monitorTimer = setInterval(async () => {
            const native = window.scopedeskNative;
            if (!STATE.session || !native || typeof native.getForegroundProcess !== 'function') return;
            try {
                const current = String(await native.getForegroundProcess() || '').toLowerCase();
                const allowed = String(STATE.session.task.target_process).toLowerCase();
                const ignore = ['scopedesk.exe', 'electron.exe', 'electron'];
                if (current && current !== allowed && !ignore.includes(current)) reportViolation(current);
            } catch (_) { /* ignore a failed poll; try again next tick */ }
        }, 2000);
    }
    function stopMonitoring() {
        clearInterval(STATE.monitorTimer);
        STATE.monitorTimer = null;
    }

    // Vendor -> server only. The vendor never sees an alert; the server routes it to the owning client.
    function reportViolation(processName) {
        if (!STATE.session || !STATE.socket) return;
        STATE.socket.emit('vendor-violation', { taskId: STATE.session.task.id, processName }, (res) => {
            if (res && !res.ok) console.warn('Violation report not accepted:', res.error);
        });
    }

    // Demo triggers for the emulator screen (they run the exact same code path as the real monitor)
    $('btnTriggerBreach').addEventListener('click', () => reportViolation('Payroll_Q4.xlsx'));
    $('btnSimulateBreach').addEventListener('click', () => reportViolation('Payroll_Q4.xlsx'));

    // Vendor finishes normally
    $('btnEndSession').addEventListener('click', async () => {
        if (!STATE.session) return;
        try {
            await api(`/api/sessions/${STATE.session.session.id}/complete`, { method: 'POST' });
            stopMonitoring();
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

    // ================= 7. STARTUP =================
    async function checkServerOnline() {
        let online = false;
        try {
            await resolveApiBase();
            const r = await fetch(API_BASE + '/api/health');
            online = (await r.json()).app === 'scopedesk';
        } catch (_) { online = false; }
        if (!online) {
            serverBanner.innerHTML = '<strong>The ScopeDesk server is not running.</strong><br>'
                + 'Windows: double-click <code>start-windows.bat</code>. Mac/Linux: run <code>start-mac-linux.command</code>. '
                + 'Or open a terminal in the project folder and run <code>npm start</code>. This page connects automatically once it is running.';
        }
        serverBanner.classList.toggle('hidden', online);
    }
    checkServerOnline();
    setInterval(checkServerOnline, 4000);

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
        if (API_BASE === '') return false; // already served by ScopeDesk
        try {
            const r = await fetch(API_BASE + '/api/health');
            if ((await r.json()).app === 'scopedesk') {
                window.location.replace(API_BASE + '/' + window.location.search);
                return true;
            }
        } catch (_) { /* server not running: the banner explains it */ }
        return false;
    }

    // After a reload, a vendor returns straight to the live session they had open
    async function restoreVendorSession(lastPanel) {
        if (!STATE.user || STATE.user.role !== 'vendor' || lastPanel !== 'sessionMonitorPanel') return;
        const live = STATE.tasks.find((t) => t.status === 'active' && t.session_status === 'active');
        if (live && !STATE.session) openVendorSession({ id: live.session_id }, live);
    }
    init();
});

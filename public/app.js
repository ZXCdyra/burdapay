const PF = {
  me: null,
  socket: null,

  async api(path, opts = {}) {
    const token = localStorage.getItem('pf_token');
    const res = await fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401) { PF.logout(); throw new Error('Сессия истекла'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      let msg = data.message || res.statusText;
      const fe = data.errors && data.errors.fieldErrors;
      if (fe) {
        const parts = Object.entries(fe).map(([f, v]) => `${f}: ${Array.isArray(v) ? v.join(', ') : v}`);
        if (parts.length) msg += ' (' + parts.join('; ') + ')';
      }
      throw new Error(msg);
    }
    return data;
  },

  async requireRole(role) {
    const token = localStorage.getItem('pf_token');
    if (!token) { location.href = '/'; return null; }
    try { PF.me = await PF.api('/auth/me'); }
    catch { location.href = '/'; return null; }
    if (!PF.me || !PF.me.role) {
      document.body.innerHTML = '<div class="login-wrap"><div class="card login-card"><div class="logo">Pay<span>Flow</span></div><p class="sub">Ошибка профиля: сервер не вернул роль. Перелогиньтесь.</p><button onclick="PF.logout()">На главную</button></div></div>';
      return null;
    }
    if (PF.me.role !== role) { location.href = '/' + PF.me.role.toLowerCase() + '.html'; return null; }
    const badge = document.getElementById('roleBadge');
    if (badge) { badge.textContent = role; badge.className = 'badge ' + role; }
    const who = document.getElementById('whoami');
    if (who) who.textContent = PF.me.email;
    return PF.me;
  },

  logout() {
    localStorage.removeItem('pf_token');
    sessionStorage.removeItem('pf_pk');
    if (PF.socket) PF.socket.disconnect();
    location.href = '/';
  },

  connectWS(handlers = {}) {
    try {
      if (typeof io === 'undefined') { console.warn('socket.io недоступен — live-обновления выключены'); return null; }
      
      // Use polling as primary transport (Render doesn't support WebSocket by default)
      PF.socket = io('/', {
        auth: { token: localStorage.getItem('pf_token') },
        transports: ['polling', 'websocket'], // polling first for compatibility
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
      });
      
      PF.socket.on('connect', () => {
        console.log('✅ WS connected');
        if (handlers.onConnected) handlers.onConnected();
      });
      
      PF.socket.on('connect_error', (err) => {
        console.warn('❌ WS connect error:', err.message);
      });
      
      PF.socket.on('disconnect', (reason) => {
        console.log('🔌 WS disconnected:', reason);
      });
      
      PF.socket.on('order.updated', (o) => handlers.onOrderUpdated && handlers.onOrderUpdated(o));
      PF.socket.on('order.new', (o) => handlers.onNewOrder && handlers.onNewOrder(o));
      PF.socket.on('order.expired', (o) => handlers.onExpired && handlers.onExpired(o));
      PF.socket.on('user.created', (u) => handlers.onUserCreated && handlers.onUserCreated(u));
      PF.socket.on('deposit.request.created', (d) => PF.toast('Новая заявка на пополнение ' + (d.amount || '')));
      PF.socket.on('deposit.request.updated', (d) => PF.toast('Заявка обновлена: ' + d.status));
      return PF.socket;
    } catch (e) { console.warn('WS init failed:', e); return null; }
  },

  toast(msg, ms = 3500) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._tm);
    t._tm = setTimeout(() => (t.style.display = 'none'), ms);
  },

  /* Deposit UI helpers */
  openDeposit() { document.getElementById('depositModal').classList.remove('hidden'); },
  closeDeposit() { document.getElementById('depositModal').classList.add('hidden'); },
  async submitDeposit() {
    const a = Number(document.getElementById('depAmount').value || 0);
    const tx = document.getElementById('depTx').value.trim() || undefined;
    try {
      await PF.api('/trader/me/deposits', { method: 'POST', body: JSON.stringify({ amount: a, txHash: tx }) });
      PF.toast('Заявка создана');
      PF.closeDeposit();
    } catch (e) { alert(e.message); }
  },

  esc(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  },

  money(v) { return Number(v).toLocaleString('ru-RU'); },
  dt(s) { return s ? new Date(s).toLocaleString('ru-RU') : '—'; },

  table(head, rows) {
    if (!rows.length) return '<div class="empty">Пока пусто</div>';
    return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  },

  statCard(title, val, color) {
    return `<div class="card stat"><h3>${title}</h3><div class="val" style="color:${color || 'var(--text)'}">${val}</div></div>`;
  },
};

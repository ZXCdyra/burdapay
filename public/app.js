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
    if (!res.ok) throw new Error(data.message || res.statusText);
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
    sessionStorage.removeItem('pf_sk');
    if (PF.socket) PF.socket.disconnect();
    location.href = '/';
  },

  connectWS(handlers = {}) {
    try {
      if (typeof io === 'undefined') { console.warn('socket.io недоступен — live-обновления выключены'); return null; }
      PF.socket = io('/', { auth: { token: localStorage.getItem('pf_token') } });
      PF.socket.on('order.updated', (o) => handlers.onOrderUpdated && handlers.onOrderUpdated(o));
      PF.socket.on('order.new', (o) => handlers.onNewOrder && handlers.onNewOrder(o));
      PF.socket.on('order.expired', (o) => handlers.onExpired && handlers.onExpired(o));
      PF.socket.on('user.created', (u) => handlers.onUserCreated && handlers.onUserCreated(u));
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

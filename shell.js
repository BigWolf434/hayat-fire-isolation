import { logout } from './api.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (i) => (i ? new Date(i).toLocaleString() : '—');
export const today = () => new Date().toLocaleDateString('en-CA');

export function setStatus(text, cls = 'ok') {
  const el = document.getElementById('statusPill');
  if (el) { el.className = 'pill ' + cls; el.textContent = text; }
}

const ROLE = { officer: 'HSE Officer', manager: 'HSE Manager', admin: 'Administrator' };

export function mountShell(active, me, title, sub) {
  const page = document.getElementById('page');
  const nav = [
    ['dash', '/', '🏠', 'Dashboard'],
    ['tanks', '/tanks.html', '🛢', 'Water Tanks'],
    ['records', '/records.html', '📊', 'Records'],
    ['qr', '/records.html#qr', '🔳', 'Valve QR Codes'],
    ...(me.role === 'admin' ? [['users', '/records.html#users', '👥', 'Users']] : []),
  ];
  const app = document.createElement('div');
  app.className = 'app';
  app.innerHTML = `
    <nav class="side">
      <div class="logo"><span>🍃</span><b>Hayat</b><small>Kimya</small></div>
      <div class="nav">${nav.map(([k, href, ic, t]) => `<a href="${href}" class="${k === active ? 'on' : ''}">${ic} ${t}</a>`).join('')}</div>
      <div class="me"><div class="av">${esc((me.name || '?')[0].toUpperCase())}</div>
        <div><b>${esc(me.name)}</b><small>${ROLE[me.role] || me.role} · Online</small></div></div>
      <button id="btnOut" class="sm">Logout</button>
    </nav>
    <div class="main">
      <header class="top"><div><h1>${title}</h1><small>${sub}</small></div>
        <div class="topr"><span id="statusPill" class="pill ok">Loading…</span><span id="clock" class="muted"></span></div></header>
    </div>`;
  document.body.prepend(app);
  app.querySelector('.main').appendChild(page);
  document.getElementById('btnOut').onclick = logout;
  const tick = () => (document.getElementById('clock').textContent = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
  tick(); setInterval(tick, 30000);
}
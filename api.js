const TOKEN = 'fi_token', USER = 'fi_user';

export const token = () => localStorage.getItem(TOKEN);
export const getUser = () => { try { return JSON.parse(localStorage.getItem(USER)); } catch { return null; } };
export function setSession(t, u) { localStorage.setItem(TOKEN, t); localStorage.setItem(USER, JSON.stringify(u)); }
export function logout() {
  localStorage.removeItem(TOKEN); localStorage.removeItem(USER);
  location.href = '/login.html';
}
export function requireLogin() {
  if (!token()) {
    location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('Login required');
  }
  return getUser();
}

const OFFLINE = 'Cannot reach the server. Check your internet connection, or ask the admin to confirm the system is running.';

export async function api(path, opts = {}) {
  const t = token();
  let res;
  try {
    res = await fetch('/api' + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch { throw new Error(OFFLINE); }
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && t && !opts.noRedirect) logout();
  if (res.status >= 502 && res.status <= 504 && !data) throw new Error(OFFLINE);
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}
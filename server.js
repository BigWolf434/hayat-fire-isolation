import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PIPES, VALVES, ISOLATION, TANKS, computeReadiness } from './config.js';

const PORT = Number(process.env.PORT) || 3001;
const REGISTER_CODE = process.env.REGISTER_CODE || 'HAYAT-HSE';   // officers need this code to register. CHANGE IT.
const PIPE_IDS = PIPES.map((p) => p.id);
const sysOf = (id) => (id.startsWith('hv') ? 'Hydrant' : id.startsWith('sv') ? 'Sprinkler' : 'Fire Pump');

/* ============ DATABASE (JSON file) ============ */
const DB_FILE = path.resolve(process.env.DATA_DIR || 'data', 'db.json');
let db;
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

// reversible copy of the password so the ADMIN can view it (AES-256-GCM)
const encKey = () => crypto.createHash('sha256').update('pw|' + db.secret).digest();
function encPw(pw) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const e = Buffer.concat([c.update(pw, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), e].map((b) => b.toString('base64')).join('.');
}
function decPw(s) {
  try {
    const [iv, tag, e] = s.split('.').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(e), d.final()]).toString('utf8');
  } catch { return null; }
}
function setPassword(u, pw) {
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = hashPw(pw, u.salt);
  u.pwEnc = encPw(pw);
}
function newUser(username, name, pw, role) {
  const u = { username, name, role, created: new Date().toISOString() };
  setPassword(u, pw);
  return u;
}
function checkPw(u, pw) {
  const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return crypto.timingSafeEqual(a, b);
}
function save() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function init() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = fs.existsSync(DB_FILE)
    ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
    : { secret: crypto.randomBytes(32).toString('hex'), users: [], incidents: [], valves: {}, log: [], tankLogs: [] };
  db.tankLogs ||= [];
  db.settings ||= {};
  if (!db.users.length) {
    db.users.push(newUser('admin', 'Administrator', 'admin123', 'admin'));
    console.log('First run: login  admin / admin123  (change this password after logging in!)');
  }
  VALVES.forEach((id) => {
    if (!db.valves[id]) db.valves[id] = { id, name: id.toUpperCase(), status: 'OPEN', closedBy: null, closedAt: null,
      reopenedBy: null, reopenedAt: null, incidentIds: [], lastPipes: [] };
  });
  Object.keys(db.valves).forEach((id) => { if (!VALVES.includes(id)) delete db.valves[id]; });
  db.incidents = db.incidents.filter((i) => PIPE_IDS.includes(i.pipe));
  const active = new Set(db.incidents.filter((i) => i.status === 'ACTIVE').map((i) => i.id));
  Object.values(db.valves).forEach((v) => {
    v.incidentIds = v.incidentIds.filter((x) => active.has(x));
    if (!v.incidentIds.length) v.status = 'OPEN';
  });
  save();
}
function audit(user, action, detail) {
  db.log.unshift({ time: new Date().toISOString(), user: user?.name || '-', username: user?.username || '-', action, detail });
  db.log.length = Math.min(db.log.length, 3000);
}

// the permanent site link printed on the valve QR codes
const publicUrl = () => (process.env.PUBLIC_URL || db.settings.publicUrl || '').trim().replace(/\/+$/, '');

/* ============ AUTH ============ */
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (p) => crypto.createHmac('sha256', db.secret).update(p).digest('base64url');
const makeToken = (u) => { const p = b64(JSON.stringify({ u: u.username, exp: Date.now() + 12 * 3600e3 })); return p + '.' + sign(p); };
function userFrom(req) {
  try {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    const [p, s] = t.split('.');
    if (!p || !s) return null;
    const e = sign(p);
    if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (d.exp < Date.now()) return null;
    return db.users.find((u) => u.username === d.u) || null;
  } catch { return null; }
}
const auth = (req, res, next) => {
  const u = userFrom(req);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  req.user = u; next();
};
const canWrite = (req, res, next) =>
  req.user.role === 'manager' ? res.status(403).json({ error: 'HSE managers have view-only access' }) : next();
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });

/* ============ DATES ============ */
const dayStr = () => new Date().toLocaleDateString('en-CA');
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d + n, 12).toLocaleDateString('en-CA'); };

/* ============ WATER ============ */
function latestTanks() {
  const today = dayStr();
  return TANKS.map((t) => {
    let e = null;
    for (const l of db.tankLogs) if (l.tank === t.id && l.date <= today && (!e || l.date > e.date)) e = l;
    return { id: t.id, name: t.name, capacity: t.capacity, volume: e ? e.volume : null,
      pct: e ? Math.round((e.volume / t.capacity) * 100) : null, date: e?.date || null, by: e?.by || null,
      at: e?.at || null, note: e?.note || '', loggedToday: !!e && e.date === today };
  });
}

function water() {
  const r1 = (n) => Math.round(n * 10) / 10;
  const mean = (a) => (a.length ? r1(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const cap = TANKS.reduce((a, t) => a + t.capacity, 0);

  const byDate = {};
  for (const l of db.tankLogs) (byDate[l.date] ||= {})[l.tank] = l;
  const days = Object.keys(byDate).sort().map((date) => {
    const rec = byDate[date], tanks = {};
    let vol = 0, c = 0;
    for (const t of TANKS) {
      const l = rec[t.id];
      if (l) {
        vol += l.volume; c += t.capacity;
        tanks[t.id] = { volume: l.volume, pct: r1((l.volume / t.capacity) * 100), by: l.by, at: l.at, note: l.note };
      } else tanks[t.id] = null;
    }
    return { date, tanks, total: r1(vol), pct: r1((vol / c) * 100), complete: c === cap, drop: null };
  });
  const idx = Object.fromEntries(days.map((d) => [d.date, d]));
  days.forEach((d) => {
    const p = idx[addDays(d.date, -1)];
    if (!p) return;
    let s = 0, n = 0;
    for (const t of TANKS) if (p.tanks[t.id] && d.tanks[t.id]) { s += p.tanks[t.id].volume - d.tanks[t.id].volume; n++; }
    if (n) d.drop = r1(s);
  });

  const weekKey = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 12);
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    return dt.toLocaleDateString('en-CA');
  };
  const bucket = (keyFn) => {
    const m = new Map();
    days.forEach((d) => { const k = keyFn(d.date); if (!m.has(k)) m.set(k, []); m.get(k).push(d); });
    return [...m].map(([key, ds]) => ({
      key, days: ds.length, pct: mean(ds.map((d) => d.pct)),
      min: Math.min(...ds.map((d) => d.pct)), max: Math.max(...ds.map((d) => d.pct)),
      avgVolume: mean(ds.map((d) => d.total)),
      used: r1(ds.reduce((a, d) => a + (d.drop > 0 ? d.drop : 0), 0)),
      tank: Object.fromEntries(TANKS.map((t) => [t.id, mean(ds.filter((d) => d.tanks[t.id]).map((d) => d.tanks[t.id].pct))])),
    }));
  };
  const buckets = { week: bucket(weekKey), month: bucket((s) => s.slice(0, 7)), year: bucket((s) => s.slice(0, 4)) };

  const summary = {};
  for (const k of ['day', 'week', 'month', 'year']) {
    const arr = k === 'day' ? days.map((d) => ({ key: d.date, pct: d.pct })) : buckets[k];
    const cur = arr[arr.length - 1], prev = arr[arr.length - 2];
    summary[k] = cur ? { pct: cur.pct, label: cur.key, prev: prev?.pct ?? null,
      delta: prev ? r1(cur.pct - prev.pct) : null } : { pct: null, label: null, prev: null, delta: null };
  }

  const today = dayStr();
  const avgDrop = (n) => mean(days.filter((d) => d.drop != null && d.drop >= 0 && d.date > addDays(today, -n)).map((d) => d.drop));
  const last = days[days.length - 1];
  const avg7 = avgDrop(7), avg30 = avgDrop(30);
  return {
    tanks: latestTanks(), totalCapacity: cap,
    currentTotal: last?.total ?? null, currentPct: last?.pct ?? null, currentDate: last?.date ?? null,
    days: days.slice(-400), buckets, summary,
    usage: { avg7, avg30, daysLeft: avg7 > 0 && last ? Math.floor(last.total / avg7) : null },
    entries: db.tankLogs.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.at < b.at ? 1 : -1)).slice(0, 1500),
  };
}

/* ============ READINESS / VIEWS ============ */
const readinessNow = () =>
  computeReadiness((id) => db.valves[id]?.status === 'CLOSED', latestTanks().filter((t) => t.pct != null).map((t) => t.pct));
const pipesOf = (v) => v.incidentIds.map((id) => db.incidents.find((i) => i.id === id)?.pipe).filter(Boolean);
function valveView(v, full, r) {
  const served = r.buildings.filter((b) => b.valves.includes(v.id)).map(({ name, pct, level }) => ({ name, pct, level }));
  const base = { id: v.id, name: v.name, system: sysOf(v.id), status: v.status, buildings: served };
  if (!full) return base;
  return { ...base, closedBy: v.closedBy, closedAt: v.closedAt, reopenedBy: v.reopenedBy, reopenedAt: v.reopenedAt,
    activePipes: pipesOf(v), lastPipes: v.lastPipes };
}

/* ============ API ============ */
init();
const app = express();
app.use(express.json());

app.post('/api/login', (req, res) => {
  const { username, password, role } = req.body || {};
  const u = db.users.find((x) => x.username === String(username || '').toLowerCase().trim());
  if (!u || !checkPw(u, String(password || ''))) {
    audit(null, 'LOGIN_FAILED', String(username || '')); save();
    return setTimeout(() => res.status(401).json({ error: 'Wrong username or password' }), 700);
  }
  if (role && role !== u.role) {
    const names = { officer: 'HSE Officer', manager: 'HSE Manager', admin: 'Admin' };
    return res.status(403).json({ error: `This is not an ${names[role]} account. Choose the correct tab.` });
  }
  if (!u.pwEnc) { u.pwEnc = encPw(String(password)); }
  audit(u, 'LOGIN', ''); save();
  res.json({ token: makeToken(u), user: { username: u.username, name: u.name, role: u.role } });
});

app.post('/api/register', (req, res) => {
  const { username, name, password, code } = req.body || {};
  if (String(code || '').trim() !== REGISTER_CODE) return res.status(403).json({ error: 'Wrong access code. Ask your HSE manager.' });
  const un = String(username || '').toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,30}$/.test(un)) return res.status(400).json({ error: 'Username: 3-30 letters/numbers (no spaces)' });
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Full name required' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.users.some((u) => u.username === un)) return res.status(409).json({ error: 'Username already exists' });
  db.users.push(newUser(un, String(name).trim(), String(password), 'officer'));
  audit({ name: String(name).trim(), username: un }, 'USER_REGISTERED', un); save();
  res.json({ ok: true });
});

app.get('/api/state', auth, (req, res) => {
  const r = readinessNow();
  res.json({
    valves: VALVES.map((id) => valveView(db.valves[id], true, r)),
    incidents: db.incidents.slice(0, 1000),
    readiness: r,
    water: { tanks: latestTanks() },
    recent: db.log.slice(0, 8),
    publicUrl: publicUrl(),
    publicLocked: !!process.env.PUBLIC_URL,
  });
});

app.get('/api/log', auth, (req, res) => res.json(db.log.slice(0, 500)));
app.get('/api/water', auth, (req, res) => res.json(water()));

// admin saves the permanent site link that the QR codes carry
app.post('/api/settings', auth, adminOnly, (req, res) => {
  if (process.env.PUBLIC_URL) return res.status(409).json({ error: 'The site link is fixed by the PUBLIC_URL setting on the host.' });
  const u = String(req.body?.publicUrl || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(u)) return res.status(400).json({ error: 'Enter a full link starting with https://' });
  db.settings.publicUrl = u.slice(0, 200);
  audit(req.user, 'SETTINGS_CHANGED', 'QR site link: ' + (u || '(cleared)')); save();
  res.json({ publicUrl: db.settings.publicUrl });
});

app.post('/api/incidents', auth, canWrite, (req, res) => {
  const { pipe, point } = req.body || {};
  if (!PIPE_IDS.includes(pipe)) return res.status(400).json({ error: 'Unknown pipe' });
  if (!Array.isArray(point) || point.length !== 3 || point.some((n) => typeof n !== 'number' || !isFinite(n)))
    return res.status(400).json({ error: 'Bad leak position' });
  if (db.incidents.some((i) => i.pipe === pipe && i.status === 'ACTIVE'))
    return res.status(409).json({ error: pipe.toUpperCase() + ' already has an active leak' });

  const now = new Date().toISOString();
  const plan = ISOLATION[pipe] || [];
  const inc = { id: crypto.randomUUID().slice(0, 8), pipe, system: PIPES.find((p) => p.id === pipe).system, point,
    status: 'ACTIVE', reportedBy: req.user.name, reportedAt: now, valves: plan, closed: [], resolvedBy: null, resolvedAt: null };

  for (const id of plan) {
    const v = db.valves[id];
    if (!v) continue;
    if (v.status !== 'CLOSED') {
      v.status = 'CLOSED'; v.closedBy = req.user.name; v.closedAt = now;
      v.reopenedBy = null; v.reopenedAt = null; v.lastPipes = [];
    }
    v.incidentIds.push(inc.id);
    if (!v.lastPipes.includes(pipe)) v.lastPipes.push(pipe);
    inc.closed.push(id);
  }
  db.incidents.unshift(inc);
  const r = readinessNow();
  audit(req.user, 'LEAK_REPORTED', `${pipe.toUpperCase()} (${inc.system}). Closed: ${inc.closed.map((x) => x.toUpperCase()).join(', ') || 'none'}. Readiness now ${r.pct}% (${r.label})`);
  save();
  res.json(inc);
});

app.post('/api/incidents/:id/resolve', auth, canWrite, (req, res) => {
  const inc = db.incidents.find((i) => i.id === req.params.id);
  if (!inc) return res.status(404).json({ error: 'Not found' });
  if (inc.status !== 'ACTIVE') return res.status(409).json({ error: 'Already resolved' });
  const now = new Date().toISOString();
  inc.status = 'RESOLVED'; inc.resolvedBy = req.user.name; inc.resolvedAt = now;
  const reopened = [];
  for (const id of inc.closed) {
    const v = db.valves[id];
    v.incidentIds = v.incidentIds.filter((x) => x !== inc.id);
    if (!v.incidentIds.length && v.status === 'CLOSED') {
      v.status = 'OPEN'; v.reopenedBy = req.user.name; v.reopenedAt = now; reopened.push(id.toUpperCase());
    }
  }
  const r = readinessNow();
  audit(req.user, 'LEAK_RESOLVED', `${inc.pipe.toUpperCase()}. Reopened: ${reopened.join(', ') || 'none (still needed by another leak)'}. Readiness now ${r.pct}% (${r.label})`);
  save();
  res.json(inc);
});

app.post('/api/tanks/log', auth, canWrite, (req, res) => {
  const { tank, volume, date, note } = req.body || {};
  const t = TANKS.find((x) => x.id === tank);
  if (!t) return res.status(400).json({ error: 'Unknown tank' });
  const vol = Math.round(Number(volume) * 10) / 10;
  if (!isFinite(vol) || vol < 0 || vol > t.capacity) return res.status(400).json({ error: `Volume must be between 0 and ${t.capacity} m³` });
  const d = String(date || dayStr());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > dayStr() || d < addDays(dayStr(), -800)) return res.status(400).json({ error: 'Bad date' });
  const rec = { id: crypto.randomUUID().slice(0, 8), tank, date: d, volume: vol, by: req.user.name,
    at: new Date().toISOString(), note: String(note || '').slice(0, 200) };
  const i = db.tankLogs.findIndex((l) => l.tank === tank && l.date === d);
  if (i >= 0) db.tankLogs[i] = rec; else db.tankLogs.push(rec);
  audit(req.user, 'TANK_VOLUME', `${t.name}: ${vol} m³ on ${d}${i >= 0 ? ' (replaced earlier entry)' : ''}`);
  save();
  res.json(rec);
});

// Public live valve status for QR scans. Names/times only when a valid login is attached.
app.get('/api/public/valve/:id', (req, res) => {
  const v = db.valves[req.params.id];
  if (!v) return res.status(404).json({ error: 'Valve not found' });
  const full = !!userFrom(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...valveView(v, full, readinessNow()), detailed: full });
});

/* ---- users: ONLY the admin can list them and see officer/manager passwords ---- */
app.get('/api/users', auth, adminOnly, (req, res) =>
  res.json(db.users.map((u) => ({
    username: u.username, name: u.name, role: u.role, created: u.created,
    password: u.role === 'admin' ? undefined : (u.pwEnc ? decPw(u.pwEnc) : null),
  }))));

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { username, name, password, role } = req.body || {};
  const un = String(username || '').toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,30}$/.test(un)) return res.status(400).json({ error: 'Username: 3-30 letters/numbers' });
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Full name required' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.users.some((u) => u.username === un)) return res.status(409).json({ error: 'Username already exists' });
  db.users.push(newUser(un, String(name).trim(), String(password), ['admin', 'manager'].includes(role) ? role : 'officer'));
  audit(req.user, 'USER_CREATED', `${un} (${role})`); save();
  res.json({ ok: true });
});

app.post('/api/users/:username/password', auth, adminOnly, (req, res) => {
  const u = db.users.find((x) => x.username === req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const pw = String(req.body?.newPassword || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  setPassword(u, pw);
  audit(req.user, 'PASSWORD_RESET', u.username); save();
  res.json({ ok: true });
});

app.post('/api/password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!checkPw(req.user, String(oldPassword || ''))) return res.status(400).json({ error: 'Current password is wrong' });
  if (String(newPassword || '').length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  setPassword(req.user, String(newPassword));
  audit(req.user, 'PASSWORD_CHANGED', ''); save();
  res.json({ ok: true });
});

/* ---- when hosted: serve the built website (npm run build creates the "dist" folder) ---- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
const DIST = path.resolve('dist');
if (fs.existsSync(DIST)) app.use(express.static(DIST));

app.use((err, req, res, next) => {          // never crash on a bad request
  console.error('Request error:', err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});
process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
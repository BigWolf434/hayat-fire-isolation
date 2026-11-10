import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { api, requireLogin } from './api.js';
import { mountShell, esc, fmt, today, setStatus } from './shell.js';
import { confirmBox, alertBox, toast } from './ui.js';
import { PIPES, VALVES, ISOLATION, TANKS, computeReadiness, LABEL } from './config.js';

const me = requireLogin();
mountShell('dash', me, 'Fire Isolation Management System', 'Identify · Isolate · Secure');
const canWrite = me.role !== 'manager';
const $ = (s) => document.querySelector(s);

/* ============ 1. CONFIG ============ */
const Z_UP_FIX = false;       // set true if the plant appears lying on its side
const CLOSE_DELAY_MS = 1500;  // visual delay between each automatic valve closure
const POLL_MS = 3000;

// your own building models (file + display name + colour)
const STYLES = {
  admin:    { file: 'admin.glb',    label: 'ADMIN',             color: 0x93c5fd },
  hygiene:  { file: 'hygiene.glb',  label: 'HYGIENE BUILDING',  color: 0x7dd3fc },
  security: { file: 'security.glb', label: 'SECURITY',          color: 0xfcd34d },
  waste:    { file: 'waste segregation.glb', label: 'WASTE SEGREGATION', color: 0x86efac },
  fgwh:     { file: 'fgwh.glb',     label: 'FGWH',              color: 0xa5b4fc },
  fb:       { file: 'fb.glb',       label: 'FB',                color: 0xfca5a5 },
};

const MODELS = [
  { id: 'floor', file: 'floor.glb', type: 'floor' },
  ...Object.entries(STYLES).map(([id, s]) => ({ id, file: s.file, type: 'building' })),
  ...TANKS.map((t) => ({ id: t.id, file: t.id + '.glb', type: 'tank' })),
  ...VALVES.map((id) => ({ id, file: id + '.glb', type: 'valve' })),
  ...PIPES.map((p) => ({ id: p.id, file: p.id + '.glb', type: 'pipe', system: p.system })),
];

const COLORS = { Hydrant: 0xef4444, Sprinkler: 0x3b82f6, 'Fire Pump': 0xa855f7, valveOpen: 0xf59e0b, valveClosed: 0x22c55e };
const LEVEL_COLOR = { ready: '#15803d', degraded: '#b45309', critical: '#b91c1c' };
const EDGE_HEX = { ready: 0x22c55e, degraded: 0xf59e0b, critical: 0xef4444, none: 0x38bdf8 };

/* ============ 2. SCENE ============ */
const host = $('#vbody');
const BG = 0x0b1220;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
host.prepend(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
host.appendChild(labelRenderer.domElement);

scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.zoomToCursor = true;
controls.rotateSpeed = 0.7;
controls.listenToKeyEvents(window);

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h); labelRenderer.setSize(w, h);
}
new ResizeObserver(resize).observe(host);
resize();

/* ============ 3. CAMERA FLY-TO ============ */
let anim = null;
controls.addEventListener('start', () => (anim = null));
const ease = (k) => (k < 0.5 ? 4 * k ** 3 : 1 - Math.pow(-2 * k + 2, 3) / 2);
function flyTo(pos, target, ms = 1400) {
  anim = { p0: camera.position.clone(), p1: pos.clone(), t0: controls.target.clone(), t1: target.clone(), start: performance.now(), ms };
}
function stepAnim() {
  if (!anim) return;
  const k = Math.min((performance.now() - anim.start) / anim.ms, 1), e = ease(k);
  camera.position.lerpVectors(anim.p0, anim.p1, e);
  controls.target.lerpVectors(anim.t0, anim.t1, e);
  if (k === 1) anim = null;
}
function frameBox(box, dir = null, factor = 1.15) {
  const c = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * factor;
  const d = dir ? dir.clone().normalize() : camera.position.clone().sub(controls.target).normalize();
  flyTo(c.clone().add(d.multiplyScalar(dist)), c);
}
const VIEWS = { iso: new THREE.Vector3(1, 0.7, 1), top: new THREE.Vector3(0, 1, 0.001), front: new THREE.Vector3(0, 0.15, 1), side: new THREE.Vector3(1, 0.15, 0) };
let plantBox = new THREE.Box3();
let maxDim = 1;
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => frameBox(plantBox, VIEWS[b.dataset.view])));

/* ============ 4. STATE ============ */
const state = { hovered: null, hoverB: null, selected: null, building: null, lastPoint: null };
let S = { valves: [], incidents: [], readiness: null, water: { tanks: [] }, recent: [] };
const pending = new Map();
let ready = false;

const activeIncidents = () => S.incidents.filter((i) => i.status === 'ACTIVE');
const isLeaking = (pipe) => activeIncidents().some((i) => i.pipe === pipe);
function valveStatus(id) {   // 'open' | 'closing' | 'closed'
  const v = S.valves.find((x) => x.id === id);
  if (!v || v.status !== 'CLOSED') return 'open';
  return (pending.get(id) || 0) > Date.now() ? 'closing' : 'closed';
}
const live = () => computeReadiness((id) => valveStatus(id) === 'closed', S.water.tanks.filter((t) => t.pct != null).map((t) => t.pct));

async function sync() { S = await api('/state'); renderAll(); }

/* ============ 5. LOAD MODELS (your own GLB files) ============ */
const plant = new THREE.Group();
if (Z_UP_FIX) plant.rotation.x = -Math.PI / 2;
scene.add(plant);

const registry = {}, pipes = [], buildingRoots = [], failed = [];
const valveTags = {}, bTags = {}, tankTags = {}, visuals = new Map();
let leakGeo = null;

function makeMaterial(m) {
  if (m.type === 'floor') return new THREE.MeshStandardMaterial({ color: 0x2b3544, roughness: 0.95, metalness: 0.05 });
  if (m.type === 'tank')  return new THREE.MeshStandardMaterial({ color: 0xcfd8e3, roughness: 0.45, metalness: 0.5 });
  if (m.type === 'building')
    return new THREE.MeshStandardMaterial({ color: STYLES[m.id].color, roughness: 0.55, metalness: 0.1, transparent: true,
      opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const color = m.type === 'pipe' ? COLORS[m.system] : COLORS.valveOpen;
  return new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.4, side: THREE.DoubleSide });
}

function makeTag(cls, html) {
  const wrap = document.createElement('div'); wrap.className = 'lbl-wrap';
  const tag = document.createElement('div'); tag.className = 'tag ' + cls; tag.innerHTML = html;
  wrap.appendChild(tag);
  return { wrap, tag };
}

const manager = new THREE.LoadingManager();
manager.onProgress = (_u, l, t) => ($('#pct').textContent = Math.round((l / t) * 100) + '%');
manager.onLoad = onAllLoaded;
const loader = new GLTFLoader(manager);
MODELS.forEach((m) => {
  loader.load(`/models/${encodeURIComponent(m.file)}`, (gltf) => {
    const root = gltf.scene, material = makeMaterial(m);
    const meshes = [];
    root.traverse((o) => { if (o.isMesh) { o.material = material; meshes.push(o); } });
    root.userData = { id: m.id, type: m.type, system: m.system, material };
    if (m.type === 'building') {            // glowing outline edges (colour shows fire capacity)
      const edgeMat = new THREE.LineBasicMaterial({ color: EDGE_HEX.none });
      meshes.forEach((o) => {
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 25), edgeMat);
        e.raycast = () => {};
        o.add(e);
      });
      root.userData.edgeMat = edgeMat;
      buildingRoots.push(root);
    }
    plant.add(root);
    registry[m.id] = root;
    if (m.type === 'pipe') pipes.push(root);
  }, undefined, (err) => { console.error('Failed to load', m.file, err); failed.push(m.file); });
});

/* building display modes */
let bMode = 0;
const B_MODES = ['Glass', 'Solid', 'Hidden'];
function applyBuildingMode() {
  const m = B_MODES[bMode], solid = m === 'Solid';
  buildingRoots.forEach((r) => {
    r.visible = m !== 'Hidden';
    const mat = r.userData.material;
    mat.opacity = solid ? 1 : 0.3;
    mat.depthWrite = solid;
    mat.needsUpdate = true;
  });
  $('#btnBuilding').textContent = 'Buildings: ' + m;
}
$('#btnBuilding').addEventListener('click', () => { bMode = (bMode + 1) % B_MODES.length; applyBuildingMode(); });

function onAllLoaded() {
  if (failed.length)
    $('#loadError').innerHTML = `Could not load: <b>${failed.map(esc).join(', ')}</b><br>Check the names in public/models/`;
  if (!Object.keys(registry).length) return;

  plant.updateMatrixWorld(true);
  plant.position.sub(new THREE.Box3().setFromObject(plant).getCenter(new THREE.Vector3()));
  plant.updateMatrixWorld(true);
  plantBox = new THREE.Box3().setFromObject(plant);
  const size = plantBox.getSize(new THREE.Vector3());
  maxDim = Math.max(size.x, size.y, size.z);

  camera.near = maxDim / 2000; camera.far = maxDim * 50; camera.updateProjectionMatrix();
  controls.minDistance = maxDim * 0.02; controls.maxDistance = maxDim * 5;
  sun.position.set(maxDim, maxDim * 1.5, maxDim);
  scene.fog = new THREE.Fog(BG, maxDim * 3, maxDim * 12);
  leakGeo = new THREE.SphereGeometry(maxDim * 0.012, 24, 24);

  applyBuildingMode();

  // name tag above each building (like a video game)
  Object.keys(STYLES).forEach((id) => {
    const root = registry[id]; if (!root) return;
    const box = new THREE.Box3().setFromObject(root), c = box.getCenter(new THREE.Vector3());
    const tag = makeTag('bldg', '');
    const lbl = new CSS2DObject(tag.wrap);
    lbl.position.set(c.x, box.max.y + maxDim * 0.012, c.z);
    scene.add(lbl);
    bTags[id] = { ...tag, lbl };
  });

  // tank tags (tanks are your own model, unchanged)
  TANKS.forEach((t) => {
    const root = registry[t.id]; if (!root) return;
    const box = new THREE.Box3().setFromObject(root), c = box.getCenter(new THREE.Vector3());
    const tag = makeTag('tank', '');
    const lbl = new CSS2DObject(tag.wrap);
    lbl.position.set(c.x, box.max.y + maxDim * 0.012, c.z);
    scene.add(lbl);
    tankTags[t.id] = { ...tag, lbl };
  });

  VALVES.forEach((id) => {
    const root = registry[id]; if (!root) return;
    const vb = new THREE.Box3().setFromObject(root), c = vb.getCenter(new THREE.Vector3());
    const t = makeTag('valve-closing', '');
    const lbl = new CSS2DObject(t.wrap);
    lbl.position.set(c.x, vb.max.y + maxDim * 0.004, c.z);
    lbl.visible = false;
    scene.add(lbl);
    valveTags[id] = { ...t, lbl };
  });

  const center = plantBox.getCenter(new THREE.Vector3());
  camera.position.copy(center).addScaledVector(VIEWS.iso.clone().normalize(), maxDim * 5);
  controls.target.copy(center);
  frameBox(plantBox, VIEWS.iso);

  ready = true;
  if (!failed.length) $('#loading').classList.add('hide');
  else setTimeout(() => $('#loading').classList.add('hide'), 5000);
  renderAll();
}

/* ============ 6. LEAK VISUALS ============ */
function createLeakVisual(inc) {
  const t = makeTag('leak', `⚠ LEAKAGE<small>${esc(inc.pipe.toUpperCase())} · ${esc(inc.reportedBy)}</small>`);
  const lbl = new CSS2DObject(t.wrap);
  lbl.position.set(inc.point[0], inc.point[1] + maxDim * 0.012, inc.point[2]);
  scene.add(lbl);
  const marker = new THREE.Mesh(leakGeo, new THREE.MeshBasicMaterial({ color: 0xff2200, transparent: true, opacity: 0.85 }));
  marker.position.set(...inc.point);
  scene.add(marker);
  visuals.set(inc.id, { lbl, marker });
}
function removeLeakVisual(id) {
  const v = visuals.get(id);
  if (!v) return;
  scene.remove(v.lbl); v.lbl.element.remove();
  scene.remove(v.marker); v.marker.material.dispose();
  visuals.delete(id);
}
function reconcileVisuals() {
  const act = activeIncidents(), ids = new Set(act.map((i) => i.id));
  act.forEach((i) => { if (!visuals.has(i.id)) createLeakVisual(i); });
  [...visuals.keys()].forEach((id) => { if (!ids.has(id)) removeLeakVisual(id); });
}

function updateSceneLabels() {
  VALVES.forEach((id) => {
    const t = valveTags[id]; if (!t) return;
    const st = valveStatus(id);
    t.lbl.visible = st !== 'open';
    t.tag.className = 'tag ' + (st === 'closed' ? 'valve-closed' : 'valve-closing');
    t.tag.textContent = st === 'closed' ? `✔ ${id.toUpperCase()} CLOSED` : `⏳ CLOSING ${id.toUpperCase()}…`;
  });
  const R = live();
  Object.entries(bTags).forEach(([id, bt]) => {
    const b = R.buildings.find((x) => x.id === id);
    bt.tag.style.background = b && b.pct != null ? LEVEL_COLOR[b.level] : '#0284c7';
    bt.tag.innerHTML = `🏢 ${esc(STYLES[id].label)}<small>` + (b && b.pct != null
      ? `🚒 Fire capacity ${b.pct}% · ${LABEL[b.level]}<br>${b.open}/${b.total} valves open` : 'No fire valves assigned') + '</small>';
  });
  S.water.tanks.forEach((t) => {
    const o = tankTags[t.id]; if (!o) return;
    o.tag.style.background = t.pct == null ? '#475569' : t.pct >= 75 ? '#15803d' : t.pct >= 50 ? '#b45309' : '#b91c1c';
    o.tag.innerHTML = `🛢 ${esc(t.name.toUpperCase())}<small>` + (t.pct == null ? 'No volume recorded'
      : `💧 ${t.pct}% · ${t.volume} / ${t.capacity} m³`) + '</small>';
  });
}

/* ============ 7. PICKING (pipes + smart buildings) ============ */
const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();
const dom = renderer.domElement;
let down = { x: 0, y: 0 }, moveEvt = null;
const findRoot = (o) => { while (o && !o.userData.id) o = o.parent; return o; };
function setRay(e) {
  const r = dom.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
}
function pickPipe(e) {
  setRay(e);
  const hit = raycaster.intersectObjects(pipes, true)[0];
  return hit ? { root: findRoot(hit.object), point: hit.point } : null;
}
function pickBuilding(e) {
  if (B_MODES[bMode] === 'Hidden') return null;
  setRay(e);
  const hit = raycaster.intersectObjects(buildingRoots, true)[0];
  return hit ? findRoot(hit.object).userData.id : null;
}
dom.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
dom.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
  const hit = pickPipe(e);
  if (hit) { state.selected = hit.root.userData.id; state.lastPoint = hit.point.clone(); state.building = null; }
  else { state.building = pickBuilding(e); state.selected = null; state.lastPoint = null; }
  renderProc();
});
dom.addEventListener('dblclick', (e) => {
  const h = pickPipe(e);
  if (h) return frameBox(new THREE.Box3().setFromObject(h.root), null, 1.4);
  const b = pickBuilding(e);
  if (b) frameBox(new THREE.Box3().setFromObject(registry[b]), null, 1.6);
});
dom.addEventListener('pointermove', (e) => (moveEvt = e));

/* ============ 8. LEAK + AUTOMATIC ISOLATION ============ */
function frameIncident(inc) {
  const box = new THREE.Box3();
  if (registry[inc.pipe]) box.setFromObject(registry[inc.pipe]);
  inc.valves.forEach((v) => registry[v] && box.union(new THREE.Box3().setFromObject(registry[v])));
  if (!box.isEmpty()) frameBox(box, null, 1.5);
}

async function report() {
  if (!canWrite || !state.selected || isLeaking(state.selected) || !state.lastPoint) return;
  const alreadyClosed = new Set(S.valves.filter((v) => v.status === 'CLOSED').map((v) => v.id));
  let inc;
  try { inc = await api('/incidents', { body: { pipe: state.selected, point: state.lastPoint.toArray() } }); }
  catch (e) { await alertBox({ title: 'Could not report the leak', message: e.message, tone: 'error' }); return; }
  inc.closed.forEach((id, i) => {          // server closed them; animate one after another
    if (alreadyClosed.has(id)) return;
    const ms = CLOSE_DELAY_MS * (i + 1);
    pending.set(id, Date.now() + ms);
    setTimeout(renderAll, ms + 50);
  });
  try { await sync(); } catch (e) { console.error(e); }  frameIncident(inc);  toast(`${inc.pipe.toUpperCase()} reported. Isolating ${inc.closed.length} valve(s)…`, 'info');
}

$('#proc').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'leak') report();
  if (a === 'clear') { state.selected = null; state.building = null; state.lastPoint = null; renderProc(); }
  if (a === 'bfocus' && registry[state.building]) frameBox(new THREE.Box3().setFromObject(registry[state.building]), null, 1.6);
  const inc = S.incidents.find((i) => i.id === b.dataset.id);
  if (a === 'locate' && inc) frameIncident(inc);
  if (a === 'resolve' && inc) {    const ok = await confirmBox({      title: 'Resolve this leak?',      message: `${inc.pipe.toUpperCase()} (${inc.system || ''}) will be marked as resolved under your name.\n` +        `Valves released: ${inc.valves.map((v) => v.toUpperCase()).join(', ') || 'none'}.\n` +        `A valve stays closed if another active leak still needs it.`,      confirmText: 'Yes, resolve', cancelText: 'Cancel',    });    if (!ok) return;    try { await api(`/incidents/${inc.id}/resolve`, { method: 'POST' }); }    catch (ex) { await alertBox({ title: 'Could not resolve the leak', message: ex.message, tone: 'error' }); return; }    try { await sync(); } catch (ex) { console.error(ex); }    toast(`${inc.pipe.toUpperCase()} resolved. Valves reopened.`, 'success');  }
});

/* ============ 9. DASHBOARD PANELS ============ */
const sysIcon = { Hydrant: '🔴', Sprinkler: '🔵', 'Fire Pump': '🟣' };
const stateText = { open: 'OPEN → CLOSE', closing: 'CLOSING…', closed: 'CLOSED ✔' };

function renderProc() {
  const sel = state.selected, pipe = PIPES.find((p) => p.id === sel);
  let html = '<h3>🔥 Isolation procedure <span class="live">Live</span></h3>';

  if (state.building) {
    const b = live().buildings.find((x) => x.id === state.building);
    if (b) {
      const affected = Object.entries(ISOLATION).filter(([, vs]) => vs.some((v) => b.valves.includes(v))).map(([p]) => p.toUpperCase());
      html += `<div class="sel"><span class="chip ${b.pct == null ? '' : 'c-' + b.level}">${b.pct == null ? 'no valves' : b.pct + '% · ' + LABEL[b.level]}</span>
        <small>🏢 BUILDING</small><b>${esc(STYLES[b.id].label)}</b></div>
        <h4>Surrounding valves</h4>` +
        (b.valves.length ? `<ol class="steps">${b.valves.map((v) => { const st = valveStatus(v);
          return `<li class="${st === 'closed' ? 'done' : st === 'closing' ? 'prog' : ''}"><i>${st === 'closed' ? '✔' : '●'}</i>
            <div><b>${v.toUpperCase()}</b><small>${st === 'open' ? 'OPEN (available)' : st === 'closing' ? 'CLOSING…' : 'CLOSED (reduces capacity)'}</small></div></li>`; }).join('')}</ol>`
          : '<p class="muted">No fire valves are assigned to this building.</p>') +
        (affected.length ? `<p class="muted">A leak on these pipes closes one of its valves: <b>${affected.join(', ')}</b></p>` : '') +
        `<div class="row"><button data-act="bfocus">Focus</button><button data-act="clear">Deselect</button></div>`;
    }
  } else if (!sel) {
    html += '<div class="empty">Click a <b>pipe</b> to see which valves close if it leaks, or click a <b>building</b> to see its fire capacity.</div>';
  } else {
    const plan = ISOLATION[sel] || [], leaking = isLeaking(sel);
    html += `<div class="sel ${leaking ? 'bad' : ''}"><span class="chip ${leaking ? 'c-ACTIVE' : ''}">${leaking ? 'LEAKING' : 'Selected'}</span>
      <small>${sysIcon[pipe.system]} ${pipe.system.toUpperCase()} PIPE</small><b>${sel.toUpperCase()}</b></div>
      <h4>Valves to isolate</h4><ol class="steps">${plan.map((v, i) => {
        const st = valveStatus(v);
        return `<li class="${st === 'closed' ? 'done' : st === 'closing' ? 'prog' : ''}"><i>${st === 'closed' ? '✔' : i + 1}</i>
          <div><b>Close ${v.toUpperCase()}</b><small>${stateText[st]}</small></div></li>`; }).join('') || '<li class="muted">No isolation rule</li>'}</ol>
      <div class="row"><button class="danger" style="flex:1" data-act="leak" ${!canWrite || leaking ? 'disabled' : ''}>${
        !canWrite ? 'View-only access' : leaking ? 'Already reported' : 'Report leakage & isolate'}</button>
        <button data-act="clear">Deselect</button></div>`;
  }

  const act = activeIncidents();
  html += `<h4>Active leaks · ${act.length}</h4>` + (act.length ? '' : '<p class="muted">No active leaks. History is on the Records page.</p>');
  html += act.map((inc) => {
    const isolated = inc.valves.length && inc.valves.every((v) => valveStatus(v) === 'closed');
    return `<div class="inc"><span class="chip c-ACTIVE">ACTIVE</span> <b>${esc(inc.pipe.toUpperCase())}</b> <span class="muted">${esc(inc.system || '')}</span>
      <div class="muted">By ${esc(inc.reportedBy)} · ${fmt(inc.reportedAt)}</div>
      <ul>${inc.valves.map((v) => { const st = valveStatus(v); return `<li>${st === 'closed' ? '✔' : '⏳'} ${v.toUpperCase()} ${st === 'closed' ? 'closed' : 'closing…'}</li>`; }).join('')}</ul>
      ${isolated ? '<span class="chip c-ready">✅ Section isolated</span>' : ''}
      <div class="row"><button class="sm" data-act="locate" data-id="${inc.id}">Locate</button>
      ${canWrite ? `<button class="sm" data-act="resolve" data-id="${inc.id}">Resolve (reopen valves)</button>` : ''}</div></div>`;
  }).join('');
  $('#proc').innerHTML = html;
}

const ring = (pct, color) => `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" fill="none" stroke="#1a2a52" stroke-width="10"/>
  <circle cx="50" cy="50" r="42" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(pct || 0) * 2.639} 264"/></svg>`;
const ACT = { LEAK_REPORTED: '🔥 Leak reported', LEAK_RESOLVED: '✅ Leak resolved', TANK_VOLUME: '🛢 Tank volume logged', LOGIN: '🔑 Login',
  USER_CREATED: '👤 User created', USER_REGISTERED: '👤 New officer', PASSWORD_CHANGED: '🔒 Password changed', PASSWORD_RESET: '🔒 Password reset', LOGIN_FAILED: '⚠ Failed login' };

function renderCards() {
  const R = live(), act = activeIncidents().length;
  $('#kActive').textContent = act;
  $('#kResolved').textContent = S.incidents.filter((i) => i.resolvedAt && new Date(i.resolvedAt).toLocaleDateString('en-CA') === today()).length;
  $('#kTotal').textContent = S.incidents.length;
  $('#kReady').textContent = R.pct + '%';
  $('#kReady').className = 'rd-' + R.level;
  $('#kBar').className = 'bg-' + R.level; $('#kBar').style.width = R.pct + '%';
  setStatus(act ? `🔥 ${act} isolation active` : 'All systems operational', act ? 'bad' : 'ok');

  const tanks = S.water.tanks, known = tanks.filter((t) => t.volume != null);
  const total = known.reduce((a, t) => a + t.volume, 0), cap = tanks.reduce((a, t) => a + t.capacity, 0);
  const notLogged = tanks.filter((t) => !t.loggedToday).length;
  $('#cWater').innerHTML = `<h3>🛢 Water storage</h3><div class="rings">${tanks.map((t) => {
    const col = t.pct == null ? '#475569' : t.pct >= 75 ? '#22c55e' : t.pct >= 50 ? '#f59e0b' : '#ef4444';
    return `<div class="ring">${ring(t.pct, col)}<div class="pc">${t.pct == null ? '–' : t.pct + '%'}</div><b>${esc(t.name)}</b>
      <small>${t.volume == null ? 'no data' : t.volume + ' / ' + t.capacity + ' m³'}</small></div>`; }).join('')}</div>
    <p class="muted" style="margin-top:10px">Total ${known.length ? Math.round(total) : '–'} / ${cap} m³
    ${notLogged ? `<br><span class="warn">⚠ Daily tank inspection not recorded today</span>` : '<br>✅ Today\'s inspection recorded'}</p>
    <a href="/tanks.html"><button class="pri sm">Record volume & see trends →</button></a>`;

  $('#cReady').innerHTML = `<h3>🛡 Readiness breakdown</h3>` + R.components.map((c) => `<div class="comp"><div><span>${c.label}</span>
    <b class="${c.pct == null ? 'muted' : 'rd-' + c.level}">${c.pct == null ? 'no data' : c.pct + '%'}</b></div>
    <div class="bar"><i class="${c.pct == null ? '' : 'bg-' + c.level}" style="width:${c.pct || 0}%"></i></div></div>`).join('') +
    '<p class="muted">Closed valves, low pump-room valves and low water all reduce readiness.</p>';

  $('#cAct').innerHTML = `<h3>🕒 Recent activities</h3><div class="list">${S.recent.map((l) => `<div class="it"><div>${ACT[l.action] || l.action}
    <small>by ${esc(l.user)} · ${esc(l.detail).slice(0, 70)}</small></div><small>${new Date(l.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div>`).join('')}</div>`;
}

function renderAll() { if (!ready) return; reconcileVisuals(); renderCards(); renderProc(); updateSceneLabels(); }

/* ============ 10. HIGHLIGHT + RENDER LOOP ============ */
function styleRoot(root, t, leakingPipes, preview, R) {
  const { id, type, system, material: m } = root.userData;
  const pulse = 0.5 + 0.5 * Math.sin(t * 6);

  if (type === 'building') {
    const b = R.buildings.find((x) => x.id === id);
    const lvl = b && b.pct != null ? b.level : 'none';
    root.userData.edgeMat.color.setHex(EDGE_HEX[lvl]);
    root.userData.edgeMat.opacity = lvl === 'critical' ? 0.5 + pulse * 0.5 : 1;
    root.userData.edgeMat.transparent = true;
    m.emissive.setHex(0x1d4ed8);
    m.emissiveIntensity = state.building === id ? 0.5 + pulse * 0.2 : state.hoverB === id ? 0.3 : 0;
    return;
  }
  if (type !== 'pipe' && type !== 'valve') return;
  m.emissive.setHex(0x000000); m.emissiveIntensity = 1;
  if (type === 'pipe') {
    m.color.setHex(COLORS[system]);
    if (state.hovered === id)  { m.emissive.setHex(0xffffff); m.emissiveIntensity = 0.25; }
    if (state.selected === id) { m.emissive.setHex(0xffffff); m.emissiveIntensity = 0.35 + pulse * 0.3; }
    if (leakingPipes.has(id))  { m.emissive.setHex(0xffb000); m.emissiveIntensity = pulse * 1.2; }
  } else {
    const st = valveStatus(id);
    if (st === 'closed')       { m.color.setHex(COLORS.valveClosed); m.emissive.setHex(0x16a34a); m.emissiveIntensity = 0.35; }
    else if (st === 'closing') { m.color.setHex(COLORS.valveOpen); m.emissive.setHex(0xff7a00); m.emissiveIntensity = pulse * 1.5; }
    else {
      m.color.setHex(COLORS.valveOpen);
      if (preview.has(id)) { m.emissive.setHex(0xfff2a8); m.emissiveIntensity = 0.3 + pulse * 0.8; }
    }
  }
}

const tip = $('#tooltip'), clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  if (moveEvt && ready) {
    const hit = pickPipe(moveEvt);
    state.hovered = hit ? hit.root.userData.id : null;
    const bId = hit ? null : pickBuilding(moveEvt);
    state.hoverB = bId;
    dom.style.cursor = hit || bId ? 'pointer' : 'default';
    let text = '';
    if (hit) text = `${state.hovered.toUpperCase()} · ${hit.root.userData.system}`;
    else if (bId) { const b = live().buildings.find((x) => x.id === bId); text = `${STYLES[bId].label}${b && b.pct != null ? ' · capacity ' + b.pct + '%' : ''}`; }
    tip.style.display = text ? 'block' : 'none';
    if (text) { tip.textContent = text; tip.style.left = moveEvt.clientX + 14 + 'px'; tip.style.top = moveEvt.clientY + 14 + 'px'; }
    moveEvt = null;
  }
  if (ready) {
    const R = live();
    const leakingPipes = new Set(activeIncidents().map((i) => i.pipe));
    const preview = new Set(state.selected && !leakingPipes.has(state.selected) ? ISOLATION[state.selected] || [] : []);
    Object.values(registry).forEach((r) => styleRoot(r, t, leakingPipes, preview, R));
    visuals.forEach((v) => v.marker.scale.setScalar(1 + 0.5 * Math.sin(t * 6)));
  }
  stepAnim();
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
animate();

/* ============ 11. START ============ */
(async () => {
  try {
    await sync();
    setInterval(() => sync().catch(() => setStatus('⚠ Server not reachable', 'bad')), POLL_MS);
  } catch (e) {
    $('#loadError').textContent = 'Cannot reach the server: ' + e.message + ' (is "npm run dev" running?)';
  }
})();
export const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
export const HV = range(17).map((n) => 'hv-' + n);   // hydrant valves
export const SV = range(17).map((n) => 'sv-' + n);   // sprinkler valves
export const FV = range(12).map((n) => 'fv-' + n);   // fire pump room valves
export const VALVES = [...HV, ...SV, ...FV];

export const PIPES = [
  ...[1, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ id: 'pipe-' + n, system: 'Hydrant' })),
  ...[1, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ id: 'spipe-' + n, system: 'Sprinkler' })),
  ...range(6).map((n) => ({ id: 'fp-' + n, system: 'Fire Pump' })),
];

const L = (s) => s.split(',').map((x) => x.trim());
// leaking pipe -> valves to close (from your isolation tables)
export const ISOLATION = {
  'pipe-1':  L('hv-1, hv-2, hv-11'),
  'pipe-3':  L('hv-1, hv-3'),
  'pipe-4':  L('hv-3, hv-4, hv-5, hv-6'),
  'pipe-5':  L('hv-5, hv-9'),
  'pipe-6':  L('hv-7, hv-9, hv-8, hv-2'),
  'pipe-7':  L('hv-9, hv-13, hv-10, hv-6'),
  'pipe-8':  L('hv-10, hv-17, hv-11, hv-12'),
  'pipe-9':  L('hv-12, hv-13, hv-16, hv-14'),
  'pipe-10': L('hv-14, hv-15'),

  'spipe-1':  L('sv-1, sv-2'),
  'spipe-3':  L('sv-1, sv-3'),
  'spipe-4':  L('sv-3, sv-4, sv-5, sv-6'),
  'spipe-5':  L('sv-5'),
  'spipe-6':  L('sv-7, sv-9, sv-2, sv-8'),
  'spipe-7':  L('sv-9, sv-13, sv-10, sv-6'),
  'spipe-8':  L('sv-10, sv-17, sv-11, sv-12'),
  'spipe-9':  L('sv-12, sv-14, sv-16, sv-13'),
  'spipe-10': L('sv-14, sv-15'),

  'fp-1': L('fv-2, fv-1, fv-4, fv-6'),
  'fp-2': L('fv-3, fv-7'),
  'fp-3': L('fv-8, fv-4'),
  'fp-4': L('fv-5, fv-9'),
  'fp-5': L('fv-10, fv-6'),
  'fp-6': L('fv-10, fv-8, fv-12, fv-11'),
};

// valves surrounding each building (image 4)
export const BUILDINGS = [
  { id: 'waste',    name: 'Waste Segregation', valves: ['sv-15', 'hv-15'] },
  { id: 'fgwh',     name: 'FGWH',              valves: ['sv-16', 'hv-16', 'hv-11', 'sv-11'] },
  { id: 'admin',    name: 'Admin',             valves: ['sv-17', 'hv-17'] },
  { id: 'hygiene',  name: 'Hygiene',           valves: ['sv-4', 'hv-4', 'hv-8', 'sv-8'] },
  { id: 'security', name: 'Security',          valves: [] },
  { id: 'fb',       name: 'FB',                valves: [] },
];

export const TANKS = [
  { id: 'tank-1', name: 'Tank 1', capacity: 850 },
  { id: 'tank-2', name: 'Tank 2', capacity: 850 },
];

/* ---------- readiness (shared by server + browser) ---------- */
export const levelOf = (p) => (p >= 90 ? 'ready' : p >= 60 ? 'degraded' : 'critical');
export const LABEL = { ready: 'READY', degraded: 'DEGRADED', critical: 'NOT READY' };
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

// isClosed(valveId) -> bool ; tankPcts -> [percent per tank that has a recorded volume]
export function computeReadiness(isClosed, tankPcts = []) {
  const share = (ids) => Math.round((ids.filter((v) => !isClosed(v)).length / ids.length) * 100);
  const buildings = BUILDINGS.map((b) => {
    const total = b.valves.length, open = b.valves.filter((v) => !isClosed(v)).length;
    const pct = total ? Math.round((open / total) * 100) : null;
    return { id: b.id, name: b.name, valves: b.valves, total, open, pct, level: pct == null ? null : levelOf(pct) };
  });
  const components = [
    { key: 'buildings', label: 'Building protection', pct: avg(buildings.filter((b) => b.pct != null).map((b) => b.pct)) },
    { key: 'pump',      label: 'Fire pump room valves', pct: share(FV) },
    { key: 'network',   label: 'Hydrant & sprinkler valves', pct: share([...HV, ...SV]) },
    { key: 'water',     label: 'Water storage', pct: avg(tankPcts) },
  ];
  components.forEach((c) => (c.level = c.pct == null ? null : levelOf(c.pct)));
  const pct = avg(components.filter((c) => c.pct != null).map((c) => c.pct));
  return { pct, level: levelOf(pct), label: LABEL[levelOf(pct)], buildings, components };
}
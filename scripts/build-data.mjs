// Descarcă din OpenStreetMap datele pentru tot județul Iași și le salvează în data/osm.json,
// ca site-ul să nu depindă de Overpass live. Rulează automat din GitHub Actions.
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('data', { recursive: true });
const EPS = ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.private.coffee/api/interpreter'];
const UA = 'start-stop-on-data-builder (github.com/MateiBernic-spec/start-stop-on)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function overpass(q) {
  for (let round = 0; round < 4; round++) for (const ep of EPS) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: 'data=' + encodeURIComponent(q) });
      if (!r.ok) throw new Error(ep + ' ' + r.status);
      const j = await r.json();
      if (j.remark && /error|timed out|runtime/i.test(j.remark)) throw new Error('remark: ' + j.remark);
      return j;
    } catch (e) { console.error('overpass fail', e.message); await sleep(8000); }
  }
  throw new Error('Overpass indisponibil');
}
const R5 = x => Math.round(x * 1e5) / 1e5;
// Douglas-Peucker, toleranță în grade (~0.00004 ≈ 4 m)
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1;
    const [ay, ax] = pts[a], [by, bx] = pts[b]; const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-18;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = pts[i]; let t = ((px - ax) * dx + (py - ay) * dy) / L; t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol * tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const A = 'area["ISO3166-2"="RO-IS"]["admin_level"="4"]->.c;';
try {
const Q = `[out:json][timeout:600][maxsize:1073741824];${A}
(node["highway"="traffic_signals"](area.c);node["crossing"="traffic_signals"](area.c););
out;
way(bn)["highway"~"^(residential|unclassified|living_street)$"]->.sw;
way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](area.c)->.mw;
(.mw;.sw;);
out geom tags;
nwr["amenity"~"^(hospital|school|kindergarten)$"](area.c);
out center tags;
rel["ISO3166-2"="RO-IS"]["admin_level"="4"];
out geom;`;
const d = await overpass(Q);
const sig = [], roads = [], sens = [], border = [];
for (const el of d.elements) {
  const t = el.tags || {};
  if (el.type === 'node' && (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals')) sig.push([R5(el.lat), R5(el.lon)]);
  else if (el.type === 'relation' && t.admin_level === '4') {
    for (const m of el.members || []) if (m.type === 'way' && m.role !== 'inner' && m.geometry)
      border.push(simplify(m.geometry.map(p => [p.lat, p.lon]), 0.0003).map(p => [R5(p[0]), R5(p[1])]));
  } else if (t.amenity && /^(hospital|school|kindergarten)$/.test(t.amenity)) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat != null) sens.push([t.amenity, t.name || '', R5(lat), R5(lon)]);
  } else if (el.type === 'way' && el.geometry && t.highway) {
    const g = simplify(el.geometry.map(p => [p.lat, p.lon]), 0.00004).map(p => [R5(p[0]), R5(p[1])]);
    roads.push([t.name || t.ref || '', t.highway, g]);
  }
}
if (sig.length < 200 || roads.length < 1500 || sens.length < 100) throw new Error(`date incomplete: ${sig.length} semafoare, ${roads.length} drumuri, ${sens.length} instituții`);
const out = JSON.stringify({ built: new Date().toISOString(), area: 'Județul Iași', sig, roads, sens, border });
await writeFile('data/osm.json', out);
console.log('signals', sig.length, 'roads', roads.length, 'sens', sens.length, 'border', border.length, 'bytes', out.length);

// ---- Sensuri giratorii reale (OSM), cu numele străzilor care intră în ele ----
const QR = `[out:json][timeout:300];${A}
way["junction"~"^(roundabout|circular)$"]["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](area.c);
out geom tags;`;
const dr = await overpass(QR);
const rings = [];
for (const w of dr.elements) if (w.geometry) rings.push({ name: w.tags?.name || '', hw: w.tags.highway, g: w.geometry.map(p => [p.lat, p.lon]) });
// un giratoriu poate fi împărțit în mai multe bucăți de drum: le unim după distanța dintre centre
const cen = g => [g.reduce((a, p) => a + p[0], 0) / g.length, g.reduce((a, p) => a + p[1], 0) / g.length];
const dm = (a, b) => Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 75700);
const groupsR = [];
for (const r of rings) {
  const c = cen(r.g); let gr = groupsR.find(x => dm(x.c, c) < 90);
  if (!gr) { gr = { c, pts: [], names: new Set(), hw: r.hw }; groupsR.push(gr); }
  gr.pts.push(...r.g); if (r.name) gr.names.add(r.name); gr.c = cen(gr.pts);
}
const rank = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4 };
const round = groupsR.map(gr => {
  const rad = Math.max(...gr.pts.map(p => dm(p, gr.c)));
  const near = new Map();
  for (const [n, h, g] of roads) {
    if (!n || /sens giratoriu|giratoriu|rond/i.test(n)) continue;
    let md = 1e9; for (const p of g) md = Math.min(md, dm(p, gr.c));
    if (md < rad + 40) near.set(n, Math.min(near.get(n) ?? 9, rank[(h || '').replace('_link', '')] ?? 9));
  }
  const streets = [...near.entries()].sort((a, b) => a[1] - b[1]).map(x => x[0]).slice(0, 4);
  return [[...gr.names][0] || '', streets, R5(gr.c[0]), R5(gr.c[1]), Math.round(rad), gr.hw];
}).filter(r => r[4] >= 12);
await writeFile('data/roundabouts.json', JSON.stringify(round));
console.log('roundabouts', round.length);
} catch (e) { console.error('MAIN FAIL (păstrez datele vechi):', e.message); }

// ---- Index cu toate străzile cu nume din județ, pentru căutare ----
try {
const QS = `[out:json][timeout:600];${A}
way["highway"]["name"]["highway"!~"^(footway|path|cycleway|steps|bridleway|corridor|platform|proposed|construction)$"](area.c);
out center tags;
node["place"~"^(city|town|village|suburb|neighbourhood|quarter)$"](area.c);
out;
rel["boundary"="administrative"]["admin_level"="8"](area.c);
out geom;`;
const ds = await overpass(QS);
const places = ds.elements.filter(e => e.type === 'node' && e.tags?.place).map(e => ({ n: e.tags.name, t: e.tags.place, lat: e.lat, lon: e.lon })).filter(p => p.n);
// localitatea: cel mai apropiat city/town/village; în municipii păstrăm numele orașului
const settl = places.filter(p => /^(city|town|village)$/.test(p.t));
const near = (lat, lon) => { let b = null, bd = 1e9; for (const p of settl) { const d = (p.lat - lat) ** 2 + ((p.lon - lon) * 0.68) ** 2; if (d < bd) { bd = d; b = p; } } return b ? b.n : ''; };
// comune / orașe (admin_level 8): punct-în-poligon pe segmentele conturului exterior
const communes = ds.elements.filter(e => e.type === 'relation' && e.tags?.name).map(e => {
  const segs = []; let a = 90, b = -90, c = 180, d = -180;
  for (const m of e.members || []) if (m.type === 'way' && m.role !== 'inner' && m.geometry)
    for (let i = 1; i < m.geometry.length; i++) {
      const p = m.geometry[i - 1], q = m.geometry[i]; segs.push([p.lat, p.lon, q.lat, q.lon]);
      a = Math.min(a, p.lat); b = Math.max(b, p.lat); c = Math.min(c, p.lon); d = Math.max(d, p.lon);
    }
  return { n: e.tags.name.replace(/^(Municipiul|Orașul|Oraș|Comuna)\s+/i, ''), segs, bb: [a, b, c, d] };
});
const inside = (cm, lat, lon) => {
  if (lat < cm.bb[0] || lat > cm.bb[1] || lon < cm.bb[2] || lon > cm.bb[3]) return false;
  let k = false;
  for (const [y1, x1, y2, x2] of cm.segs) if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) k = !k;
  return k;
};
const commune = (lat, lon) => { for (const cm of communes) if (inside(cm, lat, lon)) return cm.n; return near(lat, lon); };
console.log('communes', communes.length);
const groups = new Map();
for (const e of ds.elements) {
  if (e.type !== 'way' || !e.center) continue;
  const name = e.tags.name, loc = commune(e.center.lat, e.center.lon), k = name + '|' + loc;
  const g = groups.get(k) || { name, loc, la: 0, lo: 0, n: 0 };
  g.la += e.center.lat; g.lo += e.center.lon; g.n++; groups.set(k, g);
}
const streets = [...groups.values()].map(g => [g.name, g.loc, R5(g.la / g.n), R5(g.lo / g.n)]);
for (const p of places) streets.push([p.n, p.t, R5(p.lat), R5(p.lon)]);
if (streets.length < 2000) throw new Error('index de străzi incomplet: ' + streets.length);
await writeFile('data/streets.json', JSON.stringify(streets));
console.log('streets', streets.length, 'places', places.length);
} catch (e) { console.error('STREETS FAIL (păstrez indexul vechi):', e.message); }

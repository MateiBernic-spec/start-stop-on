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
      return await r.json();
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
const out = JSON.stringify({ built: new Date().toISOString(), area: 'Județul Iași', sig, roads, sens, border });
await writeFile('data/osm.json', out);
console.log('signals', sig.length, 'roads', roads.length, 'sens', sens.length, 'border', border.length, 'bytes', out.length);

// ---- Index cu toate străzile cu nume din județ, pentru căutare ----
const QS = `[out:json][timeout:600];${A}
way["highway"]["name"]["highway"!~"^(footway|path|cycleway|steps|bridleway|corridor|platform|proposed|construction)$"](area.c);
out center tags;
node["place"~"^(city|town|village|suburb|neighbourhood|quarter)$"](area.c);
out;`;
const ds = await overpass(QS);
const places = ds.elements.filter(e => e.type === 'node' && e.tags?.place).map(e => ({ n: e.tags.name, t: e.tags.place, lat: e.lat, lon: e.lon })).filter(p => p.n);
// localitatea: cel mai apropiat city/town/village; în municipii păstrăm numele orașului
const settl = places.filter(p => /^(city|town|village)$/.test(p.t));
const near = (lat, lon) => { let b = null, bd = 1e9; for (const p of settl) { const d = (p.lat - lat) ** 2 + ((p.lon - lon) * 0.68) ** 2; if (d < bd) { bd = d; b = p; } } return b ? b.n : ''; };
const groups = new Map();
for (const e of ds.elements) {
  if (e.type !== 'way' || !e.center) continue;
  const name = e.tags.name, loc = near(e.center.lat, e.center.lon), k = name + '|' + loc;
  const g = groups.get(k) || { name, loc, la: 0, lo: 0, n: 0 };
  g.la += e.center.lat; g.lo += e.center.lon; g.n++; groups.set(k, g);
}
const streets = [...groups.values()].map(g => [g.name, g.loc, R5(g.la / g.n), R5(g.lo / g.n)]);
for (const p of places) streets.push([p.n, p.t, R5(p.lat), R5(p.lon)]);
await writeFile('data/streets.json', JSON.stringify(streets));
console.log('streets', streets.length, 'places', places.length);

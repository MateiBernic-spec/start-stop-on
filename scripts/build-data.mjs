// Descarcă din OpenStreetMap străzile, semafoarele și instituțiile din Iași
// și le salvează în data/osm.json, ca site-ul să nu mai depindă de Overpass live.
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('data', { recursive: true });
const BBOX = '47.080,27.460,47.225,27.700';
const EPS = ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.private.coffee/api/interpreter'];
const UA = 'start-stop-on-data-builder (github.com/MateiBernic-spec/start-stop-on)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function overpass(q) {
  for (let round = 0; round < 3; round++) for (const ep of EPS) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: 'data=' + encodeURIComponent(q) });
      if (!r.ok) throw new Error(ep + ' ' + r.status);
      return await r.json();
    } catch (e) { console.error('overpass fail', e.message); await sleep(5000); }
  }
  throw new Error('Overpass indisponibil');
}
const R5 = x => Math.round(x * 1e5) / 1e5;

const Q = `[out:json][timeout:240];
(node["highway"="traffic_signals"](${BBOX});node["crossing"="traffic_signals"](${BBOX}););
out;
way(bn)["highway"~"^(residential|unclassified|living_street)$"]->.sw;
way["highway"~"^(trunk|primary|secondary|tertiary)(_link)?$"](${BBOX})->.mw;
(.mw;.sw;);
out geom tags;
nwr["amenity"~"^(hospital|school|kindergarten)$"](${BBOX});
out center tags;`;
const d = await overpass(Q);
const sig = [], roads = [], sens = [];
for (const el of d.elements) {
  const t = el.tags || {};
  if (el.type === 'node' && (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals')) sig.push([R5(el.lat), R5(el.lon)]);
  else if (t.amenity && /^(hospital|school|kindergarten)$/.test(t.amenity)) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat != null) sens.push([t.amenity, t.name || '', R5(lat), R5(lon)]);
  } else if (el.type === 'way' && el.geometry && t.highway) {
    roads.push([t.name || '', t.highway, el.geometry.map(p => [R5(p.lat), R5(p.lon)])]);
  }
}
await writeFile('data/osm.json', JSON.stringify({ built: new Date().toISOString(), sig, roads, sens }));
console.log('signals', sig.length, 'roads', roads.length, 'sens', sens.length);

// Raport de verificare pentru coordonatele zonelor
const NOM = ['Podu Roș, Iași','Piața Unirii, Iași','Târgu Cucu, Iași','Iulius Mall, Iași','CUG, Iași','Pasajul Nicolina, Iași','Gara Iași',
  'Tătărași, Iași','Calea Chișinăului, Iași','Lunca Cetățuii','Valea Lupului, Iași','Dancu, Holboca','Breazu, Rediu','Piața Voievozilor, Iași',
  'Pasajul Octav Băncilă, Iași','Moara de Foc, Iași','Piața Mihai Eminescu, Iași','Bulevardul Chimiei, Iași','Bucium, Iași','Parcul Copou, Iași',
  'Spitalul Sfântul Spiridon, Iași','Palas, Iași','Rond Gara Iași','Piața Mihai Eminescu','Rondul Podu Roș'];
const nom = {};
for (const q of NOM) {
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=3&countrycodes=ro&q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA } });
    nom[q] = (await r.json()).map(x => ({ n: x.display_name.split(',').slice(0, 3).join(','), t: x.class + '/' + x.type, c: [R5(+x.lat), R5(+x.lon)] }));
  } catch (e) { nom[q] = String(e); }
  await sleep(1200);
}
const PAIRS = [['Cantemir','Iorga'],['Vladimirescu','Iorga'],['Vladimirescu','Cantemir'],['Târgu Cucu','Cantemir'],['Independenței','Cuza Vodă'],
  ['Independenței','Carol'],['Nicolina','Primăverii'],['Nicolina','Poitiers'],['Nicolina','Ciurea'],['Păcurari','Octav Băncilă'],['Păcurari','Arcu'],
  ['Silvestru','Gării'],['Chi.in.ului','Socola'],['Chi.in.ului','Vladimirescu'],['Alexandru cel Bun','Dacia'],['Moara de Foc','Socola'],
  ['Carol','Eminescu'],['Chimiei','Chi.in.ului'],['Vladimirescu','Chi.in.ului'],['Ciurea','Lunca'],['Păcurari','Valea Lupului'],['Copou','Breazu']];
const inter = {};
for (const [a, b] of PAIRS) {
  try {
    const r = await overpass(`[out:json][timeout:60];way["highway"]["name"~"${a}",i](${BBOX})->.a;way["highway"]["name"~"${b}",i](${BBOX})->.b;node(w.a)(w.b);out;`);
    inter[a + ' × ' + b] = r.elements.map(n => [R5(n.lat), R5(n.lon)]);
  } catch (e) { inter[a + ' × ' + b] = String(e); }
  await sleep(1500);
}
await writeFile('data/geocode-report.json', JSON.stringify({ nom, inter }, null, 1));

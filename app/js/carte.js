// Jamais à sec — le Radar
// Fond de carte : MapLibre GL + OpenFreeMap (style Positron recoloré en noir et jaune).
// Par-dessus : une couche three.js qui dessine les zones en rupture comme une moisissure qui se propage.

import * as THREE from 'three';

const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const FOYERS_MAX = 32;
const FENETRE_MIN = 48 * 60; // rejouer les 48 dernières heures

// Shader de contamination (positions en km, repère local centré sur l'utilisateur)
const BRUIT = `
vec3 permute(vec3 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy)); vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1; i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0; vec3 h = abs(x) - 0.5; vec3 ox = floor(x + 0.5); vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g; g.x = a0.x * x0.x + h.x * x0.y; g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * snoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s; }`;

const FRAGMENT = `
precision highp float;
uniform float uT; uniform float uTime; uniform int uN;
uniform vec4 uF[${FOYERS_MAX}];
uniform vec2 uOrig; uniform vec2 uKmPx; uniform vec2 uRes;
${BRUIT}
float champ(vec2 p){
  float f = 0.0;
  for (int i = 0; i < ${FOYERS_MAX}; i++) {
    if (i >= uN) break;
    vec4 F = uF[i];
    float k = clamp((uT - F.z) / max(1.0 - F.z, 0.001), 0.0, 1.0);
    float r = mix(0.3, F.w, k);
    float d = length(p - F.xy);
    f += exp(-pow(d / r, 2.0) * 2.2) * clamp(k / 0.08, 0.0, 1.0);
  }
  return f;
}
void main(){
  vec2 ecran = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = uOrig + ecran * uKmPx;
  vec2 q = p + vec2(fbm(p * 0.35 + uTime * 0.02), fbm(p * 0.35 + vec2(5.2, 1.3) - uTime * 0.015)) * 0.6;
  float f = champ(q);
  if (f < 0.04) discard;
  float n = fbm(p * 1.6 + uTime * 0.03); float g = f + n * 0.18;
  float corps = smoothstep(0.42, 0.62, g);
  float bord = smoothstep(0.30, 0.48, g) * (1.0 - smoothstep(0.50, 0.70, g));
  float r1 = 1.0 - abs(snoise(q * 3.0 + uTime * 0.01)); float r2 = 1.0 - abs(snoise(q * 7.0 - uTime * 0.02));
  float veines = (pow(r1, 14.0) * 0.9 + pow(r2, 18.0) * 0.6) * smoothstep(0.10, 0.50, f + n * 0.2);
  float pouls = 0.82 + 0.18 * sin(uTime * 2.4 - f * 9.0);
  float cellules = smoothstep(0.0, 0.7, fbm(p * 5.0 + uTime * 0.05) + 0.35);
  vec3 col = mix(vec3(0.26, 0.0, 0.15), vec3(0.72, 0.05, 0.40), cellules * 0.65);
  col = mix(col, vec3(1.0, 0.30, 0.66), clamp(veines * 1.2 + bord * 0.8 * pouls, 0.0, 1.0));
  float a = clamp(corps * 0.55 + veines * 0.9 + bord * 0.5 * pouls, 0.0, 0.8);
  gl_FragColor = vec4(col, a);
}`;

function cercleGeo(lat, lng, rayonKm, n = 72) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = i / n * Math.PI * 2;
    pts.push([lng + Math.cos(a) * rayonKm / (111.32 * Math.cos(lat * Math.PI / 180)), lat + Math.sin(a) * rayonKm / 110.57]);
  }
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: {} };
}

// Recolore le style Positron : fond noir, routes jaunes, eau bleu nuit, libellés gris
function recolorer(map) {
  const set = (id, prop, val) => { try { map.setPaintProperty(id, prop, val); } catch (e) {} };
  for (const l of map.getStyle().layers) {
    const id = l.id.toLowerCase();
    if (l.type === 'background') set(l.id, 'background-color', '#0F0F0F');
    else if (l.type === 'fill') {
      if (id.includes('water')) set(l.id, 'fill-color', '#1C2630');
      else if (id.includes('building')) set(l.id, 'fill-color', '#1A1A1A');
      else set(l.id, 'fill-color', '#141414');
      set(l.id, 'fill-outline-color', 'rgba(0,0,0,0)');
    } else if (l.type === 'line') {
      if (id.includes('water') || id.includes('river')) set(l.id, 'line-color', '#1C2630');
      else if (id.includes('casing')) set(l.id, 'line-color', '#0F0F0F');
      else if (id.includes('rail')) set(l.id, 'line-color', '#333333');
      else if (id.includes('boundary') || id.includes('admin')) set(l.id, 'line-color', '#3A3A3A');
      else if (/motorway|trunk|primary|major/.test(id)) { set(l.id, 'line-color', '#FFCC00'); set(l.id, 'line-opacity', 0.75); }
      else if (/road|highway|street|secondary|tertiary|minor|path|bridge|tunnel/.test(id)) { set(l.id, 'line-color', '#FFCC00'); set(l.id, 'line-opacity', 0.32); }
    } else if (l.type === 'symbol') {
      if (id.includes('poi')) { try { map.setLayoutProperty(l.id, 'visibility', 'none'); } catch (e) {} }
      set(l.id, 'text-color', '#BDBDBD'); set(l.id, 'text-halo-color', '#000000'); set(l.id, 'text-halo-width', 1.2);
    }
  }
}

export async function creerRadar({ app }) {
  const { P, S } = app;
  if (!window.maplibregl) throw new Error('MapLibre non chargé');
  const conteneur = document.getElementById('carte');
  const toile = document.getElementById('contamination');
  const elT = document.getElementById('t'), elQ = document.getElementById('quand'), info = document.getElementById('rinfo');
  const play = document.getElementById('play');

  const centre = P.position ? [P.position.lng, P.position.lat] : [2.35, 48.85];
  const map = new maplibregl.Map({
    container: conteneur, style: STYLE, center: centre, zoom: 11, minZoom: 5, maxZoom: 17,
    dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: { compact: true }
  });
  map.touchZoomRotate.disableRotation();
  map.on('style.load', () => recolorer(map));

  let pret = false, visible = false, T = 1, lecture = false, debutLecture = 0, posAffichee = null;
  const vide = { type: 'FeatureCollection', features: [] };
  const moi = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'marqueur-moi' }) });
  const elPep = document.createElement('div'); elPep.className = 'marqueur-pepite'; elPep.innerHTML = '<b></b><i></i>';
  const pepite = new maplibregl.Marker({ element: elPep, anchor: 'bottom', offset: [0, -10] });

  map.on('load', () => {
    map.addSource('rayon', { type: 'geojson', data: vide });
    map.addSource('trajet', { type: 'geojson', data: vide });
    map.addSource('stations', { type: 'geojson', data: vide });
    map.addLayer({ id: 'rayon', type: 'line', source: 'rayon', paint: { 'line-color': '#FFFFFF', 'line-opacity': 0.25, 'line-width': 2, 'line-dasharray': [3, 3] } });
    map.addLayer({ id: 'trajet', type: 'line', source: 'trajet', paint: { 'line-color': '#FFFFFF', 'line-opacity': 0.9, 'line-width': 4, 'line-dasharray': [2, 1.5] } });
    map.addLayer({
      id: 'stations', type: 'circle', source: 'stations', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 12, 7, 15, 10],
        'circle-color': ['match', ['get', 'etat'], 'ok', '#FFCC00', 'vieux', '#9C8A3C', 'rupture', '#5A2A44', '#666666'],
        'circle-stroke-color': ['match', ['get', 'etat'], 'rupture', '#FF3D9A', '#111111'],
        'circle-stroke-width': 2
      }
    });
    map.on('click', 'stations', e => { const f = e.features && e.features[0]; if (f) app.ouvrirStation(f.properties.id); });
    map.on('mouseenter', 'stations', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'stations', () => { map.getCanvas().style.cursor = ''; });
    pret = true;
    maj();
  });

  // ---- Couche three.js ----
  const renderer = new THREE.WebGLRenderer({ canvas: toile, alpha: true, antialias: false, premultipliedAlpha: false });
  let qualite = 0.5; // la moisissure est floue par nature : on la calcule en demi-résolution
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const uniforms = {
    uT: { value: 1 }, uTime: { value: 0 }, uN: { value: 0 },
    uF: { value: Array.from({ length: FOYERS_MAX }, () => new THREE.Vector4()) },
    uOrig: { value: new THREE.Vector2() }, uKmPx: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() }
  };
  const materiau = new THREE.ShaderMaterial({ uniforms, transparent: true, depthTest: false, vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: FRAGMENT });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), materiau));
  function redim() {
    const w = toile.clientWidth || 1, h = toile.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * qualite);
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', () => { if (visible) { redim(); map.resize(); } });

  // Repère local en km, centré sur l'utilisateur
  const origine = () => P.position || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  function versKm(lng, lat) {
    const o = origine();
    return [(lng - o.lng) * 111.32 * Math.cos(o.lat * Math.PI / 180), (lat - o.lat) * 110.57];
  }

  // ---- Données de la carte ----
  let foyers = [];
  function tempsReplay() { return Math.round(Date.now() / 60000) - FENETRE_MIN * (1 - T); }
  function maj() {
    if (!pret) return;
    const c = P.carbu, now = Math.round(Date.now() / 60000), tps = tempsReplay();
    document.querySelectorAll('#ecran-radar [data-carbu]').forEach(b => { b.textContent = app.nomCarbu(); });
    if (P.position) {
      moi.setLngLat([P.position.lng, P.position.lat]).addTo(map);
      const cle = P.position.lat + ',' + P.position.lng;
      if (posAffichee !== cle) { posAffichee = cle; map.jumpTo({ center: [P.position.lng, P.position.lat] }); }
      map.getSource('rayon').setData(P.mode === 'trajet' && P.trajet ? vide : cercleGeo(P.position.lat, P.position.lng, P.rayon));
      map.getSource('trajet').setData(P.mode === 'trajet' && P.trajet
        ? { type: 'Feature', geometry: { type: 'LineString', coordinates: [[P.position.lng, P.position.lat], [P.trajet.lng, P.trajet.lat]] }, properties: {} } : vide);
    }
    // Stations : état au moment rejoué
    let nok = 0, nko = 0;
    const feats = [], ruptures = [];
    for (const s of S.stations) {
      const prixC = s.p[c], rupt = s.r && c in s.r;
      if (!prixC && !rupt) continue;
      const debut = rupt ? (s.r[c] || now - FENETRE_MIN) : null;
      const enRupture = rupt && debut <= tps;
      const dans = P.position ? Math.hypot(...versKm(s.lng, s.lat)) <= P.rayon : true;
      let etat = enRupture ? 'rupture' : (prixC && now - prixC[1] > 48 * 60 ? 'vieux' : 'ok');
      if (!dans && !enRupture) etat = etat === 'ok' ? 'ok' : etat;
      if (dans) { if (enRupture) nko++; else nok++; }
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { id: s.id, etat } });
      if (rupt) ruptures.push({ s, debut });
    }
    map.getSource('stations').setData({ type: 'FeatureCollection', features: feats });
    document.getElementById('nok').textContent = nok;
    document.getElementById('nko').textContent = nko;
    const h = Math.round(48 * (1 - T)); elQ.textContent = h === 0 ? 'Maintenant' : 'Il y a ' + h + ' h';

    // Foyers : les ruptures les plus proches du centre de la carte
    const ctr = map.getCenter(), [cx, cy] = versKm(ctr.lng, ctr.lat);
    foyers = ruptures.map(r => { const [x, y] = versKm(r.s.lng, r.s.lat); return { x, y, d: Math.hypot(x - cx, y - cy), debut: r.debut }; })
      .sort((a, b) => a.d - b.d).slice(0, FOYERS_MAX);
    uniforms.uN.value = foyers.length;
    const depart = now - FENETRE_MIN;
    foyers.forEach((f, i) => uniforms.uF.value[i].set(f.x, f.y, Math.min(0.999, Math.max(0, (f.debut - depart) / FENETRE_MIN)), 1.4));

    // Meilleur bon plan
    const R = app.calculer();
    const best = R && R.classement.find(x => x.verdict !== 'reference' && x.gain > 1.5 && x.ageHeures <= 48);
    if (best && T >= 0.999) {
      elPep.querySelector('b').textContent = 'Éco ' + best.gain.toFixed(2).replace('.', ',') + ' €';
      pepite.setLngLat([best.station.lng, best.station.lat]).addTo(map);
    } else pepite.remove();

    // Message
    const total = nok + nko;
    if (!P.position) info.innerHTML = '<span>Choisissez votre position dans « Mon véhicule ».</span>';
    else if (!S.stations.length) info.innerHTML = '<span>Chargement des stations…</span>';
    else if (total && nko / total > 0.2) { info.className = 'tension'; info.innerHTML = `<span>Tension : ${Math.round(nko / total * 100)} % des stations à sec autour de vous. ${nok} restent approvisionnées.</span>`; }
    else { info.className = ''; info.innerHTML = nko ? `<span>${nko} station${nko > 1 ? 's' : ''} en rupture de ${app.nomCarbu().toLowerCase()} dans ${P.rayon} km. Touchez une station pour le détail.</span>` : `<span>Aucune rupture de ${app.nomCarbu().toLowerCase()} dans ${P.rayon} km.</span>`; }
  }
  map.on('moveend', () => { if (visible) maj(); });

  // ---- Rejouer ----
  function stop() { lecture = false; document.getElementById('icoPlay').style.display = ''; document.getElementById('icoPause').style.display = 'none'; play.setAttribute('aria-label', 'Lire les 48 dernières heures'); }
  elT.addEventListener('input', () => { stop(); T = elT.value / 1000; uniforms.uT.value = T; maj(); });
  play.addEventListener('click', () => {
    if (lecture) { stop(); return; }
    lecture = true; if (T >= 0.999) T = 0;
    debutLecture = performance.now() - T * 9000;
    document.getElementById('icoPlay').style.display = 'none'; document.getElementById('icoPause').style.display = ''; play.setAttribute('aria-label', 'Mettre en pause');
  });

  // ---- Boucle d'affichage ----
  const horloge = new THREE.Clock(); let cumul = 0, images = 0, raf = 0, derniereMaj = 0;
  function boucle() {
    if (!visible) { raf = 0; return; }
    const dt = horloge.getDelta();
    uniforms.uTime.value = horloge.elapsedTime;
    if (lecture) {
      T = Math.min(1, (performance.now() - debutLecture) / 9000);
      elT.value = Math.round(T * 1000); uniforms.uT.value = T;
      if (performance.now() - derniereMaj > 250) { derniereMaj = performance.now(); maj(); }
      if (T >= 1) { stop(); maj(); }
    }
    // Correspondance écran -> km (pas de rotation ni d'inclinaison sur cette carte)
    const w = toile.clientWidth || 1, h = toile.clientHeight || 1;
    const hg = map.unproject([0, 0]), bd = map.unproject([w, h]);
    const [x0, y0] = versKm(hg.lng, hg.lat), [x1, y1] = versKm(bd.lng, bd.lat);
    const W = renderer.domElement.width, H = renderer.domElement.height;
    uniforms.uOrig.value.set(x0, y0);
    uniforms.uKmPx.value.set((x1 - x0) / W, (y1 - y0) / H);
    uniforms.uRes.value.set(W, H);
    renderer.render(scene, camera);
    cumul += dt; images++;
    if (images === 90) { if (cumul / images * 1000 > 30 && qualite > 0.3) { qualite = 0.3; redim(); } cumul = 0; images = 0; }
    raf = requestAnimationFrame(boucle);
  }

  return {
    montrer() {
      visible = true;
      requestAnimationFrame(() => { map.resize(); redim(); maj(); horloge.getDelta(); if (!raf) raf = requestAnimationFrame(boucle); });
    },
    cacher() { visible = false; stop(); },
    maj() { if (visible) maj(); }
  };
}

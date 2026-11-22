// Enseignes des stations (Intermarché, TotalEnergies, E.Leclerc…)
// Le flux officiel ne donne pas la marque. On la prend dans OpenStreetMap (licence ODbL) :
// une fois par semaine, on télécharge toutes les stations-service de France connues d'OSM,
// puis on associe chaque station officielle à la station OSM la plus proche (moins de 150 m).

import fs from 'node:fs/promises';

export const OVERPASS = 'https://overpass-api.de/api/interpreter';
const REQUETE = `[out:json][timeout:300];
area["ISO3166-1"="FR"][admin_level=2]->.fr;
(node["amenity"="fuel"](area.fr);way["amenity"="fuel"](area.fr););
out center tags;`;
export const VALIDITE_JOURS = 7;
const DISTANCE_MAX_M = 150;      // toujours accepté
const DISTANCE_MUTUELLE_M = 350;  // accepté si les deux sont mutuellement les plus proches (coordonnées officielles parfois approximatives)

// Noms harmonisés pour les enseignes les plus courantes (cherchés n'importe où dans le nom :
// « Station Total », « Relais Total Itteville », « Super U Mennecy »…)
const MARQUES = [
  [/total\s*energies|\btotal\b|\belf\b/i, 'TotalEnergies'],
  [/leclerc/i, 'E.Leclerc'],
  [/intermarch/i, 'Intermarché'],
  [/carrefour/i, 'Carrefour'],
  [/auchan/i, 'Auchan'],
  [/\b(super u|hyper u|u express|syst[eè]me u|station u|magasins? u)\b|^u$/i, 'Système U'],
  [/\besso\b/i, 'Esso'],
  [/\bbp\b/i, 'BP'],
  [/\bavia\b/i, 'Avia'],
  [/\bshell\b/i, 'Shell'],
  [/casino/i, 'Casino'],
  [/\bnetto\b/i, 'Netto'],
  [/dyneff/i, 'Dyneff'],
  [/\bagip\b|\beni\b/i, 'Eni'],
  [/\bcora\b/i, 'Cora'],
  [/\bmatch\b/i, 'Match'],
  [/\bvito\b/i, 'Vito'],
  [/\bspar\b/i, 'Spar'],
  [/\bcolruyt\b/i, 'Colruyt'],
  [/\blidl\b/i, 'Lidl'],
  [/\bal\s*fatah?\b/i, null]
];
const GENERIQUES = /^(station[- ]?service|station|carburants?|essence|fuel|gas station|pompes?|distributeur|libre[- ]service|aire de service|lavage|gpl|adblue|ad blue)s?$/i;
export const VERSION = 3;

/** Nom à afficher : une enseigne connue, sinon la marque déclarée, sinon le nom de la station (« Garage du Centre »). */
export function normaliserMarque(tags) {
  const champs = [tags.brand, tags.name, tags['brand:fr'], tags.operator].map(v => (v ? String(v).trim() : '')).filter(Boolean);
  for (const t of champs) for (const [re, nom] of MARQUES) if (re.test(t)) return nom;
  for (const t of [tags.brand, tags.name]) {
    const v = t ? String(t).trim() : '';
    if (v && !GENERIQUES.test(v) && v.length <= 28) return v;
  }
  return null;
}

/** Télécharge les stations OSM. Renvoie { genere, marques: [...], points: [[lat, lng, indexMarque], …] } */
export async function telechargerOSM() {
  const rep = await fetch(OVERPASS, {
    method: 'POST', body: 'data=' + encodeURIComponent(REQUETE),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'JamaisASec/1.0 (open data; studio.sebdesign@gmail.com)' },
    signal: AbortSignal.timeout(360000)
  });
  if (!rep.ok) throw new Error('Overpass HTTP ' + rep.status);
  return depuisOSM(await rep.json());
}

export function depuisOSM(json, maintenant = Date.now()) {
  const marques = [], index = new Map(), points = [], refs = {};
  const idxMarque = m => { if (!m) return -1; if (!index.has(m)) { index.set(m, marques.length); marques.push(m); } return index.get(m); };
  for (const e of json.elements || []) {
    const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    const t = e.tags || {};
    const i = idxMarque(normaliserMarque(t));
    const pt = [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, i];
    // Identifiant officiel prix-carburants renseigné dans OSM : association sûre, même si les coordonnées officielles sont fausses
    const ref = String(t['ref:FR:prix-carburants'] || '').split(/[;,\s]+/).filter(x => /^\d{6,9}$/.test(x));
    for (const r of ref) refs[r] = pt;
    if (!ref.length && i >= 0) points.push(pt);
  }
  return { version: VERSION, source: 'OpenStreetMap (ODbL), via Overpass API', genere: new Date(maintenant).toISOString(), marques, refs, points };
}

export async function lireEnseignes(source) {
  if (!source) return null;
  try {
    if (/^https?:/.test(source)) {
      const r = await fetch(source, { signal: AbortSignal.timeout(30000) });
      return r.ok ? await r.json() : null;
    }
    return JSON.parse(await fs.readFile(source, 'utf8'));
  } catch { return null; }
}

/** Ajoute s.m (l'enseigne) aux stations et corrige leur position si besoin. Renvoie { marques, positions }.
 *  1) par identifiant officiel (tag OSM ref:FR:prix-carburants) : enseigne + position OSM si l'officielle est décalée ;
 *  2) sinon par proximité : moins de 150 m, ou jusqu'à 350 m si les deux sont mutuellement les plus proches. */
export function associer(stations, enseignes) {
  const res = { marques: 0, positions: 0 };
  if (!enseignes) return res;
  const dist = (p, s) => Math.hypot((p[1] - s.lng) * 111320 * Math.cos(s.lat * Math.PI / 180), (p[0] - s.lat) * 110570);
  const restantes = [];
  for (const s of stations) {
    const p = enseignes.refs?.[s.id];
    if (!p) { restantes.push(s); continue; }
    if (p[2] >= 0) { s.m = enseignes.marques[p[2]]; res.marques++; }
    const d = dist(p, s);
    if (d > 40 && d < 8000) { s.lat = p[0]; s.lng = p[1]; res.positions++; }
    if (p[2] < 0) restantes.push(s); // position corrigée mais pas de nom : on tente la proximité
  }
  if (!enseignes.points?.length) return res;
  const pas = 0.01, cle = (a, b) => a + ':' + b; // cases d'environ 1 km
  const grille = new Map();
  for (const p of enseignes.points) {
    const k = cle(Math.floor(p[0] / pas), Math.floor(p[1] / pas));
    if (!grille.has(k)) grille.set(k, []);
    grille.get(k).push(p);
  }
  const choix = [], plusProcheDuPoint = new Map();
  for (const s of restantes) {
    const gi = Math.floor(s.lat / pas), gj = Math.floor(s.lng / pas);
    let best = null, bd = DISTANCE_MUTUELLE_M;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const p of grille.get(cle(gi + di, gj + dj)) || []) {
        const d = dist(p, s);
        if (d < bd) { bd = d; best = p; }
        const q = plusProcheDuPoint.get(p);
        if (d <= DISTANCE_MUTUELLE_M && (!q || d < q.d)) plusProcheDuPoint.set(p, { s, d });
      }
    }
    if (best) choix.push([s, best, bd]);
  }
  for (const [s, p, d] of choix) {
    if (d <= DISTANCE_MAX_M || plusProcheDuPoint.get(p)?.s === s) { s.m = enseignes.marques[p[2]]; res.marques++; }
  }
  return res;
}

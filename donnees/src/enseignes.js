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
const DISTANCE_MAX_M = 150;

// Noms harmonisés pour les enseignes les plus courantes
const MARQUES = [
  [/^total\s*energies|^totalenergies|^total(\s+access)?$|^elf$/i, 'TotalEnergies'],
  [/leclerc/i, 'E.Leclerc'],
  [/intermarch/i, 'Intermarché'],
  [/^carrefour/i, 'Carrefour'],
  [/^auchan/i, 'Auchan'],
  [/^(super u|hyper u|u express|système u|systeme u|station u|^u$)/i, 'Système U'],
  [/^esso/i, 'Esso'],
  [/^bp$|^bp\s/i, 'BP'],
  [/^avia/i, 'Avia'],
  [/^shell/i, 'Shell'],
  [/^casino|g[ée]ant casino/i, 'Casino'],
  [/^netto/i, 'Netto'],
  [/^dyneff/i, 'Dyneff'],
  [/^agip|^eni$/i, 'Eni'],
  [/^cora/i, 'Cora'],
  [/^match$/i, 'Match'],
  [/^vito/i, 'Vito'],
  [/^ad blue|^adblue/i, null]
];
const GENERIQUES = /^(station[- ]service|station|carburant|essence|fuel|gas station|pompe)s?$/i;

export function normaliserMarque(tags) {
  for (const brut of [tags.brand, tags.name, tags.operator]) {
    if (!brut) continue;
    const t = String(brut).trim();
    if (!t || GENERIQUES.test(t)) continue;
    for (const [re, nom] of MARQUES) if (re.test(t)) return nom;
    if (brut === tags.brand) return t.length <= 28 ? t : null; // marque inconnue mais déclarée
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
  const marques = [], index = new Map(), points = [];
  for (const e of json.elements || []) {
    const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    const m = normaliserMarque(e.tags || {});
    if (!m) continue;
    if (!index.has(m)) { index.set(m, marques.length); marques.push(m); }
    points.push([Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, index.get(m)]);
  }
  return { version: 1, source: 'OpenStreetMap (ODbL), via Overpass API', genere: new Date(maintenant).toISOString(), marques, points };
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

/** Ajoute s.m (la marque) aux stations, par plus proche voisin à moins de 150 m. Renvoie le nombre trouvé. */
export function associer(stations, enseignes) {
  if (!enseignes?.points?.length) return 0;
  const grille = new Map(), cle = (a, b) => a + ':' + b, pas = 0.01; // cases d'environ 1 km
  for (const p of enseignes.points) {
    const k = cle(Math.floor(p[0] / pas), Math.floor(p[1] / pas));
    if (!grille.has(k)) grille.set(k, []);
    grille.get(k).push(p);
  }
  let n = 0;
  for (const s of stations) {
    const gi = Math.floor(s.lat / pas), gj = Math.floor(s.lng / pas);
    let best = null, bd = DISTANCE_MAX_M;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const p of grille.get(cle(gi + di, gj + dj)) || []) {
        const dx = (p[1] - s.lng) * 111320 * Math.cos(s.lat * Math.PI / 180), dy = (p[0] - s.lat) * 110570;
        const d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; best = p; }
      }
    }
    if (best) { s.m = enseignes.marques[best[2]]; n++; }
  }
  return n;
}

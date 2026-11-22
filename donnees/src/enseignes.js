// Enseignes des stations (Intermarché, TotalEnergies, E.Leclerc…) et positions corrigées.
// Le flux officiel ne donne ni la marque ni toujours la bonne position. Deux sources, une fois par semaine :
//  1) le « Référentiel des noms et enseignes de stations-service » publié sur data.gouv.fr (Chiffrex, ODbL),
//     qui relie le numéro officiel de chaque station à son nom et à sa position OpenStreetMap ;
//  2) en complément, OpenStreetMap directement (Overpass) : numéro officiel si renseigné, sinon proximité.

import fs from 'node:fs/promises';

export const REFERENTIEL = 'https://www.data.gouv.fr/api/1/datasets/r/0207ded0-2d19-47af-b1a6-62915ec1b721';
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
  [/carrefour|^market$/i, 'Carrefour'],
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
export const VERSION = 5;

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

/**
 * Horaires OpenStreetMap (« Mo-Fr 07:00-20:00; Sa 08:00-19:00; Su off », « 24/7 »…) → 7 jours au format de l'app.
 * Ne gère que les formes simples, les plus courantes ; renvoie undefined si le texte n'est pas compris (on n'invente rien).
 */
const JOURS_OSM = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
export function lireOpeningHours(texte) {
  const t = String(texte || '').trim();
  if (!t) return undefined;
  if (/^24\/7$/.test(t)) return Array.from({ length: 7 }, () => [0, 1440]);
  const jours = [null, null, null, null, null, null, null];
  for (let regle of t.split(';')) {
    regle = regle.trim();
    if (!regle) continue;
    if (/^PH\b|^SH\b/.test(regle)) continue; // jours fériés / vacances : ignorés
    const m = regle.match(/^([A-Za-z,\- ]+?)\s+(off|closed|(?:\d{1,2}:\d{2}-\d{1,2}:\d{2}\s*,?\s*)+)$/i);
    const m24 = !m && regle.match(/^(\d{1,2}:\d{2}-\d{1,2}:\d{2}\s*,?\s*)+$/) ? ['', 'Mo-Su', regle] : null;
    const r = m || m24;
    if (!r) return undefined;
    const idx = [];
    for (const part of r[1].replace(/\s/g, '').split(',')) {
      const [a, b] = part.split('-');
      const ia = JOURS_OSM.indexOf(a), ib = b ? JOURS_OSM.indexOf(b) : ia;
      if (ia < 0 || ib < 0) return undefined;
      for (let k = ia; ; k = (k + 1) % 7) { idx.push(k); if (k === ib) break; }
    }
    let val;
    if (/^(off|closed)$/i.test(r[2])) val = 0;
    else {
      val = [];
      for (const pl of r[2].matchAll(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/g)) val.push(+pl[1] * 60 + +pl[2], Math.min(1440, +pl[3] * 60 + +pl[4]));
      if (!val.length) return undefined;
    }
    for (const k of idx) jours[k] = val;
  }
  return jours.some(j => j !== null) ? jours : undefined;
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
    const oh = lireOpeningHours(t.opening_hours);
    if (oh) pt.push(oh);
    // Identifiant officiel prix-carburants renseigné dans OSM : association sûre, même si les coordonnées officielles sont fausses
    const ref = String(t['ref:FR:prix-carburants'] || '').split(/[;,\s]+/).filter(x => /^\d{6,9}$/.test(x));
    for (const r of ref) refs[r] = pt;
    if (!ref.length && (i >= 0 || oh)) points.push(pt);
  }
  return { version: VERSION, source: 'OpenStreetMap (ODbL), via Overpass API', genere: new Date(maintenant).toISOString(), marques, refs, points };
}

/** Découpe une ligne CSV (guillemets gérés). */
function champsCSV(ligne) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (q) { if (c === '"') { if (ligne[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Lit le référentiel data.gouv : { marques, refs: { idOfficiel: [lat, lng, indexMarque] } } */
export function depuisReferentiel(texte) {
  const lignes = texte.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const entete = champsCSV(lignes[0]).map(x => x.trim().toLowerCase());
  const col = n => entete.indexOf(n);
  const cId = col('id_station_officiel'), cNom = col('nom_normalise'), cLat = col('latitude_osm'), cLng = col('longitude_osm');
  if (cId < 0 || cNom < 0) throw new Error('colonnes inattendues : ' + entete.join(','));
  const marques = [], index = new Map(), refs = {};
  for (const l of lignes.slice(1)) {
    const f = champsCSV(l);
    const id = (f[cId] || '').trim();
    if (!/^\d{6,9}$/.test(id)) continue;
    const m = normaliserMarque({ brand: f[cNom] });
    let i = -1;
    if (m) { if (!index.has(m)) { index.set(m, marques.length); marques.push(m); } i = index.get(m); }
    const lat = parseFloat(f[cLat]), lng = parseFloat(f[cLng]);
    if (i < 0 && !(isFinite(lat) && isFinite(lng))) continue;
    refs[id] = [isFinite(lat) ? Math.round(lat * 1e5) / 1e5 : null, isFinite(lng) ? Math.round(lng * 1e5) / 1e5 : null, i];
  }
  return { marques, refs };
}

export async function telechargerReferentiel() {
  const rep = await fetch(REFERENTIEL, { redirect: 'follow', headers: { 'User-Agent': 'JamaisASec/1.0 (studio.sebdesign@gmail.com)' }, signal: AbortSignal.timeout(120000) });
  if (!rep.ok) throw new Error('data.gouv HTTP ' + rep.status);
  return depuisReferentiel(await rep.text());
}

/** Assemble les sources disponibles (référentiel prioritaire pour les numéros officiels, OSM en complément). */
export function assembler({ referentiel, osm }, maintenant = Date.now()) {
  const marques = [], index = new Map();
  const idx = (src, i) => {
    if (i < 0) return -1;
    const m = src.marques[i];
    if (!index.has(m)) { index.set(m, marques.length); marques.push(m); }
    return index.get(m);
  };
  const refs = {}, points = [];
  if (osm) {
    for (const [id, p] of Object.entries(osm.refs || {})) refs[id] = [p[0], p[1], idx(osm, p[2]), ...(p[3] ? [p[3]] : [])];
    for (const p of osm.points || []) points.push([p[0], p[1], idx(osm, p[2]), ...(p[3] ? [p[3]] : [])]);
  }
  if (referentiel) for (const [id, p] of Object.entries(referentiel.refs)) {
    const autre = refs[id];
    refs[id] = [p[0] ?? autre?.[0] ?? null, p[1] ?? autre?.[1] ?? null, p[2] >= 0 ? idx(referentiel, p[2]) : (autre?.[2] ?? -1), ...(autre?.[3] ? [autre[3]] : [])];
  }
  const source = [referentiel && 'Référentiel des noms et enseignes de stations-service (Chiffrex, data.gouv.fr, ODbL)', osm && 'OpenStreetMap (ODbL), via Overpass API'].filter(Boolean).join(' + ');
  return { version: VERSION, source, genere: new Date(maintenant).toISOString(), marques, refs, points };
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
  const res = { marques: 0, positions: 0, horaires: 0 };
  if (!enseignes) return res;
  const dist = (p, s) => Math.hypot((p[1] - s.lng) * 111320 * Math.cos(s.lat * Math.PI / 180), (p[0] - s.lat) * 110570);
  const restantes = [];
  for (const s of stations) {
    const p = enseignes.refs?.[s.id];
    if (!p) { restantes.push(s); continue; }
    if (p[2] >= 0) { s.m = enseignes.marques[p[2]]; res.marques++; }
    if (p[3] && !s.o) { s.o = p[3]; res.horaires++; }
    if (p[0] != null && p[1] != null) {
      const d = dist(p, s);
      if (d > 40 && d < 8000) { s.lat = p[0]; s.lng = p[1]; res.positions++; }
    }
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
    if (d <= DISTANCE_MAX_M || plusProcheDuPoint.get(p)?.s === s) {
      if (p[2] >= 0 && !s.m) { s.m = enseignes.marques[p[2]]; res.marques++; }
      if (p[3] && !s.o) { s.o = p[3]; res.horaires++; }
    }
  }
  return res;
}

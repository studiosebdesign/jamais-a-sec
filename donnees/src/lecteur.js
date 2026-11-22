// Lecture du XML officiel, station par station (<pdv>…</pdv>), au fil de l'eau.
// Chaque bloc est transformé en un objet compact pour l'app.

import { parisVersMs, msVersMinutes } from './temps.js';

export const CARBURANTS = {
  // nom dans le flux -> clé courte ; l'identifiant numérique sert de secours
  Gazole: 'gazole', SP95: 'sp95', E85: 'e85', GPLc: 'gplc', E10: 'e10', SP98: 'sp98'
};
const PAR_ID = { 1: 'gazole', 2: 'sp95', 3: 'e85', 4: 'gplc', 5: 'e10', 6: 'sp98' };

const ENTITES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
function decoder(t) {
  return t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITES[e] ?? m;
  });
}
function attributs(s) {
  const o = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = decoder(m[2]);
  return o;
}
function texte(bloc, balise) {
  const m = new RegExp('<' + balise + '\\b[^>]*>([\\s\\S]*?)</' + balise + '>').exec(bloc);
  return m ? decoder(m[1]).replace(/\s+/g, ' ').trim() : '';
}
function cleCarburant(a) {
  return CARBURANTS[a.nom] || PAR_ID[a.id] || null;
}
// Coordonnées : le flux les donne multipliées par 100 000 (format « PTV »), parfois déjà en degrés.
function coord(v, max) {
  const n = parseFloat(String(v).replace(',', '.'));
  if (!isFinite(n) || n === 0) return null;
  const d = Math.abs(n) > max ? n / 100000 : n;
  return Math.abs(d) <= max ? Math.round(d * 100000) / 100000 : null;
}
// Prix : en euros (1.799) ; les anciens flux étaient en millièmes (1799).
function prix(v) {
  const n = parseFloat(String(v).replace(',', '.'));
  if (!isFinite(n) || n <= 0) return null;
  const e = n > 100 ? n / 1000 : n;
  return e > 0.2 && e < 5 ? Math.round(e * 1000) / 1000 : null; // garde-fou contre les valeurs absurdes
}

/**
 * Transforme un bloc <pdv>…</pdv> en station, ou null si la station est à écarter.
 * options.maintenant (ms), options.prixMaxJours (prix plus vieux = écartés)
 */
export function lireStation(bloc, options) {
  const { maintenant, prixMaxJours } = options;
  const ouverture = /^<pdv\b([^>]*)>/.exec(bloc);
  if (!ouverture) return { ecartee: 'format' };
  const a = attributs(ouverture[1]);
  const lat = coord(a.latitude, 90), lng = coord(a.longitude, 180);
  if (lat === null || lng === null) return { ecartee: 'coordonnees' };

  // Fermeture : définitive -> on écarte ; temporaire en cours -> on signale
  let fermee = 0;
  for (const m of bloc.matchAll(/<fermeture\b([^>]*?)\/?>/g)) {
    const f = attributs(m[1]);
    if (!f.type && !f.debut) continue;
    const debut = parisVersMs(f.debut), fin = parisVersMs(f.fin);
    const enCours = (!debut || debut <= maintenant) && (!fin || fin > maintenant);
    if (!enCours) continue;
    if (/^d/i.test(f.type || '')) return { ecartee: 'fermee' };
    fermee = 1;
  }

  // Ruptures : on ne garde que les temporaires en cours ; une rupture définitive = carburant plus vendu
  const ruptures = {}, plusVendu = new Set();
  for (const m of bloc.matchAll(/<rupture\b([^>]*?)\/?>/g)) {
    const r = attributs(m[1]);
    const cle = cleCarburant(r);
    if (!cle) continue;
    if (/^d/i.test(r.type || '')) { plusVendu.add(cle); continue; }
    const debut = parisVersMs(r.debut), fin = parisVersMs(r.fin);
    if (fin && fin <= maintenant) continue; // rupture terminée
    ruptures[cle] = debut ? msVersMinutes(debut) : 0;
  }

  // Prix : on écarte les prix trop anciens
  const limite = maintenant - prixMaxJours * 86400000;
  const p = {};
  let nbPrimes = 0;
  for (const m of bloc.matchAll(/<prix\b([^>]*?)\/?>/g)) {
    const x = attributs(m[1]);
    const cle = cleCarburant(x);
    if (!cle || plusVendu.has(cle)) continue;
    const v = prix(x.valeur);
    const maj = parisVersMs(x.maj);
    if (v === null || !maj) continue;
    if (maj < limite) { nbPrimes++; continue; }
    p[cle] = [v, msVersMinutes(maj)];
  }
  for (const cle of plusVendu) delete ruptures[cle];

  if (!Object.keys(p).length && !Object.keys(ruptures).length) return { ecartee: nbPrimes ? 'prix-perimes' : 'sans-prix' };

  const station = {
    id: a.id,
    lat, lng,
    cp: (a.cp || '').trim(),
    ville: texte(bloc, 'ville'),
    adr: texte(bloc, 'adresse'),
    aut: a.pop === 'A' ? 1 : 0, // 1 = station d'autoroute
    p
  };
  if (Object.keys(ruptures).length) station.r = ruptures;
  if (fermee) station.ferm = 1;
  if (/<horaires\b[^>]*automate-24-24="1"/.test(bloc)) station.h24 = 1;
  return { station };
}

/**
 * Découpe un flux de texte en blocs <pdv>…</pdv>, sans jamais garder tout le fichier en mémoire.
 * Renvoie une fonction à appeler avec chaque morceau de texte, puis avec null à la fin.
 */
export function decoupeur(surBloc) {
  let reste = '';
  return function (morceau) {
    if (morceau === null) { reste = ''; return; }
    reste += morceau;
    let pos = 0;
    for (;;) {
      let debut = reste.indexOf('<pdv', pos);
      while (debut >= 0 && !/[\s>]/.test(reste[debut + 4] || '')) debut = reste.indexOf('<pdv', debut + 4);
      if (debut < 0) { pos = Math.max(pos, reste.length - 5); break; }
      const fin = reste.indexOf('</pdv>', debut);
      if (fin < 0) { pos = debut; break; }
      surBloc(reste.slice(debut, fin + 6));
      pos = fin + 6;
    }
    reste = reste.slice(pos);
  };
}

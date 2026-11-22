#!/usr/bin/env node
// Jamais à sec — récupération des prix des carburants
//
// Télécharge le flux officiel (ZIP), le lit station par station, puis écrit :
//   <sortie>/data/index.json        résumé + emprise de chaque département
//   <sortie>/data/dep/<num>.json    les stations d'un département
//
// Utilisation :
//   node src/index.js                      télécharge le flux officiel, écrit dans ../site
//   node src/index.js --fichier flux.zip   lit un fichier local (ZIP ou XML)
//   node src/index.js --sortie dossier     choisit le dossier de sortie
//   node src/index.js --historique URL     relit l'historique publié (tendances.json) pour le compléter
//   node src/index.js --enseignes URL      relit les enseignes publiées (rafraîchies depuis OpenStreetMap chaque semaine)

import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ouvrirXmlDansZip } from './zip.js';
import { lireStation, decoupeur } from './lecteur.js';
import { departement } from './departements.js';
import { medianesDuJour, lireHistorique, fusionner, jourParis } from './historique.js';
import { lireEnseignes, telechargerOSM, telechargerReferentiel, assembler, associer, VALIDITE_JOURS, VERSION as VERSION_ENSEIGNES } from './enseignes.js';

const ICI = path.dirname(fileURLToPath(import.meta.url));

export const SOURCES = [
  'https://donnees.roulez-eco.fr/opendata/instantane_ruptures',
  'https://donnees.roulez-eco.fr/opendata/instantane'
];
const MENTION = 'Ministère de l\'Économie et des Finances — données « Prix des carburants en France », Licence Ouverte 2.0 (data.gouv.fr)';

function lireArguments(argv) {
  const o = { sortie: path.resolve(ICI, '../../site'), fichier: null, minStations: 5000, prixMaxJours: 30, historique: null, enseignes: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--sortie') { o.sortie = path.resolve(v); i++; }
    else if (a === '--fichier') { o.fichier = path.resolve(v); i++; }
    else if (a === '--min-stations') { o.minStations = parseInt(v, 10); i++; }
    else if (a === '--prix-max-jours') { o.prixMaxJours = parseFloat(v); i++; }
    else if (a === '--historique') { o.historique = v; i++; }
    else if (a === '--enseignes') { o.enseignes = v; i++; }
  }
  return o;
}

async function telecharger() {
  let derniereErreur;
  for (const url of SOURCES) {
    for (let essai = 1; essai <= 3; essai++) {
      try {
        const rep = await fetch(url, { signal: AbortSignal.timeout(90000), headers: { 'User-Agent': 'JamaisASec/1.0 (open data)' } });
        if (!rep.ok) throw new Error('HTTP ' + rep.status);
        const buf = Buffer.from(await rep.arrayBuffer());
        if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('la réponse n\'est pas un ZIP');
        return { buf, url };
      } catch (e) {
        derniereErreur = e;
        console.warn(`  Essai ${essai}/3 échoué pour ${url} : ${e.message}`);
        await new Promise(r => setTimeout(r, 3000 * essai));
      }
    }
  }
  throw new Error('Téléchargement impossible : ' + derniereErreur?.message);
}

/** Lit un flux XML d'octets (ISO-8859-1) et renvoie les stations retenues + statistiques. */
export async function traiterFlux(fluxOctets, options) {
  const stations = [];
  const ecartees = {};
  const decodeur = new TextDecoder('latin1');
  const couper = decoupeur(bloc => {
    const res = lireStation(bloc, options);
    if (res.station) stations.push(res.station);
    else ecartees[res.ecartee] = (ecartees[res.ecartee] || 0) + 1;
  });
  for await (const morceau of fluxOctets) couper(decodeur.decode(morceau, { stream: true }));
  couper(decodeur.decode());
  couper(null);
  return { stations, ecartees };
}

/** Regroupe par département et écrit les fichiers (dans un dossier temporaire, puis bascule). */
export async function ecrire(stations, ecartees, dossierSortie, meta) {
  const parDep = new Map();
  for (const s of stations) {
    const d = departement(s.cp) || 'inconnu';
    if (!parDep.has(d)) parDep.set(d, []);
    parDep.get(d).push(s);
  }
  const final = path.join(dossierSortie, 'data');
  const temp = path.join(dossierSortie, 'data.tmp-' + process.pid);
  await fs.rm(temp, { recursive: true, force: true });
  await fs.mkdir(path.join(temp, 'dep'), { recursive: true });

  const index = {
    version: 1,
    genere: new Date(meta.maintenant).toISOString(),
    source: { url: meta.url, mention: MENTION, lien: 'https://www.data.gouv.fr/datasets/prix-des-carburants-en-france-flux-instantane-v2-amelioree' },
    format: {
      p: 'prix par carburant : [prix en €/L, mise à jour en minutes depuis 1970 UTC]',
      r: 'ruptures temporaires en cours : début en minutes depuis 1970 UTC (0 = inconnu)',
      m: 'enseigne (OpenStreetMap, ODbL), si connue', aut: '1 = station d\'autoroute', ferm: '1 = fermeture temporaire en cours', h24: '1 = automate 24h/24'
    },
    nbStations: stations.length,
    ecartees,
    departements: {}
  };
  for (const [d, liste] of [...parDep].sort()) {
    liste.sort((a, b) => a.lat - b.lat);
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    const ruptures = {}, vendeurs = {};
    for (const s of liste) {
      minLat = Math.min(minLat, s.lat); maxLat = Math.max(maxLat, s.lat);
      minLng = Math.min(minLng, s.lng); maxLng = Math.max(maxLng, s.lng);
      for (const c of new Set([...Object.keys(s.p), ...Object.keys(s.r || {})])) vendeurs[c] = (vendeurs[c] || 0) + 1;
      for (const c of Object.keys(s.r || {})) ruptures[c] = (ruptures[c] || 0) + 1;
    }
    index.departements[d] = { n: liste.length, emprise: [minLat, minLng, maxLat, maxLng], vendeurs, ruptures };
    await fs.writeFile(path.join(temp, 'dep', d + '.json'), JSON.stringify({ dep: d, genere: index.genere, stations: liste }));
  }
  await fs.writeFile(path.join(temp, 'index.json'), JSON.stringify(index, null, 1));
  if (meta.tendances) await fs.writeFile(path.join(temp, 'tendances.json'), JSON.stringify(meta.tendances));
  if (meta.enseignes) await fs.writeFile(path.join(temp, 'enseignes.json'), JSON.stringify(meta.enseignes));
  await fs.rm(final, { recursive: true, force: true });
  await fs.rename(temp, final);
  return index;
}

async function principal() {
  const opt = lireArguments(process.argv.slice(2));
  const maintenant = Date.now();
  console.log('Jamais à sec — mise à jour des prix des carburants');

  let flux, url;
  if (opt.fichier) {
    const buf = await fs.readFile(opt.fichier);
    url = 'fichier local : ' + path.basename(opt.fichier);
    flux = buf.readUInt32LE(0) === 0x04034b50 ? ouvrirXmlDansZip(buf).flux : Readable.from([buf]);
  } else {
    console.log('  Téléchargement du flux officiel…');
    const t = await telecharger();
    url = t.url;
    console.log(`  Reçu : ${(t.buf.length / 1e6).toFixed(1)} Mo depuis ${url}`);
    flux = ouvrirXmlDansZip(t.buf).flux;
  }

  const { stations, ecartees } = await traiterFlux(flux, { maintenant, prixMaxJours: opt.prixMaxJours });
  console.log(`  Stations retenues : ${stations.length}`);
  console.log(`  Stations écartées : ${JSON.stringify(ecartees)}`);

  // Garde-fou : si le flux est anormal (vide, tronqué), on ne publie rien et on garde les anciennes données.
  if (stations.length < opt.minStations) {
    console.error(`ERREUR : seulement ${stations.length} stations (minimum ${opt.minStations}). Rien n'est publié.`);
    process.exit(1);
  }
  // Enseignes et positions : on relit celles déjà publiées ; toutes les semaines, on les reconstruit
  // depuis le référentiel data.gouv (numéro officiel → nom + position) et OpenStreetMap en complément.
  let enseignes = await lireEnseignes(opt.enseignes || path.join(opt.sortie, 'data', 'enseignes.json'));
  const ageJours = enseignes ? (maintenant - new Date(enseignes.genere).getTime()) / 86400000 : Infinity;
  if ((ageJours > VALIDITE_JOURS || (enseignes?.version || 1) < VERSION_ENSEIGNES) && (!opt.fichier || opt.enseignes)) {
    let referentiel = null, osm = null;
    try {
      console.log('  Téléchargement du référentiel des noms (data.gouv.fr)…');
      referentiel = await telechargerReferentiel();
      console.log(`  Référentiel : ${Object.keys(referentiel.refs).length} stations`);
    } catch (e) { console.warn('  Référentiel indisponible (' + e.message + ')'); }
    try {
      console.log('  Téléchargement des stations OpenStreetMap…');
      osm = await telechargerOSM();
      console.log(`  OpenStreetMap : ${Object.keys(osm.refs).length} numéros officiels, ${osm.points.length} autres stations`);
    } catch (e) { console.warn('  OpenStreetMap indisponible (' + e.message + ')'); }
    if (referentiel || osm) enseignes = assembler({ referentiel, osm }, maintenant);
    else console.warn('  Aucune source disponible, on garde les enseignes précédentes.');
  }
  const assoc = associer(stations, enseignes);
  console.log(`  Enseignes : ${assoc.marques} stations sur ${stations.length} (${Math.round(assoc.marques / Math.max(1, stations.length) * 100)} %) · positions corrigées : ${assoc.positions} · horaires ajoutés (OSM) : ${assoc.horaires}`);

  // Historique : on relit celui déjà publié (s'il existe) et on y ajoute la médiane du jour
  const ancien = await lireHistorique(opt.historique || path.join(opt.sortie, 'data', 'tendances.json'));
  const tendances = fusionner(ancien, jourParis(maintenant), medianesDuJour(stations, maintenant));
  console.log(`  Historique : ${tendances.jours.length} jour(s)${ancien ? '' : ' (nouvel historique)'}`);
  const index = await ecrire(stations, ecartees, opt.sortie, { maintenant, url, tendances, enseignes });
  const tot = Object.values(index.departements).reduce((a, d) => a + (d.ruptures.gazole || 0), 0);
  console.log(`  Départements : ${Object.keys(index.departements).length} · stations en rupture de gazole : ${tot}`);
  console.log(`  Écrit dans ${path.join(opt.sortie, 'data')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal().catch(e => { console.error('ERREUR : ' + e.message); process.exit(1); });
}

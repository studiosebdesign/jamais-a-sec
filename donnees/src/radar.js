#!/usr/bin/env node
// L'équivalent de « /api/radar », en ligne de commande, pour vérifier les données générées.
//
//   node src/radar.js --lat 48.516 --lng 2.448 --carburant gazole --reservoir 50 --niveau 0.25 --conso 6 --rayon 15
//
// Options : --donnees <dossier data> (par défaut ../site/data), --habituelle <id station>, --json

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyser, departementsUtiles } from './calcul.js';

const ICI = path.dirname(fileURLToPath(import.meta.url));

export async function radar(o) {
  const index = JSON.parse(await fs.readFile(path.join(o.donnees, 'index.json'), 'utf8'));
  const deps = departementsUtiles(index, o.lat, o.lng, o.rayon);
  const stations = [];
  for (const d of deps) {
    const f = JSON.parse(await fs.readFile(path.join(o.donnees, 'dep', d + '.json'), 'utf8'));
    stations.push(...f.stations);
  }
  const volume = o.volume ?? Math.round(o.reservoir * (1 - o.niveau) * 2) / 2;
  const res = analyser({ stations, lat: o.lat, lng: o.lng, carburant: o.carburant, rayonKm: o.rayon, volume, conso: o.conso, habituelleId: o.habituelle, maintenant: o.maintenant });
  return { ...res, departementsCharges: deps, volume, donneesDu: index.genere };
}

const e2 = n => (n > 0 ? '+' : '') + n.toFixed(2).replace('.', ',') + ' €';
const p3 = n => n.toFixed(3).replace('.', ',');

async function principal() {
  const a = process.argv.slice(2);
  const val = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const o = {
    lat: parseFloat(val('lat', '48.516')), lng: parseFloat(val('lng', '2.448')),
    carburant: val('carburant', 'gazole'), reservoir: parseFloat(val('reservoir', '50')),
    niveau: parseFloat(val('niveau', '0.25')), conso: parseFloat(val('conso', '6')),
    rayon: parseFloat(val('rayon', '15')), habituelle: val('habituelle', null),
    volume: val('volume', null) === null ? undefined : parseFloat(val('volume')),
    donnees: path.resolve(val('donnees', path.join(ICI, '../../site/data')))
  };
  const r = await radar(o);
  if (a.includes('--json')) { console.log(JSON.stringify(r, null, 1)); return; }
  console.log(`Données du ${r.donneesDu} · départements chargés : ${r.departementsCharges.join(', ')}`);
  console.log(`${r.nbStations} stations vendent du ${r.carburant} dans ${o.rayon} km · ${r.nbRupture} en rupture (${Math.round(r.tauxRupture * 100)} %)${r.tension ? ' · MODE TENSION' : ''}`);
  console.log(`Prix médian du secteur : ${r.mediane === null ? '—' : p3(r.mediane) + ' €'} · référence (${r.reference?.type}) : ${r.reference ? p3(r.reference.prix) + ' €' : '—'} · volume ${r.volume} L`);
  console.log('');
  for (const x of r.classement.slice(0, 12)) {
    const s = x.station;
    console.log(`${e2(x.gain).padStart(9)}  ${p3(x.prix)} €  ${x.distanceKm.toFixed(1).padStart(5)} km  ${x.verdict.padEnd(10)} ${x.pepite ? 'PÉPITE ' : '       '}${s.adr}, ${s.ville}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal().catch(e => { console.error('ERREUR : ' + e.message); process.exit(1); });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fabriquerFlux, CHAMPCUEIL } from './fabrique.js';
import { ouvrirXmlDansZip } from '../src/zip.js';
import { traiterFlux, ecrire } from '../src/index.js';
import { decoupeur, lireHoraires } from '../src/lecteur.js';
import { parisVersMs } from '../src/temps.js';
import { departement } from '../src/departements.js';
import { analyser, distanceKm, REGLAGES, tendance } from '../src/calcul.js';
import { radar } from '../src/radar.js';
import { fusionner, medianesDuJour } from '../src/historique.js';
import { depuisOSM, associer, normaliserMarque, depuisReferentiel, assembler } from '../src/enseignes.js';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const flux = fabriquerFlux();
const opts = { maintenant: flux.maintenant, prixMaxJours: 30 };
const flux2 = await traiterFlux(Readable.from([flux.xml]), opts);

test('heure de Paris -> UTC (hiver et été)', () => {
  assert.equal(parisVersMs('2026-11-19 16:42:01'), Date.UTC(2026, 10, 19, 15, 42, 1));
  assert.equal(parisVersMs('2026-07-01T12:00:00'), Date.UTC(2026, 6, 1, 10, 0, 0));
  assert.equal(parisVersMs(''), null);
});

test('départements, y compris Corse et outre-mer', () => {
  assert.equal(departement('91750'), '91');
  assert.equal(departement('20000'), '2A');
  assert.equal(departement('20600'), '2B');
  assert.equal(departement('97400'), '974');
  assert.equal(departement('1000'), '01');
});

test('le découpage au fil de l\'eau ne dépend pas de la taille des morceaux', () => {
  const texte = flux.xml.toString('latin1');
  const compter = taille => {
    let n = 0; const c = decoupeur(() => n++);
    for (let i = 0; i < texte.length; i += taille) c(texte.slice(i, i + taille));
    c(null); return n;
  };
  const ref = compter(texte.length);
  assert.equal(ref, 13 + 5200);
  for (const t of [7, 333, 4096, 65536]) assert.equal(compter(t), ref);
});

test('lecture du ZIP et filtres', async () => {
  const { stations, ecartees } = await traiterFlux(ouvrirXmlDansZip(flux.zip).flux, opts);
  const s = id => stations.find(x => x.id === id);
  assert.equal(ecartees.fermee, 1, 'S7 fermée définitivement');
  assert.equal(ecartees['prix-perimes'], 1, 'S9 prix de 40 jours');
  assert.ok(!s('S7') && !s('S9'));
  assert.deepEqual(Object.keys(s('S1').p).sort(), ['e10', 'gazole']);
  assert.equal(s('S1').lat, 48.517); assert.equal(s('S1').lng, 2.449);   // coordonnées « PTV »
  assert.equal(s('S4').lat, 48.52);                                      // coordonnées déjà en degrés
  assert.ok(s('S4').r && 'gazole' in s('S4').r, 'S4 en rupture temporaire');
  assert.ok(!s('S5').p.e85 && !s('S5').r, 'S5 : E85 en rupture définitive = plus vendu');
  assert.ok(!s('S6').r, 'S6 : rupture terminée');
  assert.equal(s('S8').ferm, 1, 'S8 fermée temporairement');
  assert.ok(!s('S13').r && !s('S13').p.gplc, 'S13 : rupture « temporaire » de plus de 15 jours = GPLc plus vendu');
  assert.equal(s('S3').aut, 1, 'S3 sur autoroute');
  assert.equal(s('S2').h24, 1);
  assert.equal(s('S10').p.gazole[0], 1.749, 'prix en millièmes converti');
  assert.equal(s('S10').ville, 'SAINT-ÉTIENNE', 'accents ISO-8859-1');
  assert.equal(s('S10').adr, 'Rue Michelet & Cie', 'entités XML');
  assert.equal(s('S8').adr, 'Place de l\'Église');
});

test('écriture des fichiers par département + calcul autour de Champcueil', async () => {
  const dossier = await fs.mkdtemp(path.join(os.tmpdir(), 'jas-'));
  const { stations, ecartees } = await traiterFlux(Readable.from([flux.xml]), opts);
  const index = await ecrire(stations, ecartees, dossier, { maintenant: flux.maintenant, url: 'test' });
  assert.ok(index.departements['91'] && index.departements['2A'] && index.departements['2B']);
  const d91 = JSON.parse(await fs.readFile(path.join(dossier, 'data/dep/91.json'), 'utf8'));
  assert.equal(d91.stations.length, 8);

  const r = await radar({ donnees: path.join(dossier, 'data'), ...CHAMPCUEIL, carburant: 'gazole', reservoir: 50, niveau: 0.25, conso: 6, rayon: 15, maintenant: flux.maintenant });
  assert.ok(r.departementsCharges.includes('91'));
  assert.equal(r.volume, 37.5);
  assert.equal(r.reference.prix, 1.76, 'référence = la plus proche (S1)');
  assert.equal(r.nbRupture, 1);
  assert.equal(r.nbStations, 8); // S1 S2 S3 S4 S5 S6 S8 S13
  const s2 = r.classement.find(x => x.station.id === 'S2');
  const s1 = r.classement.find(x => x.station.id === 'S1');
  const detour = (s2.distanceKm - s1.distanceKm) * 2 * REGLAGES.facteurRoute;
  const attendu = Math.round(((1.76 - 1.659) * 37.5 - detour / 100 * 6 * 1.659) * 100) / 100;
  assert.equal(s2.gain, attendu);
  assert.equal(s2.verdict, 'rentable');
  assert.equal(s2.pepite, true);
  assert.equal(r.meilleure.station.id, 'S2');
  assert.equal(r.mediane, 1.745, 'médiane hors autoroute, hors rupture, hors fermée : 1.659 1.73 1.745 1.755 1.76');
  assert.equal(r.classement.find(x => x.station.id === 'S3').verdict, 'perte');

  // Station habituelle
  const h = await radar({ donnees: path.join(dossier, 'data'), ...CHAMPCUEIL, carburant: 'gazole', reservoir: 50, niveau: 0.25, conso: 6, rayon: 15, habituelle: 'S5', maintenant: flux.maintenant });
  assert.equal(h.reference.type, 'habituelle');
  assert.equal(h.reference.prix, 1.73);
  const hk = await radar({ donnees: path.join(dossier, 'data'), ...CHAMPCUEIL, carburant: 'gazole', reservoir: 50, niveau: 0.25, conso: 6, rayon: 15, habituelle: 'S4', maintenant: flux.maintenant });
  assert.equal(hk.habituelleIndisponible, true, 'S4 en rupture -> retour à la plus proche');
  assert.equal(hk.reference.type, 'plus-proche');
  await fs.rm(dossier, { recursive: true, force: true });
});

test('mode tension au-delà de 20 % de ruptures', () => {
  const base = { lat: 48.5, lng: 2.4, cp: '91000', aut: 0 };
  const now = Date.now(), m = Math.round(now / 60000);
  const st = [];
  for (let i = 0; i < 10; i++) st.push({ ...base, id: 'X' + i, lat: 48.5 + i * 0.001, p: { gazole: [1.7, m] }, ...(i < 3 ? { r: { gazole: m - 60 } } : {}) });
  const r = analyser({ stations: st, lat: 48.5, lng: 2.4, carburant: 'gazole', rayonKm: 15, volume: 40, conso: 6, maintenant: now });
  assert.equal(r.tauxRupture, 0.3);
  assert.equal(r.tension, true);
  assert.equal(r.nbDisponibles, 7);
});

test('distance', () => {
  assert.ok(Math.abs(distanceKm(48.8566, 2.3522, 45.764, 4.8357) - 392) < 3); // Paris-Lyon ≈ 392 km
});

test('le script complet en ligne de commande', async () => {
  const dossier = await fs.mkdtemp(path.join(os.tmpdir(), 'jas-cli-'));
  const zip = path.join(dossier, 'flux.zip');
  await fs.writeFile(zip, flux.zip);
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(ICI, '../src/index.js'), '--fichier', zip, '--sortie', path.join(dossier, 'site')]);
  assert.match(stdout, /Stations retenues : 5211/);
  assert.match(stdout, /Historique : 1 jour/);
  await fs.access(path.join(dossier, 'site/data/tendances.json'));
  const idx = JSON.parse(await fs.readFile(path.join(dossier, 'site/data/index.json'), 'utf8'));
  assert.equal(idx.nbStations, 5211);
  // Garde-fou : un flux trop petit ne publie rien
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(ICI, '../src/index.js'), '--fichier', zip, '--sortie', path.join(dossier, 'site2'), '--min-stations', '999999']));
  await assert.rejects(fs.access(path.join(dossier, 'site2/data/index.json')));
  await fs.rm(dossier, { recursive: true, force: true });
});

test('Sur ma route : le détour se mesure par rapport au trajet', () => {
  const m = Math.round(Date.now() / 60000);
  const st = [
    { id: 'PROCHE', lat: 48.517, lng: 2.449, cp: '91750', aut: 0, p: { gazole: [1.76, m] } },          // à côté du départ
    { id: 'SUR_ROUTE', lat: 48.569, lng: 2.440, cp: '91540', aut: 0, p: { gazole: [1.659, m] } },     // Mennecy, sur la route de Corbeil
    { id: 'A_L_OPPOSE', lat: 48.40, lng: 2.47, cp: '91490', aut: 0, p: { gazole: [1.60, m] } }        // Milly, dans l'autre sens
  ];
  const corbeil = { lat: 48.61, lng: 2.48 };
  const r = analyser({ stations: st, lat: 48.516, lng: 2.448, carburant: 'gazole', volume: 37.5, conso: 6, destination: corbeil, maintenant: Date.now() });
  assert.equal(r.mode, 'trajet');
  assert.ok(!r.classement.find(x => x.station.id === 'A_L_OPPOSE'), 'Milly est hors du couloir');
  const s = r.classement.find(x => x.station.id === 'SUR_ROUTE');
  assert.ok(s.ajoutTrajetKm < 1, 'Mennecy ajoute moins d\'1 km au trajet');
  // Sur la route, le gain est presque l'écart de prix entier
  assert.ok(s.gain > 3.4, 'gain ' + s.gain);
  const autour = analyser({ stations: st, lat: 48.516, lng: 2.448, carburant: 'gazole', volume: 37.5, conso: 6, rayonKm: 15, maintenant: Date.now() });
  assert.ok(autour.classement.find(x => x.station.id === 'SUR_ROUTE').gain < s.gain, 'moins rentable en aller-retour');
  assert.equal(r.reference.id, 'PROCHE', 'même référence dans les deux modes');
  assert.equal(autour.reference.id, 'PROCHE');
  // Station habituelle loin du trajet : elle reste la référence
  const h = analyser({ stations: st, lat: 48.516, lng: 2.448, carburant: 'gazole', volume: 37.5, conso: 6, rayonKm: 15, destination: corbeil, habituelleId: 'A_L_OPPOSE', maintenant: Date.now() });
  assert.equal(h.reference.type, 'habituelle');
  assert.equal(h.reference.prix, 1.60);
});

test('tendance des prix', () => {
  assert.equal(tendance([1.79, 1.785, 1.78, 1.776, 1.77]).sens, 'baisse');
  assert.equal(tendance([1.70, 1.71, 1.73, 1.75]).sens, 'hausse');
  assert.equal(tendance([1.75, 1.752, 1.751]).sens, 'stable');
  assert.equal(tendance([1.75]).sens, 'inconnu');
});

test('historique : ajout du jour, remplacement dans la journée, 30 jours max', () => {
  let h = null;
  for (let i = 1; i <= 35; i++) h = fusionner(h, '2026-10-' + String(i).padStart(2, '0'), { '91': { gazole: Math.round((1.7 + i / 1000) * 1000) / 1000 } });
  assert.equal(h.jours.length, 30);
  assert.equal(h.jours[0], '2026-10-06');
  assert.equal(h.deps['91'].gazole.at(-1), 1.735);
  h = fusionner(h, '2026-10-35', { '91': { gazole: 1.8 }, '42': { e10: 1.9 } });
  assert.equal(h.jours.length, 30, 'même jour = remplacé, pas ajouté');
  assert.equal(h.deps['91'].gazole.at(-1), 1.8);
  assert.equal(h.deps['42'].e10.filter(v => v !== null).length, 1);
  const med = medianesDuJour(flux2.stations, flux.maintenant);
  assert.equal(med['91'].gazole, 1.745, 'même médiane que le calcul');
});

test('l\'app utilise exactement le même module de calcul que le script', async () => {
  const a = await fs.readFile(path.join(ICI, '../src/calcul.js'), 'utf8');
  const b = await fs.readFile(path.join(ICI, '../../app/js/calcul.js'), 'utf8');
  assert.equal(b, a, 'copier donnees/src/calcul.js vers app/js/calcul.js');
});

test('enseignes OpenStreetMap : noms harmonisés et association à moins de 150 m', () => {
  assert.equal(normaliserMarque({ brand: 'Total Access' }), 'TotalEnergies');
  assert.equal(normaliserMarque({ name: 'Intermarche Super' }), 'Intermarché');
  assert.equal(normaliserMarque({ name: 'Station-service' }), null);
  assert.equal(normaliserMarque({ brand: 'E.Leclerc', name: 'Leclerc Mennecy' }), 'E.Leclerc');
  const osm = depuisOSM({ elements: [
    { type: 'node', lat: 48.5170, lon: 2.4492, tags: { amenity: 'fuel', brand: 'TotalEnergies' } },
    { type: 'way', center: { lat: 48.5690, lon: 2.4400 }, tags: { amenity: 'fuel', name: 'Intermarché' } },
    { type: 'node', lat: 48.6000, lon: 2.5000, tags: { amenity: 'fuel', name: 'Station' } }
  ] });
  assert.equal(osm.points.length, 2);
  const st = [{ id: 'A', lat: 48.517, lng: 2.449 }, { id: 'B', lat: 48.5695, lng: 2.4402 }, { id: 'C', lat: 48.53, lng: 2.46 }];
  assert.equal(associer(st, osm).marques, 2);
  assert.equal(st[0].m, 'TotalEnergies');
  assert.equal(st[1].m, 'Intermarché', 'à ~60 m');
  assert.equal(st[2].m, undefined, 'trop loin : pas d\'enseigne');
  // Noms libres et association à distance moyenne si mutuelle
  assert.equal(normaliserMarque({ name: 'Relais Total Itteville' }), 'TotalEnergies');
  assert.equal(normaliserMarque({ name: 'Garage du Centre' }), 'Garage du Centre');
  assert.equal(normaliserMarque({ operator: 'Carrefour Market' }), 'Carrefour');
  const osm2 = depuisOSM({ elements: [
    { type: 'node', lat: 48.5000, lon: 2.3000, tags: { name: 'Garage du Centre' } },
    { type: 'node', lat: 48.4000, lon: 2.3000, tags: { brand: 'Avia' } }
  ] });
  const st2 = [{ id: 'D', lat: 48.5025, lng: 2.3000 }, { id: 'E', lat: 48.4025, lng: 2.3000 }, { id: 'F', lat: 48.4010, lng: 2.3000 }];
  associer(st2, osm2);
  assert.equal(st2[0].m, 'Garage du Centre', '~280 m, seule candidate');
  assert.equal(st2[1].m, undefined, '~280 m mais une autre station officielle est plus proche de ce point');
  assert.equal(st2[2].m, 'Avia', '~110 m');
  // Par identifiant officiel : enseigne + position corrigée, même à 3 km
  const osm3 = depuisOSM({ elements: [
    { type: 'node', lat: 48.4700, lon: 2.3900, tags: { brand: 'TotalEnergies', name: 'Relais Moulin du Gué', 'ref:FR:prix-carburants': '91590003' } },
    { type: 'node', lat: 48.4710, lon: 2.3910, tags: { brand: 'BP' } }
  ] });
  const st3 = [{ id: '91590003', lat: 48.4950, lng: 2.4100 }];
  const r3 = associer(st3, osm3);
  assert.equal(st3[0].m, 'TotalEnergies');
  assert.deepEqual([st3[0].lat, st3[0].lng], [48.47, 2.39]);
  assert.equal(r3.positions, 1);
});

test('référentiel data.gouv : nom et position par numéro officiel', () => {
  const csv = 'id_station_officiel,nom_normalise,adresse,ville,code_postal,latitude_osm,longitude_osm,source_enrichissement\n' +
    '91590009,"Total Access","RN191 - ROUTE DE CORBEIL",Baulne,91590,48.49030720,2.35584690,"OSM"\n' +
    '91760001,Intermarché,"Route de la Ferté-Alais",Itteville,91760,48.49982630,2.35137500,"OSM"\n';
  const ref = depuisReferentiel(csv);
  const osm = depuisOSM({ elements: [{ type: 'node', lat: 48.6, lon: 2.4, tags: { brand: 'Avia' } }] });
  const ens = assembler({ referentiel: ref, osm });
  assert.equal(ens.version, 4);
  const st = [{ id: '91590009', lat: 48.507, lng: 2.37442 }, { id: '91760001', lat: 48.50264, lng: 2.34774 }, { id: 'X', lat: 48.6001, lng: 2.4 }];
  const r = associer(st, ens);
  assert.equal(st[0].m, 'TotalEnergies');
  assert.deepEqual([st[0].lat, st[0].lng], [48.49031, 2.35585], 'Baulne replacée à sa vraie position');
  assert.equal(st[1].m, 'Intermarché');
  assert.equal(st[2].m, 'Avia', 'complément OSM par proximité');
  assert.equal(r.marques, 3);
  assert.equal(r.positions, 2);
});

test('horaires d\'ouverture', () => {
  const b = `<pdv><horaires automate-24-24=""><jour id="1" nom="Lundi" ferme=""><horaire ouverture="07.00" fermeture="12.30"/><horaire ouverture="14.00" fermeture="19.30"/></jour>
    <jour id="2" nom="Mardi" ferme=""><horaire ouverture="06.30" fermeture="21.00"/></jour><jour id="7" nom="Dimanche" ferme="1"/></horaires></pdv>`;
  assert.deepEqual(lireHoraires(b), [[420, 750, 840, 1170], [390, 1260], null, null, null, null, 0]);
  assert.equal(lireHoraires('<horaires automate-24-24="1"><jour id="1" nom="Lundi" ferme=""/></horaires>'), undefined);
});

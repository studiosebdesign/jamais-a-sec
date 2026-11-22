// Jamais à sec — application (version 1)
// Les prix viennent des fichiers publiés toutes les 15 min sur GitHub Pages ; tout le calcul se fait dans le téléphone.

import { analyser, departementsUtiles, distanceKm, tendance } from './calcul.js';

// =================== RÉGLAGES ===================
const PARAMS = new URLSearchParams(location.search);
const DONNEES = (PARAMS.get('donnees') || 'https://studiosebdesign.github.io/jamais-a-sec/data').replace(/\/$/, '');
const GEOCODAGE = 'https://data.geopf.fr/geocodage/search';
const PRIX_RECENT_H = 48; // au-delà, un prix n'est jamais présenté comme un bon plan

const CARBUS = [
  { id: 'gazole', n: 'Gazole' }, { id: 'e10', n: 'SP95-E10' }, { id: 'sp95', n: 'SP95' },
  { id: 'sp98', n: 'SP98' }, { id: 'e85', n: 'E85' }, { id: 'gplc', n: 'GPLc' }
];
const NIVEAUX = [{ n: 'Vide', v: 0.05 }, { n: '1/4', v: 0.25 }, { n: '1/2', v: 0.5 }, { n: '3/4', v: 0.75 }];
const RAYONS = [5, 10, 15, 20];
const SILHOUETTES = [
  { n: 'Citadine', ex: 'Clio, 208, Yaris', l: 40, d: 'M16 26 V19 Q16 15 20 14 L27 6 H45 Q49 6 51 10 L54 17 V26 Z', w: 'M29 13 L32 9 H44 L46 13 Z', r: [24, 47] },
  { n: 'Compacte', ex: 'Golf, 308, Mégane', l: 50, d: 'M5 26 V19 Q5 15 10 14 L20 7 H42 Q46 7 50 11 L58 14 Q66 15 66 20 V26 Z', w: 'M22 13 L26 9 H41 L46 13 Z', r: [16, 55] },
  { n: 'SUV · Berline', ex: '3008, Qashqai', l: 55, d: 'M6 26 V15 Q6 11 11 10 L18 3 H48 Q52 3 55 7 L60 10 Q66 11 66 16 V26 Z', w: 'M20 9 L23 6 H47 L52 9 Z', r: [18, 54] },
  { n: 'Grand SUV · Monospace', ex: 'Espace, Kodiaq', l: 65, d: 'M4 26 V11 Q4 5 10 4 L15 2 H60 Q67 2 68 9 V26 Z', w: 'M17 8 L19 5 H60 Q64 5 64 8 Z', r: [16, 57] }
];

// =================== PRÉFÉRENCES (gardées dans le téléphone) ===================
const DEFAUT = { accueilFait: false, carbu: 'gazole', res: 50, niv: 0.25, conso: 6.0, rayon: 15, habId: null, trajet: null, mode: 'autour', position: null };
let P = { ...DEFAUT };
try { P = { ...DEFAUT, ...JSON.parse(localStorage.getItem('jas-prefs') || '{}') }; } catch (e) {}
function sauver() { try { localStorage.setItem('jas-prefs', JSON.stringify(P)); } catch (e) {} }

// État de la session
const S = { index: null, stations: [], depsCharges: new Map(), tendances: null, horsLigne: false, chargement: false, erreur: null, vol: null, passager: false, T: 1, installer: null };

// =================== OUTILS ===================
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const euros = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2).replace('.', ',') + ' €';
const p3 = n => n.toFixed(3).replace('.', ',');
const km = n => (Math.round(n * 10) / 10).toString().replace('.', ',') + ' km';
const litres = v => String(v).replace('.', ',') + ' L';
const nomCarbu = c => CARBUS.find(x => x.id === (c || P.carbu)).n;
const nomCarbuTexte = c => (c || P.carbu) === 'gazole' ? 'gazole' : nomCarbu(c);
const arrondi = v => Math.round(v * 2) / 2;
const volume = () => S.vol ?? arrondi(P.res * (1 - P.niv));
const maintenantMin = () => Math.round(Date.now() / 60000);
const PETITS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'à', 'au', 'aux', 'sur', 'en', 'sous']);
function titre(t) {
  const m = String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return m.replace(/(^|[\s\-'’(])([a-zàâäéèêëîïôöùûüç])/g, (x, a, b, i) => {
    const mot = m.slice(i + a.length).split(/[\s\-'’(]/)[0];
    return a + (i > 0 && PETITS.has(mot) && a === ' ' ? b : b.toUpperCase());
  }).replace(/\b(rn|rd|zac|za|zi|cc)\b/gi, x => x.toUpperCase());
}
const nomStation = s => (s.adr ? titre(s.adr) + ', ' : '') + titre(s.ville);
function depuis(min) {
  if (min < 60) return 'il y a ' + Math.max(1, Math.round(min)) + ' min';
  if (min < 1440) return 'il y a ' + Math.round(min / 60) + ' h';
  return 'il y a ' + Math.round(min / 1440) + ' j';
}
function etiquetteAge(min) {
  if (min <= 180) return `<span class="age a1">${depuis(min)}</span>`;
  if (min <= PRIX_RECENT_H * 60) return `<span class="age a2">${depuis(min)}</span>`;
  return `<span class="age a3">${Math.round(min / 1440)} j · à confirmer</span>`;
}
function ageCourt(min) { return min < 60 ? Math.round(min) + ' min' : min < 1440 ? Math.round(min / 60) + ' h' : Math.round(min / 1440) + ' j'; }
function departementDe(cp) {
  const c = String(cp || '').padStart(5, '0');
  if (c.startsWith('97') || c.startsWith('98')) return c.slice(0, 3);
  if (c.startsWith('20')) return parseInt(c, 10) < 20200 ? '2A' : '2B';
  return c.slice(0, 2);
}
function toast(txt) { const t = document.getElementById('toast'); t.textContent = txt; t.classList.add('ouvert'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('ouvert'), 2800); }

const IC_GO = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>';
const IC_PARTAGE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>';
const IC_DANGER = '<svg width="58" height="52" viewBox="0 0 64 58" aria-hidden="true" style="flex:none"><path d="M32 4 L60 54 L4 54 Z" fill="#FFCC00" stroke="#FFCC00" stroke-width="6" stroke-linejoin="round"/><path d="M32 14 L52 50 L12 50 Z" fill="#FFCC00" stroke="#111" stroke-width="3" stroke-linejoin="round"/><rect x="29.5" y="24" width="5" height="14" rx="2" fill="#111"/><circle cx="32" cy="43.5" r="2.8" fill="#111"/></svg>';
const IC_VOYANT = '<svg class="voyant" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16"/><path d="M2.5 21h14"/><rect x="7" y="6" width="5" height="4" rx=".6" fill="currentColor" stroke="none"/><path d="M15 10h1.5a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 0 3 0V8.5L18.5 6"/></svg>';
const IC_INFO = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="11" x2="12" y2="17"/><circle cx="12" cy="7.5" r=".6" fill="currentColor"/></svg>';
const IC_HORS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="22" y2="22"/><path d="M8.5 16.5a5 5 0 0 1 7 0M5 12.6a10 10 0 0 1 5.2-2.6M19 12.6a10 10 0 0 0-2-1.5M2 8.8a15 15 0 0 1 4.2-2.7M22 8.8A15 15 0 0 0 10.7 5"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg>';

// =================== POSITION ===================
function positionGPS() {
  return new Promise((ok, ko) => {
    if (!('geolocation' in navigator)) return ko(new Error('indisponible'));
    navigator.geolocation.getCurrentPosition(
      async p => {
        const pos = { lat: p.coords.latitude, lng: p.coords.longitude, label: 'Ma position', source: 'gps', quand: Date.now() };
        try { // nom de la commune, pour l'affichage
          const r = await fetch(`https://data.geopf.fr/geocodage/reverse?lon=${pos.lng}&lat=${pos.lat}&limit=1&index=address`);
          const j = await r.json(); const c = j.features?.[0]?.properties?.city; if (c) pos.label = c;
        } catch (e) {}
        ok(pos);
      },
      e => ko(e), { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  });
}
async function rechercherLieu(q) {
  const u = `${GEOCODAGE}?q=${encodeURIComponent(q)}&limit=6&autocomplete=1`;
  const r = await fetch(u);
  if (!r.ok) throw new Error('géocodage ' + r.status);
  const j = await r.json();
  return (j.features || []).map(f => ({
    label: f.properties.label, ville: f.properties.city || f.properties.name, cp: f.properties.postcode,
    lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1]
  }));
}
// Surveille la vitesse pour l'écran « Vous roulez »
function surveillerConduite() {
  if (!('geolocation' in navigator) || surveillerConduite.id != null) return;
  surveillerConduite.id = navigator.geolocation.watchPosition(p => {
    if (!S.passager && p.coords.speed != null && p.coords.speed > 6) document.getElementById('conduite').classList.add('ouvert');
  }, () => {}, { enableHighAccuracy: false, maximumAge: 10000 });
}

// =================== DONNÉES ===================
async function lireJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  if (r.headers.get('x-jas-cache')) S.horsLigne = true;
  return r.json();
}
async function chargerDonnees() {
  if (!P.position) return;
  S.chargement = true; S.erreur = null; S.horsLigne = !navigator.onLine;
  rafraichir();
  try {
    S.index = await lireJSON(DONNEES + '/index.json');
    const pts = [P.position];
    if (P.trajet) pts.push(P.trajet, { lat: (P.position.lat + P.trajet.lat) / 2, lng: (P.position.lng + P.trajet.lng) / 2 });
    const rayon = Math.max(P.rayon, 10);
    const deps = new Set();
    for (const p of pts) departementsUtiles(S.index, p.lat, p.lng, rayon).forEach(d => deps.add(d));
    const genere = S.index.genere;
    await Promise.all([...deps].map(async d => {
      const deja = S.depsCharges.get(d);
      if (deja && deja.genere === genere) return;
      const f = await lireJSON(`${DONNEES}/dep/${d}.json`);
      S.depsCharges.set(d, f);
    }));
    S.stations = [...deps].flatMap(d => S.depsCharges.get(d)?.stations || []);
    S.tendances = await lireJSON(DONNEES + '/tendances.json').catch(() => null);
  } catch (e) {
    S.erreur = navigator.onLine ? 'Impossible de charger les prix pour le moment.' : 'Pas de réseau et aucun prix enregistré sur ce téléphone.';
    console.warn(e);
  }
  S.chargement = false;
  rafraichir();
}

// =================== CALCUL ===================
function calculer(carbu = P.carbu) {
  if (!P.position || !S.stations.length) return null;
  const dest = P.mode === 'trajet' && P.trajet ? { lat: P.trajet.lat, lng: P.trajet.lng } : null;
  return analyser({
    stations: S.stations, lat: P.position.lat, lng: P.position.lng, carburant: carbu, rayonKm: P.rayon,
    volume: volume(), conso: P.conso, habituelleId: P.habId, destination: dest, maintenant: Date.now()
  });
}
const recent = x => x.ageHeures <= PRIX_RECENT_H;
function libRef(R) {
  if (R.reference?.type === 'habituelle') return 'votre station habituelle';
  return R.mode === 'trajet' ? 'la station la plus proche de votre trajet' : 'la station la plus proche';
}
function departementUtilisateur() {
  let best = null, bd = 1e9;
  for (const s of S.stations) { const d = distanceKm(P.position.lat, P.position.lng, s.lat, s.lng); if (d < bd) { bd = d; best = s; } }
  return best ? departementDe(best.cp) : null;
}

// =================== NAVIGATION ===================
const ECRANS = ['verdict', 'radar', 'vehicule'];
let ecranActuel = '';
function aller(nom) {
  if (!ECRANS.includes(nom)) nom = 'verdict';
  ecranActuel = nom;
  ECRANS.forEach(e => document.getElementById('ecran-' + e).classList.toggle('actif', e === nom));
  document.querySelectorAll('#onglets button').forEach(b => { if (b.dataset.ecran === nom) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  rafraichir();
  if (nom === 'radar') radar.montrer(); else radar.cacher();
  document.getElementById('ecran-' + nom).scrollTop = 0;
}
function rafraichir() {
  if (ecranActuel === 'verdict') rendreVerdict();
  if (ecranActuel === 'vehicule') rendreVehicule();
  if (ecranActuel === 'radar') radar.maj();
}
document.querySelectorAll('#onglets button').forEach(b => b.addEventListener('click', () => { if (location.hash !== '#' + b.dataset.ecran) location.hash = b.dataset.ecran; else aller(b.dataset.ecran); }));
window.addEventListener('hashchange', () => { fermerFeuille(); aller(location.hash.slice(1)); });
document.addEventListener('click', e => { if (e.target.closest('[data-carbu]')) location.hash = 'vehicule'; });

// =================== FEUILLE ===================
const voile = document.getElementById('voile'), feuille = document.getElementById('feuille');
function ouvrirFeuille(t, html) {
  document.getElementById('feuille-titre').textContent = t;
  document.getElementById('feuille-corps').innerHTML = html;
  voile.classList.add('ouvert'); feuille.classList.add('ouvert'); feuille.scrollTop = 0;
  feuille.querySelector('.fermer').focus();
  return document.getElementById('feuille-corps');
}
function fermerFeuille() { voile.classList.remove('ouvert'); feuille.classList.remove('ouvert'); }
voile.addEventListener('click', fermerFeuille);
feuille.querySelector('.fermer').addEventListener('click', fermerFeuille);

// =================== VERDICT ===================
function htmlEntete(R) {
  const t = P.trajet;
  return `<div class="barre"><div class="logo">${IC_VOYANT}Jamais à sec</div><button class="puce" data-carbu style="white-space:nowrap">${nomCarbu()}</button></div>
    <div class="modes" role="group" aria-label="Où chercher">
      <button data-mode="autour" aria-pressed="${P.mode !== 'trajet' || !t}">Autour de moi</button>
      ${t ? `<button data-mode="trajet" aria-pressed="${P.mode === 'trajet'}">Sur ma route</button>` : '<button data-ajout-trajet aria-pressed="false">+ Mon trajet</button>'}
    </div>
    <button class="lien" data-position style="padding:0;font-size:14px;text-decoration:none;text-align:left">${P.position ? `Depuis : <b>${esc(P.position.label)}</b>${P.mode === 'trajet' && t ? ` → <b>${esc(t.nom)} · ${esc(t.ville || t.label)}</b>` : ''} · <u>changer</u>` : '<u>Choisir une position</u>'}</button>`;
}
function htmlTendance() {
  const dep = departementUtilisateur();
  const serie = S.tendances?.deps?.[dep]?.[P.carbu]?.filter(v => typeof v === 'number') || [];
  if (serie.length < 4) {
    return `<div class="tendance stable"><div style="min-width:0"><div class="t-titre">Tendance</div><div class="t-txt">La courbe des prix apparaîtra après quelques jours de relevés.</div><div class="t-src">${nomCarbu()} · prix médian du département ${esc(dep || '')}</div></div></div>`;
  }
  const t = tendance(serie, 3);
  const cents = Math.abs(Math.round(t.variation * 100));
  const txt = t.sens === 'baisse' ? `Les prix baissent depuis 3 jours (−${cents} ct). Si vous pouvez attendre un peu, rien ne presse.`
    : t.sens === 'hausse' ? `Les prix montent depuis 3 jours (+${cents} ct). Mieux vaut faire le plein maintenant.` : 'Les prix sont stables ces derniers jours.';
  const s7 = serie.slice(-7), min = Math.min(...s7), max = Math.max(...s7), w = 120, h = 40, pad = 4;
  const pts = s7.map((v, i) => [pad + i * (w - 2 * pad) / Math.max(1, s7.length - 1), max === min ? h / 2 : pad + (max - v) * (h - 2 * pad) / (max - min)]);
  const der = pts[pts.length - 1];
  const svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${der[0]}" cy="${der[1]}" r="4.5" fill="currentColor"/></svg>`;
  return `<div class="tendance ${t.sens}"><div style="min-width:0"><div class="t-titre">${t.sens === 'baisse' ? 'Ça baisse' : t.sens === 'hausse' ? 'Ça monte' : 'C\'est stable'}</div><div class="t-txt">${txt}</div><div class="t-src">${nomCarbu()} · prix médian du département ${esc(dep)} · ${s7.length} jours</div></div>${svg}</div>`;
}
function htmlConseilE10(cible) {
  if (!['sp95', 'sp98'].includes(P.carbu)) return '';
  const e10 = cible.station.p.e10;
  if (!e10 || (maintenantMin() - e10[1]) > PRIX_RECENT_H * 60) return '';
  const eco = (cible.prix - e10[0]) * volume();
  if (eco <= 0.5) return '';
  return `<div class="conseil"><div class="c-titre">Votre voiture accepte peut-être le SP95-E10</div>
    <div class="c-txt">Ici, il est à ${p3(e10[0])} € : environ <b>${euros(eco)}</b> d'économie sur ${litres(volume())}.</div>
    <div class="deux"><button class="btn-blanc" data-e10-info style="height:48px;font-size:17px">Vérifier</button><button class="btn-noir" data-e10 style="height:48px;font-size:17px">Passer à l'E10</button></div></div>`;
}
function htmlEtat(titre, texte, bouton) {
  return `<div class="chargement">${titre === '…' ? '<div class="rond"></div>' : `<div class="t-titre">${titre}</div>`}<div>${texte}</div>${bouton || ''}</div>`;
}
function rendreVerdict() {
  const el = document.getElementById('ecran-verdict');
  let h = S.horsLigne ? `<div class="horsligne">${IC_HORS}Hors connexion · prix enregistrés ${S.index ? 'le ' + new Date(S.index.genere).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</div>` : '';
  const R = calculer();
  if (!R) {
    h += `<div class="haut">${htmlEntete({})}</div>`;
    if (!P.position) h += htmlEtat('Où êtes-vous ?', 'Indiquez votre position pour trouver les stations autour de vous.', '<button class="btn-noir" data-position style="width:100%">Choisir ma position</button>');
    else if (S.chargement) h += htmlEtat('…', 'Chargement des prix…');
    else if (S.erreur) h += htmlEtat('Oups', esc(S.erreur), '<button class="btn-noir" data-recharger style="width:100%">Réessayer</button>');
    else h += htmlEtat('Aucune station', 'Aucune donnée pour cette zone.');
    el.innerHTML = h; brancherVerdict(el, null); return;
  }
  if (R.tension) {
    h += `<div class="alerte">${IC_DANGER}<div><h2>Tension sur le ${nomCarbuTexte()}</h2><p>${R.nbRupture} stations sur ${R.nbStations} sont à sec ${R.mode === 'trajet' ? 'sur votre trajet' : 'dans un rayon de ' + P.rayon + ' km'}.</p></div></div>
      <div class="rassure"><b>${R.nbDisponibles}</b><span>stations encore approvisionnées. Pas besoin de faire le plein en urgence.</span></div>`;
  }
  h += `<div class="haut" ${R.tension ? 'style="padding-top:6px"' : ''}>${htmlEntete(R)}`;
  const ref = R.classement.find(x => x.verdict === 'reference');
  if (!ref) {
    h += `<div class="panneau"><div class="surtitre">Aucune station</div><div class="sous">Aucune station n'a de ${nomCarbuTexte()} disponible ${R.mode === 'trajet' ? 'sur ce trajet' : 'dans ce rayon'}. ${R.mode === 'trajet' ? '' : 'Élargissez le rayon dans « Mon véhicule ».'}</div></div></div>`;
    el.innerHTML = h; brancherVerdict(el, R); return;
  }
  const best = R.classement.find(x => x.verdict !== 'reference' && x.gain > 0 && recent(x)) || null;
  const cible = best || ref;
  const trajet = R.mode === 'trajet';
  if (best) {
    h += `<div class="panneau"><div class="surtitre">${trajet ? (best.gain > 1.5 ? 'Sur votre route' : 'Petit gain sur votre route') : (best.gain > 1.5 ? 'Ça vaut le détour' : 'Petit gain possible')}</div>
      <div class="gros">${euros(best.gain)}</div><div class="sous">gagnés net sur ce plein, ${trajet ? 'détour compris' : 'trajet déduit'}</div></div>`;
  } else {
    h += `<div class="panneau"><div class="surtitre">${trajet ? 'Faites le plein en route' : 'Restez près de chez vous'}</div>
      <div class="gros" style="font-size:64px">${p3(ref.prix)} €</div>
      <div class="sous">Aucun détour n'est rentable pour ${litres(volume())} : ${libRef(R)} reste le meilleur choix.</div></div>`;
  }
  const age = maintenantMin() - cible.station.p[P.carbu][1];
  const dTxt = cible === ref ? (trajet ? (cible.ajoutTrajetKm < 0.3 ? 'sur la route' : '+' + km(cible.ajoutTrajetKm)) : km(cible.distanceKm)) : (trajet ? '+' + km(cible.detourKm) : km(cible.detourKm));
  const dLeg = cible === ref ? (trajet ? 'de trajet' : 'de distance') : (trajet ? 'sur le trajet' : 'de détour');
  h += `<div class="trio"><div><b>${p3(cible.prix)}</b><small>€ / litre</small></div><div><b>${dTxt}</b><small>${dLeg}</small></div>
      <div class="${age <= 180 ? 'maj-frais' : ''}"><b>${ageCourt(age)}</b><small>depuis la MAJ</small></div></div></div>
  <div class="corps">
    <div><div class="station-titre">${esc(nomStation(cible.station))}</div><div class="gris">${trajet ? 'Sur votre trajet' : km(cible.distanceKm)} · ${cible === ref ? libRef(R).replace('la station', 'station').replace('votre station', 'votre station') : 'contre ' + p3(ref.prix) + ' € à ' + libRef(R)}</div></div>
    <div class="actions"><button class="btn-noir" data-yaller="${esc(cible.station.id)}">${IC_GO}Y aller</button><button class="btn-blanc" data-partage="${esc(cible.station.id)}" aria-label="Alerter un proche">${IC_PARTAGE}</button></div>
    ${htmlConseilE10(cible)}
    <div class="simu"><div class="l"><label for="vol">Volume à remplir</label><output id="o-vol">${litres(volume())}</output></div>
      <input id="vol" type="range" min="5" max="${P.res}" step="0.5" value="${volume()}">
      <div class="gris" style="font-size:12px;display:flex;justify-content:space-between"><span>5 L</span><span>Réservoir ${P.res} L</span></div></div>
    ${htmlTendance()}
    ${R.habituelleIndisponible ? `<div class="neutre" style="border-width:3px;padding:10px 14px;font-size:14px"><b>Votre station habituelle n'est pas disponible</b> (en rupture, ${trajet ? 'loin du trajet' : 'hors rayon'} ou sans ce carburant) : calcul fait par rapport à ${libRef(R)}.</div>` : ''}
    <h2 class="section">${R.tension ? 'Approvisionnées · confirmées récemment' : trajet ? 'Les autres stations sur la route' : 'Les autres stations'}</h2>
    <div class="liste" id="liste"></div>
    <p class="gris" style="font-size:12px;margin:4px 0 0">Prix : data.gouv.fr (Ministère de l'Économie), relevés ${S.index ? 'à ' + new Date(S.index.genere).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}. App indépendante, non affiliée au gouvernement.</p>
  </div>`;
  el.innerHTML = h;
  const autres = R.tension
    ? R.classement.filter(recent).sort((a, b) => a.ageHeures - b.ageHeures).slice(0, 6)
    : (() => { const r = R.classement.filter(x => x !== cible); return [...r.filter(recent).slice(0, 5), ...r.filter(x => !recent(x)).slice(0, 1)]; })();
  const nowMin = maintenantMin();
  document.getElementById('liste').innerHTML = autres.map(x => {
    const ageX = nowMin - x.station.p[P.carbu][1];
    let cls = 'ligne-st', val;
    if (R.tension) { val = p3(x.prix) + ' €'; if (ageX <= 60) cls += ' frais'; }
    else {
      if (x.gain <= 0 && x.verdict !== 'reference') cls += ' perte';
      val = x.verdict === 'reference' || !recent(x) ? p3(x.prix) + ' €' : x.gain > 0 ? euros(x.gain) + ' net' : euros(x.gain);
    }
    if (!recent(x)) cls += ' vieille';
    const lieu = x.verdict === 'reference' ? (R.reference.type === 'habituelle' ? 'habituelle' : 'la plus proche') : (trajet ? '+' + km(x.detourKm) + ' de route' : 'détour ' + km(x.detourKm));
    return `<button class="${cls}" data-station="${esc(x.station.id)}"><div style="min-width:0"><div class="nom">${esc(nomStation(x.station))}</div><div class="meta">${R.tension ? km(x.distanceKm) : lieu} · ${etiquetteAge(ageX)}</div></div><div class="val">${val}</div></button>`;
  }).join('') || '<p class="gris">Aucune autre station.</p>';
  brancherVerdict(el, R);
}
function brancherVerdict(el, R) {
  el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { P.mode = b.dataset.mode; sauver(); chargerDonnees(); }));
  el.querySelectorAll('[data-ajout-trajet]').forEach(b => b.addEventListener('click', ouvrirTrajet));
  el.querySelectorAll('[data-position]').forEach(b => b.addEventListener('click', ouvrirPosition));
  el.querySelectorAll('[data-recharger]').forEach(b => b.addEventListener('click', chargerDonnees));
  el.querySelectorAll('[data-station]').forEach(b => b.addEventListener('click', () => ouvrirStation(b.dataset.station)));
  el.querySelectorAll('[data-yaller]').forEach(b => b.addEventListener('click', () => ouvrirYaller(b.dataset.yaller)));
  el.querySelectorAll('[data-partage]').forEach(b => b.addEventListener('click', () => ouvrirPartage(b.dataset.partage)));
  el.querySelectorAll('[data-e10-info]').forEach(b => b.addEventListener('click', ouvrirE10));
  el.querySelectorAll('[data-e10]').forEach(b => b.addEventListener('click', () => { P.carbu = 'e10'; sauver(); toast('Carburant passé au SP95-E10. Vous pouvez revenir en arrière dans « Mon véhicule ».'); rafraichir(); }));
  const c = document.getElementById('vol');
  if (c) c.addEventListener('input', () => {
    S.vol = parseFloat(c.value);
    document.getElementById('o-vol').textContent = litres(S.vol);
    clearTimeout(rendreVerdict.t);
    rendreVerdict.t = setTimeout(() => { const y = el.scrollTop; rendreVerdict(); el.scrollTop = y; document.getElementById('vol')?.focus({ preventScroll: true }); }, 80);
  });
}

// =================== FEUILLES : STATION, Y ALLER, PARTAGE, E10 ===================
const station = id => S.stations.find(s => s.id === id);
function ouvrirStation(id) {
  const s = station(id); if (!s) return;
  const R = calculer();
  const x = R?.classement.find(c => c.station === s);
  const now = maintenantMin();
  const d = P.position ? distanceKm(P.position.lat, P.position.lng, s.lat, s.lng) : null;
  let html = `<div class="gris">${esc(titre(s.ville))}${d !== null ? ' · ' + km(d) : ''}${s.aut ? ' · autoroute' : ''}${s.h24 ? ' · automate 24 h/24' : ''}${s.ferm ? ' · <b>fermée temporairement</b>' : ''}</div>`;
  if (x) {
    const nom = x.verdict === 'reference' ? (R.reference.type === 'habituelle' ? 'Station habituelle' : 'La plus proche') : !recent(x) ? 'Prix à confirmer' : x.gain > 1.5 ? 'Ça vaut le détour' : x.gain > 0 ? 'Petit gain' : 'Fausse bonne affaire';
    html += `<div class="carte-partage"><div><div class="cond" style="font-weight:700;font-size:20px;text-transform:uppercase">${nom}</div>
      <div class="cond" style="font-weight:800;font-size:56px;line-height:.95;${x.gain <= 0 && x.verdict !== 'reference' ? 'color:var(--r)' : ''}">${x.verdict === 'reference' || !recent(x) ? p3(x.prix) + ' €' : euros(x.gain)}</div>
      <div style="font-weight:600">${nomCarbu()} · ${p3(x.prix)} €/L${x.verdict !== 'reference' ? ' · détour ' + km(x.detourKm) : ''}</div></div></div>`;
  } else if (s.r && P.carbu in s.r) {
    html += `<div class="alerte" style="border-radius:14px">${IC_DANGER}<div><h2>En rupture</h2><p>${nomCarbu()} indisponible ${s.r[P.carbu] ? 'depuis ' + depuis(now - s.r[P.carbu]).replace('il y a ', '') : ''}.</p></div></div>`;
  }
  html += `<div class="prix-carbus">${CARBUS.map(c => {
    const p = s.p[c.id], rupt = s.r && c.id in s.r;
    if (!p && !rupt) return '';
    return `<div class="${c.id === P.carbu ? 'actuel' : ''}"><small>${c.n}</small>${rupt ? '<b>—</b><span class="rupt">En rupture</span>' : `<b>${p3(p[0])} €</b><small>${depuis(now - p[1])}</small>`}</div>`;
  }).join('')}</div>`;
  html += `<div class="actions"><button class="btn-noir" data-yaller="${esc(s.id)}">${IC_GO}Y aller</button><button class="btn-blanc" data-partage="${esc(s.id)}" aria-label="Alerter un proche"${!x ? ' disabled style="opacity:.4"' : ''}>${IC_PARTAGE}</button></div>
    <button class="btn-blanc" data-hab style="font-size:17px">${P.habId === s.id ? 'Ma station habituelle · retirer' : 'Définir comme station habituelle'}</button>`;
  const c = ouvrirFeuille(titre(s.adr) || titre(s.ville), html);
  c.querySelector('[data-yaller]').addEventListener('click', () => ouvrirYaller(s.id));
  const bp = c.querySelector('[data-partage]'); if (x) bp.addEventListener('click', () => ouvrirPartage(s.id));
  c.querySelector('[data-hab]').addEventListener('click', () => {
    P.habId = P.habId === s.id ? null : s.id; sauver(); fermerFeuille(); rafraichir();
    toast(P.habId ? 'C\'est noté : les gains sont calculés par rapport à cette station.' : 'Station habituelle retirée.');
  });
}
function ouvrirYaller(id) {
  const s = station(id); if (!s) return;
  const ll = `${s.lat},${s.lng}`;
  ouvrirFeuille('Y aller avec…', `<p class="gris" style="margin:0">${esc(nomStation(s))}</p>
    <a class="appli" href="https://waze.com/ul?ll=${ll}&navigate=yes" target="_blank" rel="noopener">Waze</a>
    <a class="appli" href="https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving" target="_blank" rel="noopener">Google Maps</a>
    <a class="appli" href="https://maps.apple.com/?daddr=${ll}&dirflg=d" target="_blank" rel="noopener">Plans (iPhone)</a>`);
}
function ouvrirPartage(id) {
  const s = station(id); if (!s) return;
  const R = calculer(); const x = R?.classement.find(c => c.station === s); if (!x) return;
  const g = x.verdict === 'reference' ? 0 : Math.max(0, x.gain);
  const msg = `Bon plan carburant à ${titre(s.ville)} : ${titre(s.adr)}, le ${nomCarbuTexte()} est à ${p3(x.prix)} €/L${g > 0 ? ` (soit ${g.toFixed(2).replace('.', ',')} € d'économie nette sur un plein)` : ''}. Repéré sur Jamais à sec : ${location.origin}`;
  const c = ouvrirFeuille('Alerter un proche', `<div class="carte-partage"><div>
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="cond logo" style="font-weight:800;font-size:18px;text-transform:uppercase">${IC_VOYANT}Jamais à sec</span><span class="cond" style="font-weight:700;font-size:15px;background:var(--n);color:var(--j);padding:3px 8px;border-radius:5px;text-transform:uppercase">Bon plan</span></div>
      <div class="cond" style="font-weight:800;font-size:60px;line-height:.95">${p3(x.prix)} €</div>
      <div style="font-size:15px;font-weight:600">le litre de ${nomCarbuTexte()} · ${esc(nomStation(s))}</div>
      ${g > 0 ? `<div class="cond" style="margin-top:6px;background:var(--n);color:#fff;border-radius:8px;padding:8px 12px;font-weight:700;font-size:20px;text-transform:uppercase">Environ <span style="color:var(--j)">${euros(g)}</span> net sur un plein</div>` : ''}
    </div></div>
    <div><div class="gris" style="font-weight:600;margin-bottom:8px">Message</div><div class="bulle">${esc(msg)}</div></div>
    <div class="deux"><button class="btn-blanc" data-copier>Copier</button><button class="btn-noir" data-envoyer>Partager</button></div>`);
  c.querySelector('[data-copier]').addEventListener('click', async () => { try { await navigator.clipboard.writeText(msg); toast('Message copié.'); } catch (e) { toast('Copie impossible : sélectionnez le texte.'); } });
  c.querySelector('[data-envoyer]').addEventListener('click', async () => {
    if (navigator.share) { try { await navigator.share({ title: 'Bon plan carburant', text: msg }); } catch (e) {} }
    else { try { await navigator.clipboard.writeText(msg); toast('Message copié : collez-le dans WhatsApp ou vos SMS.'); } catch (e) {} }
  });
}
function ouvrirE10() {
  ouvrirFeuille('Ma voiture accepte-t-elle l\'E10 ?', `
    <div class="neutre" style="border-width:3px;padding:12px 14px;font-size:15px;line-height:1.45"><b>1. Ouvrez la trappe à carburant.</b><br>Une étiquette avec « E10 » dans un cercle veut dire que c'est compatible.</div>
    <div class="neutre" style="border-width:3px;padding:12px 14px;font-size:15px;line-height:1.45"><b>2. Pas d'étiquette ?</b><br>Regardez le manuel du conducteur, ou demandez à votre garagiste ou à la marque de votre voiture.</div>
    <div class="neutre" style="border-width:3px;padding:12px 14px;font-size:15px;line-height:1.45"><b>3. Bon à savoir</b><br>La plupart des voitures essence récentes l'acceptent, certains modèles anciens non. En cas de doute, ne changez pas.</div>`);
}

// =================== POSITION ET TRAJET (feuilles avec recherche) ===================
function brancherRecherche(c, surChoix) {
  const champ = c.querySelector('.recherche'), res = c.querySelector('[data-resultats]');
  let attente;
  champ.addEventListener('input', () => {
    clearTimeout(attente);
    const q = champ.value.trim();
    if (q.length < 3) { res.innerHTML = ''; return; }
    attente = setTimeout(async () => {
      try {
        const l = await rechercherLieu(q);
        res.innerHTML = l.map((x, i) => `<button class="ligne-st" data-i="${i}"><div style="min-width:0"><div class="nom">${esc(x.label)}</div><div class="meta">${esc(x.cp || '')}</div></div><div class="val" style="font-size:16px">CHOISIR</div></button>`).join('') || '<p class="gris">Aucun résultat.</p>';
        res.querySelectorAll('button').forEach(b => b.addEventListener('click', () => surChoix(l[+b.dataset.i])));
      } catch (e) { res.innerHTML = '<p class="gris">Recherche impossible pour le moment.</p>'; }
    }, 300);
  });
}
async function utiliserGPS(apres) {
  try {
    toast('Recherche de votre position…');
    P.position = await positionGPS(); sauver(); surveillerConduite();
    toast('Position trouvée.');
    apres && apres(); chargerDonnees();
  } catch (e) {
    toast(e && e.code === 1 ? 'Localisation refusée : tapez votre ville ci-dessous.' : 'Position introuvable : tapez votre ville ci-dessous.');
  }
}
function ouvrirPosition() {
  const c = ouvrirFeuille('Votre position', `
    <button class="btn-noir" data-gps>Utiliser ma position GPS</button>
    <div class="champ"><label class="lab" for="q-pos">Ou tapez une ville, un code postal, une adresse</label><input id="q-pos" class="recherche" type="search" autocomplete="off" placeholder="Ex. Champcueil, 91750…"></div>
    <div class="liste" data-resultats></div>`);
  c.querySelector('[data-gps]').addEventListener('click', () => utiliserGPS(fermerFeuille));
  brancherRecherche(c, x => { P.position = { lat: x.lat, lng: x.lng, label: x.ville || x.label, source: 'manuel', quand: Date.now() }; sauver(); fermerFeuille(); chargerDonnees(); });
}
function ouvrirTrajet() {
  const noms = ['Travail', 'École', 'Courses'];
  const nom = P.trajet?.nom || 'Travail';
  const c = ouvrirFeuille('Mon trajet régulier', `
    <span class="gris" style="font-size:14px">Les stations sur ce trajet ne coûtent presque aucun détour : c'est là que sont les meilleurs gains.</span>
    <div class="champ"><span class="lab">C'est pour aller…</span><div class="choix" data-noms>${noms.map(n => `<button aria-pressed="${n === nom}" data-n="${n}">${n}</button>`).join('')}</div></div>
    <div class="champ"><label class="lab" for="q-tr">Destination</label><input id="q-tr" class="recherche" type="search" autocomplete="off" placeholder="Adresse ou ville (ex. Corbeil-Essonnes)"></div>
    ${P.trajet ? `<div class="gris">Actuellement : <b>${esc(P.trajet.label)}</b></div>` : ''}
    <div class="liste" data-resultats></div>
    ${P.trajet ? '<button class="btn-blanc" data-suppr style="font-size:18px">Supprimer ce trajet</button>' : ''}`);
  let choixNom = nom;
  c.querySelectorAll('[data-n]').forEach(b => b.addEventListener('click', () => {
    choixNom = b.dataset.n; c.querySelectorAll('[data-n]').forEach(x => x.setAttribute('aria-pressed', x === b));
    if (P.trajet) { P.trajet.nom = choixNom; sauver(); rafraichir(); }
  }));
  brancherRecherche(c, x => {
    P.trajet = { nom: choixNom, label: x.label, ville: x.ville, lat: x.lat, lng: x.lng }; P.mode = 'trajet'; sauver();
    fermerFeuille(); toast('Trajet enregistré : le Verdict montre les stations sur votre route.'); chargerDonnees();
  });
  c.querySelector('[data-suppr]')?.addEventListener('click', () => { P.trajet = null; P.mode = 'autour'; sauver(); fermerFeuille(); rafraichir(); });
}

// =================== MON VÉHICULE ===================
function choixHTML(id, items, actif, classe = '') { return `<div class="choix ${classe}" id="${id}">${items.map((it, i) => `<button aria-pressed="${it.v === actif}" data-i="${i}">${it.n}</button>`).join('')}</div>`; }
function brancherChoix(id, items, surClic) { document.querySelectorAll('#' + id + ' button').forEach(b => b.addEventListener('click', () => surClic(items[+b.dataset.i].v))); }
function htmlReservoir(p) {
  return `<div class="champ"><span class="lab">Votre type de voiture</span>
    <div class="sils" id="${p}-sil">${SILHOUETTES.map(x => `<button data-l="${x.l}" aria-pressed="${P.res === x.l}"><svg viewBox="0 0 72 34" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true"><path d="${x.d}"/><path d="${x.w}" stroke-width="1.8"/><circle cx="${x.r[0]}" cy="26" r="5"/><circle cx="${x.r[1]}" cy="26" r="5"/></svg><b>${x.n}</b><small>${x.ex}</small><small><b style="font-size:13px">≈ ${x.l} L</b></small></button>`).join('')}</div></div>
    <div class="champ"><div class="l"><label for="${p}-res">Capacité du réservoir</label><output id="${p}-ores">${P.res} L</output></div><input id="${p}-res" type="range" min="25" max="90" step="1" value="${P.res}">
    <span class="gris" style="font-size:13px">Vous connaissez la valeur exacte ? Ajustez le curseur.</span></div>`;
}
function htmlConso(p) {
  return `<div class="champ"><div class="l"><label for="${p}-conso">Votre consommation moyenne</label><output id="${p}-oconso">${P.conso.toFixed(1).replace('.', ',')} L/100</output></div><input id="${p}-conso" type="range" min="3" max="14" step="0.1" value="${P.conso}">
    <div class="aide">${IC_INFO}<div><b>Où la trouver ?</b>Sur l'ordinateur de bord de votre tableau de bord : faites défiler les écrans (bouton au bout de la manette des essuie-glaces ou sur le volant) jusqu'à « Conso moy. ».<br>Pas d'ordinateur de bord ? Au prochain plein, divisez les litres mis par les km parcourus depuis le plein d'avant, puis multipliez par 100.</div></div></div>`;
}
function brancherReservoir(p) {
  const res = document.getElementById(p + '-res'), btns = document.querySelectorAll('#' + p + '-sil button');
  const maj = () => { document.getElementById(p + '-ores').textContent = P.res + ' L'; btns.forEach(b => b.setAttribute('aria-pressed', +b.dataset.l === P.res)); S.vol = null; sauver(); };
  btns.forEach(b => b.addEventListener('click', () => { P.res = +b.dataset.l; res.value = P.res; maj(); }));
  res.addEventListener('input', () => { P.res = +res.value; maj(); });
  document.getElementById(p + '-conso').addEventListener('input', e => { P.conso = +e.target.value; document.getElementById(p + '-oconso').textContent = P.conso.toFixed(1).replace('.', ',') + ' L/100'; sauver(); });
}
function rendreVehicule() {
  const el = document.getElementById('ecran-vehicule');
  const y = el.scrollTop;
  const hab = P.habId ? station(P.habId) : null;
  const ligne = (id, nom, meta) => `<button class="ligne-st" id="${id}" style="border:3px solid var(--n)"><div style="min-width:0"><div class="nom">${nom}</div><div class="meta">${meta}</div></div><div class="val" style="font-size:17px;text-transform:uppercase">Changer</div></button>`;
  el.innerHTML = `<div class="page">
    <h1>Mon véhicule</h1>
    <div class="champ"><span class="lab">Carburant</span>${choixHTML('v-carbu', CARBUS.map(c => ({ n: c.n, v: c.id })), P.carbu)}</div>
    <div id="v-reservoir" style="display:flex;flex-direction:column;gap:18px">${htmlReservoir('v')}</div>
    <div class="champ"><span class="lab">Niveau actuel</span>${choixHTML('v-niv', NIVEAUX.map(n => ({ n: n.n, v: n.v })), P.niv, 'q')}</div>
    ${htmlConso('v')}
    <div class="champ"><span class="lab">Rayon de recherche</span>${choixHTML('v-rayon', RAYONS.map(r => ({ n: r + ' km', v: r })), P.rayon, 'q')}</div>
    <div class="champ"><span class="lab">Ma position</span>${ligne('v-pos', P.position ? esc(P.position.label) : 'Aucune', P.position ? (P.position.source === 'gps' ? 'Position GPS du téléphone' : 'Choisie à la main') : 'À choisir')}</div>
    <div class="champ"><span class="lab">Ma station habituelle</span>${ligne('v-hab', hab ? esc(nomStation(hab)) : 'La plus proche (auto)', hab ? 'Choisie par vous' : 'Change selon votre position')}
      <span class="gris" style="font-size:13px">C'est le prix auquel vous comparez : le gain affiché est ce que vous économisez par rapport à elle.</span></div>
    <div class="champ"><span class="lab">Mon trajet régulier</span>${ligne('v-trajet', P.trajet ? esc(P.trajet.nom + ' · ' + (P.trajet.ville || P.trajet.label)) : 'Aucun trajet', P.trajet ? esc(P.trajet.label) : 'Ajoutez votre trajet domicile → travail')}</div>
    ${S.installer ? '<button class="btn-noir" id="v-installer">Installer l\'app sur ce téléphone</button>' : ''}
    <button class="lien" id="revoir">Revoir l'écran d'accueil</button>
    <button class="btn-blanc" id="v-soutien" style="font-size:19px">Soutenir Jamais à sec</button>
    <p class="gris" style="margin:0;font-size:13px;line-height:1.45">Prix : Ministère de l'Économie et des Finances, « Prix des carburants en France », Licence Ouverte 2.0 (data.gouv.fr). Carte : © OpenStreetMap, OpenFreeMap. Application indépendante, non affiliée au gouvernement. Votre position reste dans votre téléphone. Sebdesign Studio.</p>
  </div>`;
  el.scrollTop = y;
  brancherChoix('v-carbu', CARBUS.map(c => ({ v: c.id })), v => { P.carbu = v; sauver(); rafraichir(); });
  brancherChoix('v-niv', NIVEAUX.map(n => ({ v: n.v })), v => { P.niv = v; S.vol = null; sauver(); rafraichir(); });
  brancherChoix('v-rayon', RAYONS.map(r => ({ v: r })), v => { P.rayon = v; sauver(); chargerDonnees(); });
  brancherReservoir('v');
  document.getElementById('v-pos').addEventListener('click', ouvrirPosition);
  document.getElementById('v-trajet').addEventListener('click', ouvrirTrajet);
  document.getElementById('v-hab').addEventListener('click', ouvrirHabituelle);
  document.getElementById('revoir').addEventListener('click', () => ouvrirAccueil(0));
  document.getElementById('v-soutien').addEventListener('click', () => toast('Bientôt : un petit don ou une courte vidéo pour soutenir le projet. Merci !'));
  document.getElementById('v-installer')?.addEventListener('click', async () => { S.installer.prompt(); await S.installer.userChoice; S.installer = null; rafraichir(); });
}
function ouvrirHabituelle() {
  if (!P.position || !S.stations.length) { toast('Choisissez d\'abord votre position.'); return; }
  const liste = S.stations.filter(s => s.p[P.carbu]).map(s => ({ s, d: distanceKm(P.position.lat, P.position.lng, s.lat, s.lng) }))
    .filter(x => x.d <= P.rayon).sort((a, b) => a.d - b.d).slice(0, 25);
  const c = ouvrirFeuille('Station habituelle', `<div class="liste">
    <button class="ligne-st${!P.habId ? ' frais' : ''}" data-id=""><div style="min-width:0"><div class="nom">La plus proche (auto)</div><div class="meta">Change selon votre position</div></div><div class="val" style="font-size:16px">${!P.habId ? 'CHOISIE' : ''}</div></button>
    ${liste.map(x => `<button class="ligne-st${P.habId === x.s.id ? ' frais' : ''}" data-id="${esc(x.s.id)}"><div style="min-width:0"><div class="nom">${esc(nomStation(x.s))}</div><div class="meta">${km(x.d)} · ${p3(x.s.p[P.carbu][0])} €</div></div><div class="val" style="font-size:16px">${P.habId === x.s.id ? 'CHOISIE' : ''}</div></button>`).join('')}</div>`);
  c.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => { P.habId = b.dataset.id || null; sauver(); fermerFeuille(); rafraichir(); toast(P.habId ? 'Station habituelle enregistrée.' : 'Référence : la station la plus proche.'); }));
}

// =================== ACCUEIL ===================
let etape = 0;
function ouvrirAccueil(n = 0) { etape = n; document.getElementById('accueil').classList.add('ouvert'); rendreAccueil(); }
function rendreAccueil() {
  const pg = document.getElementById('acc-page'), btn = document.getElementById('acc-suivant');
  document.querySelectorAll('#acc-points i').forEach((p, i) => p.classList.toggle('on', i === etape));
  btn.disabled = false; btn.style.opacity = 1;
  if (etape === 0) {
    pg.innerHTML = `<div style="width:96px;height:96px;border-radius:24px;background:var(--n);color:var(--j);display:flex;align-items:center;justify-content:center;margin-top:16px">${IC_VOYANT.replace('class="voyant"', 'width="60" height="60"')}</div>
      <p class="grosTitre">Jamais<br>à sec</p>
      <p style="font-size:17px;font-weight:500;margin:0;line-height:1.45">On calcule si une station moins chère vaut vraiment le trajet pour <b>votre</b> voiture, et on vous alerte quand le carburant vient à manquer autour de vous.</p>
      <p class="gris" style="margin:0">Quelques questions et c'est parti. Aucun compte à créer.</p>`;
    btn.textContent = 'Commencer';
  } else if (etape === 1) {
    pg.innerHTML = `<h1>Votre carburant</h1>${choixHTML('a-carbu', CARBUS.map(c => ({ n: c.n, v: c.id })), P.carbu)}`;
    document.getElementById('a-carbu').style.gridTemplateColumns = 'repeat(2,minmax(0,1fr))';
    brancherChoix('a-carbu', CARBUS.map(c => ({ v: c.id })), v => { P.carbu = v; sauver(); rendreAccueil(); });
    btn.textContent = 'Suivant';
  } else if (etape === 2) {
    pg.innerHTML = `<h1>Votre voiture</h1>${htmlReservoir('a')}
      <div class="champ"><span class="lab">Niveau actuel</span>${choixHTML('a-niv', NIVEAUX.map(n => ({ n: n.n, v: n.v })), P.niv, 'q')}</div>${htmlConso('a')}`;
    brancherChoix('a-niv', NIVEAUX.map(n => ({ v: n.v })), v => { P.niv = v; S.vol = null; sauver(); const y = pg.scrollTop; rendreAccueil(); pg.scrollTop = y; });
    brancherReservoir('a');
    btn.textContent = 'Suivant';
  } else if (etape === 3) {
    pg.innerHTML = `<div style="width:96px;height:96px;border-radius:48px;background:var(--n);color:var(--j);display:flex;align-items:center;justify-content:center;margin-top:16px"><svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg></div>
      <h1>Votre position</h1>
      <p style="margin:0;font-size:17px;font-weight:500;line-height:1.45">Pour trouver les stations autour de vous, Jamais à sec a besoin de votre position, <b>uniquement quand l'app est ouverte</b>.</p>
      <div class="aide"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><div><b>Elle reste dans votre téléphone.</b>Rien n'est envoyé ni enregistré sur un serveur. Pas de compte, pas de pistage.</div></div>
      ${P.position ? `<div class="neutre" style="border-width:3px;padding:10px 14px"><b>Position trouvée :</b> ${esc(P.position.label)}</div>` : ''}
      <button class="btn-blanc" id="a-gps" style="background:transparent">Autoriser la localisation</button>
      <div class="champ"><label class="lab" for="a-q">Ou tapez votre ville</label><input id="a-q" class="recherche" type="search" autocomplete="off" placeholder="Ex. Champcueil, 91750…"></div>
      <div class="liste" data-resultats></div>`;
    pg.querySelector('#a-gps').addEventListener('click', () => utiliserGPS(rendreAccueil));
    brancherRecherche(pg, x => { P.position = { lat: x.lat, lng: x.lng, label: x.ville || x.label, source: 'manuel', quand: Date.now() }; sauver(); chargerDonnees(); rendreAccueil(); });
    btn.textContent = 'Suivant';
    if (!P.position) { btn.disabled = true; btn.style.opacity = .4; }
  } else {
    const prets = S.stations.length > 0;
    const liste = prets ? S.stations.filter(s => s.p[P.carbu]).map(s => ({ s, d: distanceKm(P.position.lat, P.position.lng, s.lat, s.lng) })).sort((a, b) => a.d - b.d).slice(0, 6) : [];
    pg.innerHTML = `<h1>Votre station habituelle</h1>
      <p style="margin:0;font-size:16px;font-weight:500;line-height:1.4">Facultatif. Si vous avez vos habitudes, on calcule vos économies par rapport à elle.</p>
      ${!prets ? (S.erreur ? `<p>${esc(S.erreur)}</p>` : '<div class="chargement"><div class="rond"></div><div>Chargement des stations…</div></div>') : `<div class="liste" id="a-hab">
        <button class="ligne-st${!P.habId ? ' frais' : ''}" data-id="" style="background:#fff"><div style="min-width:0"><div class="nom">Pas d'habitude</div><div class="meta">On prendra la plus proche</div></div><div class="val" style="font-size:16px">${!P.habId ? 'CHOISIE' : ''}</div></button>
        ${liste.map(x => `<button class="ligne-st${P.habId === x.s.id ? ' frais' : ''}" data-id="${esc(x.s.id)}" style="background:#fff"><div style="min-width:0"><div class="nom">${esc(nomStation(x.s))}</div><div class="meta">${km(x.d)} · ${p3(x.s.p[P.carbu][0])} €</div></div><div class="val" style="font-size:16px">${P.habId === x.s.id ? 'CHOISIE' : ''}</div></button>`).join('')}</div>`}`;
    pg.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => { P.habId = b.dataset.id || null; sauver(); rendreAccueil(); }));
    btn.textContent = 'C\'est parti';
  }
}
document.getElementById('acc-suivant').addEventListener('click', () => {
  if (etape < 4) { etape++; rendreAccueil(); document.getElementById('acc-page').scrollTop = 0; return; }
  document.getElementById('accueil').classList.remove('ouvert');
  P.accueilFait = true; sauver();
  if (location.hash !== '#verdict') location.hash = 'verdict'; else aller('verdict');
});
// Rafraîchit l'étape « station habituelle » quand les données arrivent
const rafraichirOrigine = rafraichir;
rafraichir = function () { rafraichirOrigine(); if (document.getElementById('accueil').classList.contains('ouvert') && etape === 4) rendreAccueil(); };

// =================== CONDUITE, INSTALLATION, RÉSEAU ===================
document.getElementById('c-passager').addEventListener('click', () => { document.getElementById('conduite').classList.remove('ouvert'); S.passager = true; toast('Mode passager : bonne route !'); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installer = e; if (ecranActuel === 'vehicule') rendreVehicule(); });
window.addEventListener('online', () => { S.horsLigne = false; chargerDonnees(); });
window.addEventListener('offline', () => { S.horsLigne = true; rafraichir(); });
document.addEventListener('visibilitychange', () => {
  // au retour dans l'app, on recharge si les prix ont plus de 15 minutes
  if (document.visibilityState === 'visible' && S.index && Date.now() - new Date(S.index.genere).getTime() > 15 * 60000) chargerDonnees();
});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// =================== RADAR (chargé à la demande) ===================
const radar = {
  module: null, actif: false,
  async montrer() {
    this.actif = true;
    if (!this.module) {
      try {
        const m = await import('./carte.js');
        this.module = await m.creerRadar({ app: { P, S, calculer, ouvrirStation, toast, nomCarbu } });
      } catch (e) {
        console.warn(e);
        document.getElementById('rinfo').innerHTML = '<span>La carte ne peut pas s\'afficher sur ce téléphone.</span>';
        return;
      }
    }
    if (this.actif) this.module.montrer();
  },
  cacher() { this.actif = false; this.module?.cacher(); },
  maj() { this.module?.maj(); }
};

// =================== DÉMARRAGE ===================
// Dans la vraie app, on rafraîchit la position GPS à chaque ouverture si elle avait été autorisée
async function demarrer() {
  aller(location.hash.slice(1) || 'verdict');
  if (!P.accueilFait) ouvrirAccueil(0);
  if (P.position?.source === 'gps') {
    try { P.position = await positionGPS(); sauver(); surveillerConduite(); } catch (e) {}
  }
  chargerDonnees();
}
demarrer();

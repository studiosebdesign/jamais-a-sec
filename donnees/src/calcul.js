// Le cœur de Jamais à sec : prix de référence, gain net, pépites, taux de rupture.
// Ce module ne dépend de rien : il servira tel quel dans l'app (le calcul se fait dans le téléphone).

export const REGLAGES = {
  facteurRoute: 1.3,      // distance par la route ≈ vol d'oiseau × 1,3 (remplacé plus tard par un coefficient par station)
  prixFraisHeures: 72,    // un prix plus ancien ne peut pas être une pépite
  seuilPepite: 0.06,      // au moins 6 centimes sous la médiane locale
  seuilRentable: 1.5,     // badge « Ça vaut le détour » au-delà de 1,50 € net
  seuilTension: 0.2,      // mode tension si plus de 20 % des stations sont en rupture
  detourMaxTrajetKm: 6    // « Sur ma route » : stations à moins de 6 km de détour (route)
};

export function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function mediane(valeurs) {
  if (!valeurs.length) return null;
  const v = [...valeurs].sort((a, b) => a - b), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Départements dont l'emprise est à moins de rayonKm de la position (pour savoir quels fichiers charger). */
export function departementsUtiles(index, lat, lng, rayonKm) {
  const dLat = rayonKm / 111, dLng = rayonKm / (111 * Math.cos(lat * Math.PI / 180));
  return Object.entries(index.departements)
    .filter(([, d]) => {
      const [a, b, c, e] = d.emprise;
      return lat >= a - dLat && lat <= c + dLat && lng >= b - dLng && lng <= e + dLng;
    })
    .map(([num]) => num);
}

/**
 * Analyse les stations autour d'une position, ou le long d'un trajet si params.destination est donné.
 * params : { stations, lat, lng, carburant, rayonKm, volume, conso, habituelleId, maintenant, reglages,
 *            destination: { lat, lng } (facultatif) }
 *
 * La référence est la même dans les deux modes : la station habituelle, ou à défaut la plus proche
 * de la position (« ce que vous auriez payé sans l'app »). Seul le coût du détour change :
 * Autour de moi : détour = (distance station − distance référence) × 2 (aller-retour) × facteur route.
 * Sur ma route  : détour = kilomètres ajoutés au trajet (A→station→B − A→B) × facteur route.
 * Ainsi, pour une même station, le gain « sur ma route » est toujours égal ou supérieur.
 */
export function analyser(params) {
  const R = { ...REGLAGES, ...(params.reglages || {}) };
  const { stations, lat, lng, carburant: c, rayonKm = 15, volume, conso, habituelleId = null } = params;
  const maintenantMin = Math.round((params.maintenant ?? Date.now()) / 60000);

  const dest = params.destination || null;
  const dAB = dest ? distanceKm(lat, lng, dest.lat, dest.lng) : 0;
  const autour = [];
  for (const s of stations) {
    if (!(s.p[c] || (s.r && c in s.r))) continue; // ne vend pas ce carburant
    const d = distanceKm(lat, lng, s.lat, s.lng);
    let ajout = 0;
    if (dest) {
      ajout = Math.max(0, d + distanceKm(s.lat, s.lng, dest.lat, dest.lng) - dAB) * R.facteurRoute;
      if (ajout > R.detourMaxTrajetKm) continue;
    } else if (d > rayonKm) continue;
    autour.push({ station: s, distanceKm: d, ajoutKm: ajout, rupture: !!(s.r && c in s.r), fermee: !!s.ferm });
  }
  const enRupture = autour.filter(x => x.rupture);
  const dispo = autour.filter(x => !x.rupture && !x.fermee && x.station.p[c]);
  for (const x of dispo) {
    x.prix = x.station.p[c][0];
    x.ageHeures = (maintenantMin - x.station.p[c][1]) / 60;
    x.frais = x.ageHeures <= R.prixFraisHeures;
  }

  // Prix médian du secteur : prix récents, hors autoroute
  const med = mediane(dispo.filter(x => x.frais && !x.station.aut).map(x => x.prix));

  // Référence : la station habituelle si elle est disponible, sinon la plus proche de la position.
  // Sur un trajet, on la cherche autour de la position (rayon), même si elle n'est pas sur la route.
  let candidatsRef = dispo;
  if (dest) {
    candidatsRef = [...dispo];
    for (const s of stations) {
      if (!s.p[c] || (s.r && c in s.r) || s.ferm || dispo.some(x => x.station === s)) continue;
      const d = distanceKm(lat, lng, s.lat, s.lng);
      if (d > rayonKm) continue;
      candidatsRef.push({ station: s, distanceKm: d, ajoutKm: 0, prix: s.p[c][0], ageHeures: (maintenantMin - s.p[c][1]) / 60, frais: (maintenantMin - s.p[c][1]) / 60 <= R.prixFraisHeures, horsTrajet: true });
    }
  }
  let ref = null, typeRef = 'plus-proche', habituelleIndisponible = false;
  if (habituelleId) {
    ref = candidatsRef.find(x => x.station.id === habituelleId) || null;
    if (ref) typeRef = 'habituelle'; else habituelleIndisponible = true;
  }
  if (!ref) ref = candidatsRef.reduce((a, b) => (!a || b.distanceKm < a.distanceKm ? b : a), null);
  if (ref && !dispo.includes(ref)) dispo.push(ref);

  const classement = dispo.map(x => {
    const detourKm = x === ref ? 0 : dest
      ? x.ajoutKm
      : Math.max(0, x.distanceKm - ref.distanceKm) * 2 * R.facteurRoute;
    const gain = ref ? (ref.prix - x.prix) * volume - detourKm / 100 * conso * x.prix : 0;
    const estRef = x === ref;
    return {
      station: x.station,
      prix: x.prix,
      distanceKm: x.distanceKm,
      ajoutTrajetKm: dest ? Math.round(x.ajoutKm * 10) / 10 : null,
      detourKm,
      gain: Math.round(gain * 100) / 100,
      ageHeures: x.ageHeures,
      frais: x.frais,
      ecartMediane: med === null ? null : Math.round((med - x.prix) * 1000) / 1000,
      pepite: x.frais && med !== null && med - x.prix >= R.seuilPepite - 1e-9,
      verdict: estRef ? 'reference' : gain > R.seuilRentable ? 'rentable' : gain > 0 ? 'petit-gain' : 'perte'
    };
  }).sort((a, b) => b.gain - a.gain || a.distanceKm - b.distanceKm);

  const taux = autour.length ? enRupture.length / autour.length : 0;
  return {
    carburant: c,
    mode: dest ? 'trajet' : 'autour',
    nbStations: autour.length,
    nbDisponibles: dispo.length,
    nbRupture: enRupture.length,
    tauxRupture: Math.round(taux * 1000) / 1000,
    tension: taux > R.seuilTension,
    mediane: med,
    reference: ref ? { id: ref.station.id, prix: ref.prix, type: typeRef } : null,
    habituelleIndisponible,
    meilleure: classement.find(x => x.verdict !== 'reference' && x.gain > 0) || null,
    classement,
    ruptures: enRupture.map(x => ({ station: x.station, distanceKm: x.distanceKm, depuisMin: x.station.r[c] }))
  };
}

/**
 * Tendance d'une série de prix médians quotidiens (du plus ancien au plus récent).
 * Compare le dernier jour à celui d'il y a `jours` jours.
 */
export function tendance(serie, jours = 3, seuil = 0.01) {
  const v = (serie || []).filter(x => typeof x === 'number');
  if (v.length < 2) return { sens: 'inconnu', variation: 0 };
  const dernier = v[v.length - 1], avant = v[Math.max(0, v.length - 1 - jours)];
  const variation = Math.round((dernier - avant) * 1000) / 1000;
  return { sens: variation <= -seuil ? 'baisse' : variation >= seuil ? 'hausse' : 'stable', variation, dernier };
}

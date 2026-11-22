// Historique des prix : chaque jour, le prix médian par département et par carburant.
// Sert à afficher « ça baisse / ça monte » dans l'app.
// L'historique de la veille est relu depuis le site publié (ou un fichier), puis complété : rien à stocker ailleurs.

import fs from 'node:fs/promises';
import { departement } from './departements.js';
import { mediane } from './calcul.js';

export const JOURS_GARDES = 30;

const fmtJour = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
export const jourParis = ms => fmtJour.format(new Date(ms)); // "2026-11-20"

/** Médianes du jour : { "91": { gazole: 1.745, e10: 1.79 }, … } (prix de moins de 72 h, hors autoroute) */
export function medianesDuJour(stations, maintenant) {
  const limite = Math.round(maintenant / 60000) - 72 * 60;
  const parDep = {};
  for (const s of stations) {
    if (s.aut || s.ferm) continue;
    const d = departement(s.cp);
    if (!d) continue;
    for (const [c, [prix, maj]] of Object.entries(s.p)) {
      if (maj < limite || (s.r && c in s.r)) continue;
      ((parDep[d] ??= {})[c] ??= []).push(prix);
    }
  }
  const res = {};
  for (const [d, carbus] of Object.entries(parDep)) {
    res[d] = {};
    for (const [c, prix] of Object.entries(carbus)) if (prix.length >= 3) res[d][c] = Math.round(mediane(prix) * 1000) / 1000;
  }
  return res;
}

/** Relit l'historique précédent (URL du site publié ou fichier). Renvoie null s'il n'existe pas encore. */
export async function lireHistorique(source) {
  if (!source) return null;
  try {
    if (/^https?:/.test(source)) {
      const rep = await fetch(source, { signal: AbortSignal.timeout(30000) });
      if (!rep.ok) return null;
      return await rep.json();
    }
    return JSON.parse(await fs.readFile(source, 'utf8'));
  } catch {
    return null;
  }
}

/** Fusionne : remplace le jour courant, garde les 30 derniers jours. Format compact orienté app. */
export function fusionner(ancien, jour, medianes) {
  const parJour = new Map();
  if (ancien && Array.isArray(ancien.jours)) {
    ancien.jours.forEach((j, i) => {
      const o = {};
      for (const [d, carbus] of Object.entries(ancien.deps || {})) {
        for (const [c, serie] of Object.entries(carbus)) {
          if (typeof serie[i] === 'number') (o[d] ??= {})[c] = serie[i];
        }
      }
      parJour.set(j, o);
    });
  }
  parJour.set(jour, medianes);
  const jours = [...parJour.keys()].sort().slice(-JOURS_GARDES);
  const deps = {};
  jours.forEach((j, i) => {
    for (const [d, carbus] of Object.entries(parJour.get(j))) {
      for (const [c, v] of Object.entries(carbus)) {
        const serie = ((deps[d] ??= {})[c] ??= new Array(jours.length).fill(null));
        serie[i] = v;
      }
    }
  });
  return { version: 1, description: 'Prix médian quotidien (€/L) par département et carburant, hors autoroute', jours, deps };
}

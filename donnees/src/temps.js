// Les dates du flux officiel sont en heure de Paris, sans fuseau (ex. "2026-11-19 16:42:01").
// On les convertit en "minutes depuis 1970 (UTC)" : un entier court et sans ambiguïté pour l'app.

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Paris', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});

function decalageParis(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const commeUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return commeUtc - Math.floor(ms / 1000) * 1000;
}

/** "2026-11-19 16:42:01" (heure de Paris) -> millisecondes UTC, ou null si illisible. */
export function parisVersMs(texte) {
  if (!texte) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(texte.trim());
  if (!m) return null;
  const naif = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let t = naif - decalageParis(naif);
  const d2 = decalageParis(t);
  if (naif - d2 !== t) t = naif - d2; // changement d'heure été/hiver
  return t;
}

export const msVersMinutes = ms => Math.round(ms / 60000);

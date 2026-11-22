// Fabrique un faux flux officiel (XML ISO-8859-1 dans un ZIP) avec des cas pièges, pour les tests.
import zlib from 'node:zlib';

const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const heureParis = ms => fmt.format(new Date(ms)).replace(',', ''); // "2026-11-19 16:42:01"

export const CHAMPCUEIL = { lat: 48.516, lng: 2.448 };
const H = 3600000, J = 86400000;

function pdv({ id, lat, lng, cp, pop = 'R', adresse, ville, prix = [], ruptures = [], fermeture = '', h24 = false }) {
  const l = [];
  l.push(`  <pdv id="${id}" latitude="${lat}" longitude="${lng}" cp="${cp}" pop="${pop}">`);
  l.push(`    <adresse>${adresse}</adresse>`);
  l.push(`    <ville>${ville}</ville>`);
  l.push(`    <horaires automate-24-24="${h24 ? 1 : ''}"><jour id="1" nom="Lundi" ferme=""/></horaires>`);
  l.push(`    <services><service>Boutique alimentaire</service></services>`);
  for (const p of prix) l.push(`    <prix nom="${p.nom}" id="${p.id}" maj="${p.maj}" valeur="${p.valeur}"/>`);
  for (const r of ruptures) l.push(`    <rupture id="${r.id}" nom="${r.nom}" debut="${r.debut}" fin="${r.fin || ''}" type="${r.type}"/>`);
  if (fermeture) l.push('    ' + fermeture);
  l.push('  </pdv>');
  return l.join('\n');
}

/** Renvoie { xml (Buffer latin1), zip (Buffer), maintenant } */
export function fabriquerFlux({ maintenant = Date.now(), remplissage = 5200 } = {}) {
  const recent = heureParis(maintenant - 2 * H);
  const g = (v, maj = recent) => ({ nom: 'Gazole', id: 1, maj, valeur: v });
  const blocs = [
    pdv({ id: 'S1', lat: 4851700, lng: 244900, cp: '91750', adresse: 'Route de Milly', ville: 'Champcueil', prix: [g('1.760'), { nom: 'E10', id: 5, maj: recent, valeur: '1.790' }] }),
    pdv({ id: 'S2', lat: 4856900, lng: 244000, cp: '91540', adresse: 'Avenue de la Gare', ville: 'Mennecy', prix: [g('1.659')], h24: true }),
    pdv({ id: 'S3', lat: 4853000, lng: 250000, cp: '91070', pop: 'A', adresse: 'Aire de service A6', ville: 'Bondoufle', prix: [g('2.050')] }),
    pdv({ id: 'S4', lat: '48.52', lng: '2.46', cp: '91750', adresse: 'Rue du Moulin', ville: 'Champcueil', prix: [g('1.740', heureParis(maintenant - 30 * H))],
      ruptures: [{ id: 1, nom: 'Gazole', debut: heureParis(maintenant - 20 * H), type: 'temporaire' }] }),
    pdv({ id: 'S5', lat: 4852500, lng: 238500, cp: '91610', adresse: 'Rue de Paris', ville: 'Ballancourt', prix: [g('1.730'), { nom: 'E85', id: 3, maj: recent, valeur: '0.799' }],
      ruptures: [{ id: 3, nom: 'E85', debut: heureParis(maintenant - 90 * J), type: 'definitive' }] }),
    pdv({ id: 'S6', lat: 4850000, lng: 243000, cp: '91750', adresse: 'Chemin vert', ville: 'Champcueil', prix: [g('1.745')],
      ruptures: [{ id: 1, nom: 'Gazole', debut: heureParis(maintenant - 50 * H), fin: heureParis(maintenant - 10 * H), type: 'temporaire' }] }),
    pdv({ id: 'S7', lat: 4851000, lng: 245500, cp: '91750', adresse: 'Ancienne station', ville: 'Champcueil', prix: [g('1.600')],
      fermeture: `<fermeture type="D" debut="${heureParis(maintenant - 40 * J)}" fin=""/>` }),
    pdv({ id: 'S8', lat: 4851200, lng: 246000, cp: '91750', adresse: 'Place de l&apos;Église', ville: 'Champcueil', prix: [g('1.700')],
      fermeture: `<fermeture type="T" debut="${heureParis(maintenant - 5 * H)}" fin="${heureParis(maintenant + 48 * H)}"/>` }),
    pdv({ id: 'S9', lat: 4851500, lng: 244000, cp: '91750', adresse: 'Vieille pompe', ville: 'Champcueil', prix: [g('1.500', heureParis(maintenant - 40 * J))] }),
    pdv({ id: 'S10', lat: 4547000, lng: 437000, cp: '42000', adresse: 'Rue Michelet &amp; Cie', ville: 'SAINT-ÉTIENNE', prix: [g('1749')] }),
    pdv({ id: 'S11', lat: 4192000, lng: 873000, cp: '20000', adresse: 'Cours Napoléon', ville: 'Ajaccio', prix: [g('1.950')] }),
    pdv({ id: 'S12', lat: 4270000, lng: 945000, cp: '20600', adresse: 'Route du port', ville: 'Bastia', prix: [g('1.940')] })
  ];
  // Remplissage : stations ordinaires partout en France, sauf autour de Champcueil (pour des tests déterministes)
  let graine = 42;
  const rnd = () => (graine = (graine * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < remplissage; i++) {
    let lat, lng;
    do { lat = 43 + rnd() * 7; lng = -1 + rnd() * 8; } while (Math.abs(lat - 48.5) < 0.4 && Math.abs(lng - 2.45) < 0.5);
    const dep = String(1 + Math.floor(rnd() * 89)).padStart(2, '0');
    blocs.push(pdv({ id: 'F' + i, lat: Math.round(lat * 100000), lng: Math.round(lng * 100000), cp: dep + '100', adresse: 'Rue ' + i, ville: 'Ville ' + i,
      prix: [g((1.70 + rnd() * 0.12).toFixed(3))], ruptures: rnd() < 0.08 ? [{ id: 1, nom: 'Gazole', debut: heureParis(maintenant - rnd() * 40 * H), type: 'temporaire' }] : [] }));
  }
  const texte = `<?xml version="1.0" encoding="ISO-8859-1" standalone="yes"?>\n<pdv_liste>\n${blocs.join('\n')}\n</pdv_liste>\n`;
  const xml = Buffer.from(texte, 'latin1');
  return { xml, zip: zipper('PrixCarburants_instantane.xml', xml), maintenant };
}

/** Écrit un ZIP minimal (une entrée, compression deflate) */
export function zipper(nom, donnees) {
  const comp = zlib.deflateRawSync(donnees);
  const crc = zlib.crc32(donnees);
  const n = Buffer.from(nom, 'latin1');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(donnees.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(donnees.length, 24); central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const offCentral = 30 + n.length + comp.length;
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(1, 8); fin.writeUInt16LE(1, 10);
  fin.writeUInt32LE(46 + n.length, 12); fin.writeUInt32LE(offCentral, 16);
  return Buffer.concat([local, n, comp, central, n, fin]);
}

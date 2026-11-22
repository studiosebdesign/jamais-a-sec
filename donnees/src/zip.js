// Lecture d'une archive ZIP sans dépendance externe.
// Le flux officiel est un ZIP d'environ 3 Mo contenant un seul fichier XML.
// On ne décompresse pas tout en mémoire : on renvoie un flux qui livre le XML morceau par morceau.

import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const SIG_FIN = 0x06054b50;      // fin du répertoire central
const SIG_CENTRAL = 0x02014b50;  // entrée du répertoire central
const SIG_LOCAL = 0x04034b50;    // en-tête local d'un fichier

function trouverFin(buf) {
  // La fin du répertoire central est dans les 64 derniers Ko (commentaire max 65535 octets).
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_FIN) return i;
  }
  throw new Error('Archive ZIP invalide : fin du répertoire introuvable');
}

/** Renvoie la liste des fichiers contenus dans le ZIP. */
export function listerZip(buf) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error('Ce fichier n\'est pas une archive ZIP');
  }
  const fin = trouverFin(buf);
  const nb = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  const entrees = [];
  for (let i = 0; i < nb; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('Répertoire central ZIP corrompu');
    const methode = buf.readUInt16LE(p + 10);
    const tailleCompressee = buf.readUInt32LE(p + 20);
    const taille = buf.readUInt32LE(p + 24);
    const lnNom = buf.readUInt16LE(p + 28);
    const lnExtra = buf.readUInt16LE(p + 30);
    const lnComm = buf.readUInt16LE(p + 32);
    const offsetLocal = buf.readUInt32LE(p + 42);
    const nom = buf.toString('latin1', p + 46, p + 46 + lnNom);
    entrees.push({ nom, methode, tailleCompressee, taille, offsetLocal });
    p += 46 + lnNom + lnExtra + lnComm;
  }
  return entrees;
}

/** Ouvre le premier fichier .xml du ZIP et renvoie un flux d'octets décompressés. */
export function ouvrirXmlDansZip(buf) {
  const entree = listerZip(buf).find(e => e.nom.toLowerCase().endsWith('.xml'));
  if (!entree) throw new Error('Aucun fichier XML dans l\'archive');
  const o = entree.offsetLocal;
  if (buf.readUInt32LE(o) !== SIG_LOCAL) throw new Error('En-tête local ZIP corrompu');
  const debut = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  const donnees = buf.subarray(debut, debut + entree.tailleCompressee);
  const source = Readable.from([donnees]);
  if (entree.methode === 0) return { nom: entree.nom, taille: entree.taille, flux: source };
  if (entree.methode === 8) return { nom: entree.nom, taille: entree.taille, flux: source.pipe(zlib.createInflateRaw()) };
  throw new Error('Méthode de compression ZIP non gérée : ' + entree.methode);
}

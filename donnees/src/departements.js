// Numéro de département à partir du code postal.
export function departement(cp) {
  const c = String(cp || '').trim().padStart(5, '0');
  if (!/^\d{5}$/.test(c)) return null;
  if (c.startsWith('97') || c.startsWith('98')) return c.slice(0, 3); // outre-mer
  if (c.startsWith('20')) return parseInt(c, 10) < 20200 ? '2A' : '2B'; // Corse
  return c.slice(0, 2);
}

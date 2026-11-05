// Normalising what intake staff type into GoHighLevel before it reaches MerusCase or the matcher.

const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
// English and Spanish short forms common in California intake (both directions resolve to one key).
const NICK = {
  bob: 'robert', bobby: 'robert', rob: 'robert', bill: 'william', billy: 'william', will: 'william', jim: 'james', jimmy: 'james',
  mike: 'michael', mikey: 'michael', liz: 'elizabeth', beth: 'elizabeth', kate: 'katherine', kathy: 'katherine', tony: 'anthony',
  joe: 'joseph', joey: 'joseph', chris: 'christopher', dan: 'daniel', danny: 'daniel', dave: 'david', steve: 'steven', stephen: 'steven',
  tom: 'thomas', rick: 'richard', rich: 'richard', dick: 'richard', ed: 'edward', eddie: 'edward', sam: 'samuel', nick: 'nicholas',
  matt: 'matthew', pat: 'patricia', patty: 'patricia', sue: 'susan', jen: 'jennifer', jenny: 'jennifer', alex: 'alexander', ben: 'benjamin',
  pepe: 'jose', chuy: 'jesus', lupe: 'guadalupe', paco: 'francisco', pancho: 'francisco', nacho: 'ignacio', memo: 'guillermo',
  lalo: 'eduardo', beto: 'alberto', toño: 'antonio', tono: 'antonio', chema: 'jose maria', lencho: 'lorenzo', rafa: 'rafael', quique: 'enrique',
};

export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function nameTokens(s) {
  return fold(s).replace(/[^a-z\s'-]/g, ' ').split(/[\s-]+/).map((t) => t.replace(/'/g, '')).filter((t) => t && !SUFFIX.has(t));
}
export const canonFirst = (s) => { const t = nameTokens(s)[0] || ''; return NICK[t] || t; };
export const suffixOf = (s) => (fold(s).match(/\b(jr|sr|ii|iii|iv)\b/) || [])[1] || null;

export function phone10(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return ten.length === 10 ? ten : null;
}
export const email = (s) => { const e = String(s ?? '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null; };

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
/** Accepts 2026-03-04, 03/04/2026, 3/4/26, "Mar 4th 2026", "March 4, 2026"; returns ISO yyyy-mm-dd or null. */
export function isoDate(s) {
  if (s == null || s === '') return null;
  const t = String(s).trim();
  let y, m, d, x;
  if ((x = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) { [m, d, y] = [+x[1], +x[2], +x[3]]; if (y < 100) y += y > 50 ? 1900 : 2000; }
  else if ((x = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) { m = MONTHS[x[1].slice(0, 4).toLowerCase()] || MONTHS[x[1].slice(0, 3).toLowerCase()]; d = +x[2]; y = +x[3]; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (!m || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
/** MerusCase injuries/edit wants MM/DD/YYYY. */
export const mdy = (iso) => (iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : null);

export function injuryType(s) {
  const t = fold(s).replace(/[^a-z ]/g, ' ').trim();
  if (/^(ct|cumulative|cumulative trauma|repetitive)/.test(t) || /\bct\b/.test(t)) return 'CT';
  if (/^(specific|single|accident|one time|acute)/.test(t)) return 'SPECIFIC';
  return null;
}

/** "L knee, right shoulder, low back, bilateral wrists" -> [{part, lr}] ; lr: 0 N/A, 1 L, 2 R, 3 LR */
export function bodyParts(s, dict) {
  const out = []; const unknown = [];
  for (let raw of String(s ?? '').split(/[,;/\n]|\band\b|&/i)) {
    let t = fold(raw).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    let lr = 0;
    if (/\b(bilateral|both|bil)\b/.test(t)) lr = 3; else if (/^(l|lt|left)\b/.test(t) || /\bleft\b/.test(t)) lr = 1; else if (/^(r|rt|right)\b/.test(t) || /\bright\b/.test(t)) lr = 2;
    t = t.replace(/\b(bilateral|both|bil|left|right|lt|rt|l|r)\b/g, '').replace(/\s+/g, ' ').trim();
    let key = dict.parts[t] !== undefined ? t : dict.parts[t.replace(/s$/, '')] !== undefined ? t.replace(/s$/, '') : null;
    if (!key) { unknown.push(raw.trim()); continue; }
    out.push({ part: key, id: dict.parts[key], lr: dict.sided.includes(key) ? lr : 0 });
  }
  // the same part twice (e.g. "left knee, right knee") becomes one bilateral entry
  const merged = [];
  for (const p of out) {
    const m = merged.find((q) => q.id === p.id);
    if (!m) merged.push({ ...p });
    else if (m.lr !== p.lr && m.lr && p.lr) m.lr = 3;
  }
  return { parts: merged, unknown };
}

export const zip5 = (s) => (String(s ?? '').match(/^\s*(\d{5})(?:-\d{4})?\s*$/) || [])[1] || null;
const STATES = { california: 'CA', nevada: 'NV', oregon: 'OR', arizona: 'AZ', washington: 'WA', texas: 'TX' };
export const state2 = (s) => { const t = String(s ?? '').trim(); if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase(); return STATES[fold(t)] || null; };
export const adj = (s) => { const t = String(s ?? '').toUpperCase().replace(/\s+/g, ''); return /^ADJ\d{7,8}$/.test(t) ? t : null; };

// Contact dedupe against a local index of MerusCase contacts.
// MerusCase's published API reads a contact only by ID (contacts/view/:id) and lists none, so
// "check for an existing contact" needs this index: built once from caseFiles/index -> parties/view
// -> contacts/view, kept current with caseFiles/index?modified[gte]=..., and updated by every
// contact the bridge creates.
//
// Rules, strictest first. A link needs a date of birth or a phone/email to agree, never a name alone;
// a different date of birth never auto-links (parent and child often share a name and a phone).
import { nameTokens, canonFirst, suffixOf, phone10, email as normEmail, fold } from './normalize.js';
import { now, tx } from './db.js';

export function indexContact(db, c, source = 'merus') {
  const last = nameTokens(c.last_name); const phones = [...new Set((c.phones || []).map(phone10).filter(Boolean))];
  tx(db, () => {
    db.prepare(`INSERT INTO contacts_index(contact_id, kind, first, last, first_canon, dob, email, suffix, company, source, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(contact_id) DO UPDATE SET kind=excluded.kind, first=excluded.first, last=excluded.last,
      first_canon=excluded.first_canon, dob=excluded.dob, email=excluded.email, suffix=excluded.suffix, company=excluded.company, source=excluded.source, updated_at=excluded.updated_at`)
      .run(c.id, c.company ? 'company' : 'person', c.first_name ?? null, c.last_name ?? null, c.first_name ? canonFirst(c.first_name) : null, c.date_of_birth ?? null,
        normEmail(c.email), suffixOf(`${c.first_name ?? ''} ${c.last_name ?? ''}`), c.company ? companyKey(c.company) : null, source, now());
    db.prepare('DELETE FROM contact_phones WHERE contact_id = ?').run(c.id);
    db.prepare('DELETE FROM contact_lastnames WHERE contact_id = ?').run(c.id);
    for (const p of phones) db.prepare('INSERT OR IGNORE INTO contact_phones VALUES (?, ?)').run(c.id, p);
    for (const t of last) db.prepare('INSERT OR IGNORE INTO contact_lastnames VALUES (?, ?)').run(c.id, t);
  });
}

export const companyKey = (s) => fold(s).replace(/&/g, ' and ').replace(/\b(inc|llc|l l c|corp|corporation|co|company|ltd|the|dba)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const lastMatch = (A, B) => A.some((a) => B.includes(a)) || (A.length && B.length && A.some((a) => B.some((b) => a.length >= 5 && b.length >= 5 && lev(a, b) <= 1)));
const firstMatch = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return a.length >= 5 && b.length >= 5 && lev(a, b) <= 1;
};

function evidence(p, c) {
  const pl = nameTokens(p.last_name); const cl = c.last ? nameTokens(c.last) : [];
  const pf = canonFirst(p.first_name); const cf = c.first_canon;
  let last = lastMatch(pl, cl); let first = firstMatch(pf, cf);
  if (!(last && first) && c.first && lastMatch(pl, [canonFirst(c.first)]) && firstMatch(pf, cl[0] ? (canonFirst(cl[0])) : '')) { last = first = true; } // first/last typed the wrong way round
  const pPhones = (p.phones || []).map(phone10).filter(Boolean);
  return {
    dob: !p.date_of_birth || !c.dob ? 'unknown' : p.date_of_birth === c.dob ? 'same' : 'different',
    last, first,
    phone: pPhones.some((x) => c.phones.includes(x)),
    email: Boolean(normEmail(p.email) && normEmail(p.email) === c.email),
    suffixClash: Boolean(suffixOf(`${p.first_name} ${p.last_name}`) && c.suffix && suffixOf(`${p.first_name} ${p.last_name}`) !== c.suffix),
  };
}

function classify(e) {
  const contactMatch = e.phone || e.email;
  // same name, different date of birth and nothing else shared: a different person (common names are common)
  if (e.dob === 'different') return contactMatch ? ['review', `${e.phone ? 'phone' : 'email'} on file for someone with a different date of birth`] : ['none', ''];
  if (e.suffixClash) return e.last && e.first ? ['review', 'Jr./Sr. differ'] : ['none', ''];
  if (e.dob === 'same' && e.last && e.first) return ['link', 'name and date of birth'];
  if (e.dob === 'same' && contactMatch && (e.last || e.first)) return ['link', `date of birth, ${e.phone ? 'phone' : 'email'} and ${e.last ? 'last' : 'first'} name`];
  if (e.dob === 'unknown' && e.last && e.first && contactMatch) return ['link', `name and ${e.phone ? 'phone' : 'email'} (no date of birth on file)`];
  if (e.dob === 'same' && (e.last || e.first)) return ['review', 'date of birth and part of the name'];
  if (e.last && e.first) return ['review', e.dob === 'unknown' ? 'name only' : 'name only'];
  if (contactMatch) return ['review', `${e.phone ? 'phone' : 'email'} belongs to someone with another name`];
  return ['none', ''];
}

export function findPerson(db, p) {
  const ids = new Set();
  const add = (rows) => rows.forEach((r) => ids.add(r.contact_id));
  if (p.date_of_birth) add(db.prepare("SELECT contact_id FROM contacts_index WHERE kind = 'person' AND dob = ?").all(p.date_of_birth));
  for (const ph of (p.phones || []).map(phone10).filter(Boolean)) add(db.prepare('SELECT contact_id FROM contact_phones WHERE phone = ?').all(ph));
  if (normEmail(p.email)) add(db.prepare("SELECT contact_id FROM contacts_index WHERE kind = 'person' AND email = ?").all(normEmail(p.email)));
  for (const t of nameTokens(p.last_name)) add(db.prepare('SELECT contact_id FROM contact_lastnames WHERE token = ?').all(t));
  for (const t of nameTokens(p.first_name).slice(0, 1)) add(db.prepare('SELECT contact_id FROM contact_lastnames WHERE token = ?').all(t)); // swapped names

  const results = [];
  for (const id of ids) {
    const c = db.prepare("SELECT * FROM contacts_index WHERE contact_id = ? AND kind = 'person'").get(id);
    if (!c) continue;
    c.phones = db.prepare('SELECT phone FROM contact_phones WHERE contact_id = ?').all(id).map((r) => r.phone);
    const e = evidence(p, c); const [decision, reason] = classify(e);
    if (decision !== 'none') results.push({ contactId: id, decision, reason, name: `${c.first} ${c.last}`, evidence: e });
  }
  const links = results.filter((r) => r.decision === 'link');
  const reviews = results.filter((r) => r.decision === 'review');
  if (links.length === 1) return { decision: 'link', contactId: links[0].contactId, reason: links[0].reason, candidates: results, considered: ids.size };
  if (links.length > 1) return { decision: 'review', reason: `${links.length} existing contacts match`, candidates: results, considered: ids.size };
  if (links.length || reviews.length) return { decision: 'review', reason: (links[0] || reviews[0]).reason, candidates: results, considered: ids.size };
  return { decision: 'new', reason: 'no existing contact matches', candidates: [], considered: ids.size };
}

export function findCompany(db, name) {
  const key = companyKey(name);
  if (!key) return null;
  const row = db.prepare("SELECT contact_id FROM contacts_index WHERE kind = 'company' AND company = ? ORDER BY contact_id LIMIT 1").get(key);
  return row ? row.contact_id : null;
}

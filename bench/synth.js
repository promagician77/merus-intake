// Synthetic people, cases and leads for tests and the bench. Every person here is invented; names are
// drawn from common first and last names so collisions happen as they do in a real 3,000-case file.
export function rng(seed = 7) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];

const FIRST = ['Maria', 'Jose', 'Juan', 'Luis', 'Carlos', 'Jesus', 'Francisco', 'Guadalupe', 'Rosa', 'Ana', 'Miguel', 'Antonio', 'Alejandro', 'Ricardo', 'Veronica', 'Elizabeth', 'Robert', 'William', 'James', 'Michael', 'David', 'Daniel', 'Jennifer', 'Patricia', 'Susan', 'Thomas', 'Richard', 'Joseph', 'Christopher', 'Anthony', 'Steven', 'Edward', 'Samuel', 'Nicholas', 'Linh', 'Minh', 'Wei', 'Mei', 'Jasmine', 'Angelica', 'Ignacio', 'Eduardo', 'Alberto', 'Rafael', 'Enrique', 'Lorenzo', 'Katherine', 'Benjamin', 'Rodrigo', 'Esperanza', 'Teresa', 'Raul', 'Hector', 'Sergio', 'Oscar', 'Marisol', 'Yesenia', 'Andre', 'Darnell', 'Keisha', 'Priya', 'Arjun', 'Noa', 'Siosaia'];
const LAST = ['Garcia', 'Hernandez', 'Lopez', 'Martinez', 'Gonzalez', 'Rodriguez', 'Perez', 'Sanchez', 'Ramirez', 'Torres', 'Flores', 'Rivera', 'Gomez', 'Diaz', 'Reyes', 'Morales', 'Cruz', 'Ortiz', 'Gutierrez', 'Chavez', 'Ramos', 'Ruiz', 'Alvarez', 'Mendoza', 'Castillo', 'Jimenez', 'Moreno', 'Romero', 'Herrera', 'Medina', 'Aguilar', 'Vargas', 'Nguyen', 'Tran', 'Le', 'Pham', 'Chen', 'Wong', 'Lee', 'Kim', 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'White', 'Harris', 'Clark', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'Wright', 'Scott', 'Patel', 'Singh', 'Fifita', 'Tuilagi', 'Garcia Lopez', 'Hernandez Cruz', 'Peña', 'Muñoz', 'Nuñez', 'Ibáñez'];
const NICKS = { Robert: 'Bob', William: 'Bill', James: 'Jim', Michael: 'Mike', Elizabeth: 'Liz', Katherine: 'Kate', Anthony: 'Tony', Joseph: 'Joe', Christopher: 'Chris', Daniel: 'Danny', David: 'Dave', Thomas: 'Tom', Richard: 'Rick', Edward: 'Eddie', Samuel: 'Sam', Nicholas: 'Nick', Jose: 'Pepe', Jesus: 'Chuy', Guadalupe: 'Lupe', Francisco: 'Paco', Ignacio: 'Nacho', Eduardo: 'Lalo', Alberto: 'Beto', Rafael: 'Rafa', Enrique: 'Quique', Lorenzo: 'Lencho', Patricia: 'Patty', Steven: 'Steve' };
export const EMPLOYERS = ['Marin Valley Landscaping Inc.', 'Bay Area Freight LLC', 'Sonoma Hills Vineyards', 'Golden Gate Hospitality Group', 'North Bay Builders, Inc.', 'Redwood Home Care', 'Petaluma Poultry Co.', 'San Rafael Unified School District', 'Pacific Coast Warehousing', 'Mission Street Restaurant Group', 'Novato Auto Body', 'Tamalpais Senior Living', 'Larkspur Ferry Services', 'Richmond Steel Fabrication', 'East Bay Janitorial Services'];

const pad = (n) => String(n).padStart(2, '0');
const dob = (r) => `${1956 + Math.floor(r() * 46)}-${pad(1 + Math.floor(r() * 12))}-${pad(1 + Math.floor(r() * 28))}`;
const phone = (r) => `415${String(2000000 + Math.floor(r() * 7999999)).padStart(7, '0')}`;
const fmtPhone = (p, k) => [p, `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`, `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}`, `+1 ${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6)}`][k % 4];
const mail = (f, l, r) => `${f}.${l}${Math.floor(r() * 90 + 10)}@example.com`.toLowerCase().replace(/[^a-z0-9.@]/g, '');
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

export function existingPeople(n, r) {
  const people = [];
  for (let i = 0; i < n; i++) {
    const p = { first: pick(r, FIRST), last: pick(r, LAST), dob: dob(r), phone: phone(r) };
    p.email = r() < 0.7 ? mail(p.first, p.last, r) : null;
    const k = r();
    if (k < 0.04 && people.length) { const hh = pick(r, people); p.last = hh.last; p.phone = hh.phone; p.household = hh; } // same household
    else if (k < 0.06 && people.length) { const fa = pick(r, people); if (fa.dob < '1975-01-01') { p.first = fa.first; p.last = fa.last; p.dob = `${+fa.dob.slice(0, 4) + 24}${fa.dob.slice(4)}`; p.phone = r() < 0.5 ? fa.phone : p.phone; p.juniorOf = fa; } }
    people.push(p);
  }
  return people;
}

export function seedStore(store, people, r) {
  const employers = EMPLOYERS.map((name) => store.addContact({ company_name: name, is_company: 1 }));
  const when = new Date('2025-06-01T12:00:00Z');
  people.forEach((p, i) => {
    const cid = store.addContact({ first_name: p.first, last_name: p.last, birth_date: `${p.dob.slice(5, 7)}/${p.dob.slice(8, 10)}/${p.dob.slice(0, 4)}`, cell_phone: p.phone, email: p.email });
    p.contactId = cid;
    const caseId = store.addCase({ case_type_id: 10001, case_status_id: 1001 }, new Date(when.getTime() - i * 3600000));
    store.addParty(cid, caseId);
    store.addParty(employers[i % employers.length], caseId);
    store.addInjury({ case_file_id: caseId, injury_type_id: r() < 0.4 ? 1 : 2, date_of_injury: '03/15/2024' });
  });
  return { employers };
}

/** Lead variants of an existing person, as intake staff might type them. Returns [person, variantName]. */
export function returningVariant(p, k, r) {
  const v = { first: p.first, last: p.last, dob: p.dob, phone: p.phone, email: p.email };
  const kinds = ['exact', 'nickname', 'accents', 'phone-format', 'new-phone', 'email-case', 'hyphen', 'typo', 'swapped', 'name-dob-only', 'middle-name'];
  let kind = kinds[k % kinds.length];
  if (kind === 'nickname' && !NICKS[p.first]) kind = 'phone-format';
  if (kind === 'typo' && p.last.length < 5) kind = 'exact';
  switch (kind) {
    case 'nickname': v.first = NICKS[p.first]; break;
    case 'accents': v.last = /[^\x00-\x7f]/.test(p.last) ? strip(p.last) : p.last; v.first = p.first.toUpperCase(); break;
    case 'phone-format': v.phone = fmtPhone(p.phone, k); break;
    case 'new-phone': v.phone = phone(r); v.email = null; break;
    case 'email-case': v.email = p.email ? p.email.toUpperCase() : null; break;
    case 'hyphen': v.last = p.last.includes(' ') ? p.last.replace(' ', '-') : p.last.toLowerCase(); break;
    case 'typo': { const i = 2 + Math.floor(r() * (p.last.length - 3)); v.last = p.last.slice(0, i) + p.last[i + 1] + p.last[i] + p.last.slice(i + 2); break; }
    case 'swapped': [v.first, v.last] = [p.last, p.first]; break;
    case 'name-dob-only': v.phone = phone(r); v.email = null; break;
    case 'middle-name': v.first = `${p.first} ${pick(r, ['Elena', 'Luis', 'Ann', 'Marie', 'Jose'])}`; break;
  }
  return { ...v, kind };
}

export function newPerson(r, existing) {
  for (;;) {
    const p = { first: pick(r, FIRST), last: pick(r, LAST), dob: dob(r), phone: phone(r) };
    p.email = r() < 0.6 ? mail(p.first, p.last, r) : null;
    if (!existing.some((e) => e.first === p.first && e.last === p.last && e.dob === p.dob)) return p;
  }
}

/** People who share something with an existing contact but are someone else. */
export function hardNegative(r, existing, k) {
  const e = pick(r, existing.filter((x) => x.dob < '1990-01-01'));
  const kind = ['same-name-other-dob', 'household-phone', 'junior-same-phone'][k % 3];
  if (kind === 'same-name-other-dob') return { first: e.first, last: e.last, dob: `${+e.dob.slice(0, 4) + 7}${e.dob.slice(4)}`, phone: phone(r), email: null, kind, of: e };
  if (kind === 'household-phone') return { first: pick(r, FIRST.filter((f) => f !== e.first)), last: e.last, dob: `${+e.dob.slice(0, 4) + 3}-0${1 + (k % 9)}-1${k % 9}`, phone: e.phone, email: null, kind, of: e };
  return { first: `${e.first} Jr.`, last: e.last, dob: `${+e.dob.slice(0, 4) + 25}${e.dob.slice(4)}`, phone: e.phone, email: null, kind, of: e };
}

/** A GoHighLevel Custom Webhook body (see ghl/custom-webhook-body.json) for a person. */
export function ghlBody(p, r, { id, injuries = 1, employer = true, referral = true, signed = '2026-10-20', attorney = 'Dan Hegwer', overrides = {} } = {}) {
  const b = {
    contact_id: `ghl_${id}`, pipeline_name: 'Intake', pipeline_stage: 'Signed',
    first_name: p.first, last_name: p.last, date_of_birth: p.dob, phone: p.phone, email: p.email || '', home_phone: '',
    address1: `${100 + Math.floor(r() * 900)} ${pick(r, ['Fourth St', 'B St', 'Lincoln Ave', 'Grand Ave', 'Second St'])}`, city: pick(r, ['San Rafael', 'Novato', 'Petaluma', 'Richmond', 'San Anselmo']), state: 'CA', postal_code: pick(r, ['94901', '94903', '94945', '94952', '94801']),
    preferred_language: r() < 0.4 ? 'Spanish' : 'English', occupation: pick(r, ['Landscaper', 'Warehouse associate', 'Home health aide', 'Line cook', 'Carpenter', 'Janitor', 'Teacher aide', 'Truck driver']),
    treating_doctors: r() < 0.5 ? 'Dr. A. Example (PTP)' : '', assigned_attorney: attorney, case_manager: 'Intake Staff',
    employer_name: employer ? pick(r, EMPLOYERS).replace(', Inc.', ' Inc').replace(' LLC', ', LLC') : '', referral_source: referral ? pick(r, ['Google Ads', 'Former client', 'Spanish radio', 'Union referral', 'Facebook']) : '', signed_date: signed,
  };
  const parts = ['L knee', 'right shoulder', 'low back', 'neck', 'bilateral wrists', 'psyche', 'left ankle, left foot', 'R hand and fingers', 'sleep', 'headaches'];
  for (let n = 1; n <= injuries; n++) {
    const ct = n === 1 ? r() < 0.4 : r() < 0.6;
    const y = 2023 + Math.floor(r() * 3); const m = pad(1 + Math.floor(r() * 12)); const d = pad(1 + Math.floor(r() * 28));
    Object.assign(b, {
      [`injury_${n}_type`]: ct ? 'CT' : 'Specific', [`injury_${n}_date`]: ct ? `${y - 2}-${m}-${d}` : `${y}-${m}-${d}`, [`injury_${n}_end_date`]: ct ? `${y}-${m}-${d}` : '',
      [`injury_${n}_body_parts`]: [pick(r, parts), pick(r, parts)].join(', '), [`injury_${n}_description`]: ct ? 'Repetitive lifting over years' : 'Fell from ladder',
      [`injury_${n}_how`]: ct ? 'Daily lifting of 40-60 lb loads' : 'Ladder slipped on wet floor', [`injury_${n}_location`]: 'Employer premises',
      [`injury_${n}_claim_number`]: r() < 0.5 ? `clm-${Math.floor(r() * 1e8)}` : '', [`injury_${n}_adj_number`]: r() < 0.3 ? `ADJ${18000000 + Math.floor(r() * 999999)}` : '',
    });
  }
  return { ...b, ...overrides };
}

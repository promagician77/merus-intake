// Reads the field map (config/mapping.csv - the firm's spreadsheet exported as CSV) and turns a
// GoHighLevel webhook body into one normalised lead.
import { readFileSync } from 'node:fs';
import * as N from './normalize.js';

export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some((x) => x !== '')) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

export function loadMapping(path = new URL('../config/mapping.csv', import.meta.url)) {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  return rows.map((r) => ({ ...r, n: Number(r.n), required: r.required === 'yes', perInjury: r.ghl_key.includes('{n}') }));
}

// GHL's outbound Webhook puts contact fields at the top level and custom fields by name; the Custom
// Webhook action sends whatever JSON body is configured. Both are flattened into one lookup that
// ignores case, spaces and punctuation in keys ("Injury 1 Date" == "injury_1_date").
const keyNorm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
export function flatten(body) {
  const out = new Map();
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) visit(v, depth + 1);
      else if (!out.has(keyNorm(k))) out.set(keyNorm(k), Array.isArray(v) ? v.join(', ') : v);
    }
  };
  // top level wins over nested objects with the same key
  for (const [k, v] of Object.entries(body || {})) if (v == null || typeof v !== 'object' || Array.isArray(v)) out.set(keyNorm(k), Array.isArray(v) ? v.join(', ') : v);
  visit(body, 0);
  return out;
}

export function toLead(body, mapping, { bodyDict, maxInjuries = 3 }) {
  const f = flatten(body);
  // an empty field, or a merge tag GoHighLevel left unrendered ("{{contact.x}}"), counts as blank
  const get = (k) => { const v = f.get(keyNorm(k)); if (v === undefined || v === null) return null; const t = String(v).trim(); return t === '' || /^\{\{[^}]*\}\}$/.test(t) ? null : t; };
  const T = {
    name: (v) => v && v.replace(/\s+/g, ' '), text: (v) => v, upper: (v) => v && v.toUpperCase(), date: N.isoDate, phone: N.phone10, email: N.email,
    state: N.state2, zip: N.zip5, injury_type: N.injuryType, adj: N.adj, user: (v) => v, body_parts: (v) => N.bodyParts(v, bodyDict),
  };
  const lead = {
    source: {
      opportunityId: get('opportunity_id') || get('opportunityId') || get('id'),
      contactId: get('contact_id') || get('contactId'),
      pipeline: get('pipeline_name') || get('pipeline'),
      stage: get('pipeline_stage') || get('pipleline_stage') || get('stage') || get('stage_name'),
    },
    contact: {}, case: {}, injuries: [], gaps: {}, county: get('county'), raw: {}, problems: [],
  };
  for (const m of mapping.filter((x) => !x.perInjury)) {
    const raw = get(m.ghl_key); const val = raw == null ? null : T[m.transform](raw);
    if (raw != null && (val == null || val === '')) lead.problems.push({ field: m.label, problem: `could not read "${raw}"` });
    if (m.scope === 'contact') lead.contact[m.ghl_key] = val;
    else if (m.scope === 'case') lead.case[m.ghl_key] = val;
    else if (m.scope === 'gap') lead.gaps[m.ghl_key] = val;
    else lead.raw[m.ghl_key] = val; // lead-level values copied into every injury (occupation, doctors)
  }
  for (let n = 1; n <= maxInjuries; n++) {
    const inj = { n };
    let any = false;
    for (const m of mapping.filter((x) => x.perInjury)) {
      const raw = get(m.ghl_key.replace('{n}', n));
      if (raw != null) any = true;
      const val = raw == null ? null : T[m.transform](raw);
      if (raw != null && (val == null || (m.transform === 'body_parts' && val.unknown.length)))
        lead.problems.push({ field: `${m.label} (injury ${n})`, problem: m.transform === 'body_parts' ? `unknown body part: ${val.unknown.join(', ')}` : `could not read "${raw}"` });
      inj[m.ghl_key.replace('injury_{n}_', '')] = val;
    }
    if (any) { inj.occupation = lead.raw.occupation ?? null; inj.treating_doctors = lead.raw.treating_doctors ?? null; lead.injuries.push(inj); }
  }
  if (get(`injury_${maxInjuries + 1}_date`)) lead.problems.push({ field: 'Injuries', problem: `more than ${maxInjuries} injuries on the lead` });
  return lead;
}

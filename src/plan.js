// Turns a validated lead plus the dedupe decision into the ordered MerusCase calls.
//   1 caseFiles/add       case + contact (or the existing contact ID) + injury 1   (one injury per POST)
//   2 contacts/edit       existing contact only: fill fields that are blank in MerusCase, never overwrite
//   3 injuries/edit       injury 2..n, no Injury id = add (published behaviour)
//   4 employer            reuse an indexed employer contact or contacts/add, then parties/add
//   5 activities/add      referral source; retainer signed, dated on the signed date; data notes
//   6 GoHighLevel         tag + note with the MerusCase case ID
import { mdy } from './normalize.js';

export function contactFields(lead, mapping) {
  const out = {};
  for (const m of mapping.filter((x) => x.scope === 'contact')) {
    const v = lead.contact[m.ghl_key];
    if (v == null || v === '') continue;
    out[m.target.replace('Contact.', '')] = m.transform === 'date' ? mdy(v) : v;
  }
  return out;
}

export function injuryFields(inj, firm) {
  const f = {
    injury_type_id: firm.injuryTypeIds[inj.type],
    date_of_injury: mdy(inj.date),
    date_of_injury_end: inj.type === 'CT' ? mdy(inj.end_date) : null,
    q1_injury_description_text: inj.description,
    q2_injury_occurrence: inj.how,
    q1_occupation: inj.occupation,
    q1_location: inj.location,
    q7_doctors: inj.treating_doctors,
    carrier_claim_number: inj.claim_number,
    eams_case_number: inj.adj_number,
  };
  (inj.body_parts?.parts || []).slice(0, 10).forEach((p, k) => { f[`q1_injury_description_${k + 1}_id`] = p.id; f[`q1_injury_description_${k + 1}_lr`] = p.lr; });
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null && v !== undefined && v !== ''));
}

export function buildPlan(lead, match, firm, mapping, idemKey) {
  const users = firm.users;
  const caseFile = {
    case_type_id: firm.caseFile.case_type_id,
    case_status_id: firm.caseFile.case_status_id,
    office_id: firm.caseFile.office_id,
    venue_id: firm.caseFile.venue_id_by_county[lead.county] ?? firm.caseFile.venue_id_by_county._default,
    attorney_user_id: users[lead.case.assigned_attorney],
    staff_user_id: lead.case.case_manager ? users[lead.case.case_manager] : null,
  };
  if (match.decision === 'link') caseFile.contact_id = match.contactId;
  const [first, ...rest] = lead.injuries;
  const steps = [];
  steps.push({ kind: 'case', models: { CaseFile: caseFile, ...(match.decision === 'link' ? {} : { Contact: contactFields(lead, mapping) }), Injury: injuryFields(first, firm) }, match: { first_name: lead.contact.first_name, last_name: lead.contact.last_name, date_of_birth: lead.contact.date_of_birth, injury: injuryFields(first, firm) } });
  if (match.decision === 'link') steps.push({ kind: 'contact-fill', contactId: match.contactId, fields: contactFields(lead, mapping) });
  for (const inj of rest) steps.push({ kind: 'injury', n: inj.n, fields: injuryFields(inj, firm) });
  if (lead.gaps.employer_name) steps.push({ kind: 'employer', name: lead.gaps.employer_name }, { kind: 'party', of: 'employer' });
  const marker = (what) => `[intake ${idemKey} ${what}]`;
  if (lead.gaps.referral_source) steps.push({ kind: 'activity', what: 'referral', typeId: firm.activityTypes.referral.id, text: `Referral source: ${lead.gaps.referral_source} ${marker('referral')}` });
  steps.push({ kind: 'activity', what: 'signed', typeId: firm.activityTypes.signed.id, date: `${lead.gaps.signed_date} 09:00:00`, text: `Retainer signed ${lead.gaps.signed_date} (from GoHighLevel) ${marker('signed')}` });
  steps.push({ kind: 'notes', typeId: firm.activityTypes.intakeNote.id, marker: marker('notes') });
  steps.push({ kind: 'ghl' });
  return steps.map((s, i) => ({ seq: i + 1, ...s }));
}

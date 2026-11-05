// Checks a lead before anything is written to MerusCase. A lead that fails is held with reasons
// (and tagged in GoHighLevel) instead of creating half a case.
export function validate(lead, firm, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const errs = [...lead.problems.map((p) => `${p.field}: ${p.problem}`)];
  const c = lead.contact;
  if (!c.first_name) errs.push('First name is missing');
  if (!c.last_name) errs.push('Last name is missing');
  if (!c.date_of_birth) errs.push('Date of birth is missing');
  else if (c.date_of_birth > today || c.date_of_birth < '1900-01-01') errs.push(`Date of birth ${c.date_of_birth} is not plausible`);
  if (!c.phone && !c.home_phone && !c.email) errs.push('No phone or email');
  if (!lead.injuries.length) errs.push('No injury on the lead');
  for (const i of lead.injuries) {
    const tag = `Injury ${i.n}`;
    if (!i.type) errs.push(`${tag}: type must be Specific or CT`);
    if (!i.date) errs.push(`${tag}: date of injury is missing`);
    else if (i.date > today) errs.push(`${tag}: date of injury ${i.date} is in the future`);
    if (i.type === 'CT') {
      if (!i.end_date) errs.push(`${tag}: CT injury needs an end date`);
      else if (i.date && i.end_date < i.date) errs.push(`${tag}: CT end date is before the start date`);
      else if (i.end_date > today) errs.push(`${tag}: CT end date ${i.end_date} is in the future`);
    }
    if (i.type === 'SPECIFIC' && i.end_date && i.end_date !== i.date) errs.push(`${tag}: a specific injury has one date, but an end date was given`);
    if (i.body_parts && i.body_parts.parts.length > 10) errs.push(`${tag}: ${i.body_parts.parts.length} body parts; MerusCase takes 10 per injury`);
  }
  const dup = lead.injuries.filter((a, k) => lead.injuries.some((b, j) => j < k && b.date === a.date && b.type === a.type));
  for (const d of dup) errs.push(`Injury ${d.n} repeats an earlier injury (same type and date)`);
  if (!lead.case.assigned_attorney) errs.push('Assigned attorney is missing');
  else if (!(lead.case.assigned_attorney in firm.users)) errs.push(`Assigned attorney "${lead.case.assigned_attorney}" has no MerusCase user ID in config/firm.json`);
  if (lead.case.case_manager && !(lead.case.case_manager in firm.users)) errs.push(`Case manager "${lead.case.case_manager}" has no MerusCase user ID`);
  if (!lead.gaps.signed_date) errs.push('Signed date is missing');
  else if (lead.gaps.signed_date > today) errs.push('Signed date is in the future');
  return errs;
}

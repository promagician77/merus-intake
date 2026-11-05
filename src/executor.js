// Runs one intake's plan against MerusCase with a step journal, so a crash or a lost response never
// creates a second case, injury, party or note. MerusCase takes no idempotency key, so every write
// whose outcome is unknown (timeout, 5xx after sending) is checked with a read before it is retried.
import { now } from './db.js';
import { MerusError } from './merus/client.js';
import { indexContact, findCompany } from './dedupe.js';
import { mdy } from './normalize.js';

const J = JSON.stringify; const P = (s) => (s == null ? null : JSON.parse(s));
const MAX_ATTEMPTS = 4;

export async function runIntake(ctx, intakeId) {
  const { db, merus, ghl } = ctx;
  const intake = db.prepare('SELECT * FROM intakes WHERE id = ?').get(intakeId);
  const lead = P(intake.lead); const match = P(intake.match);
  const out = P(intake.result) || { caseFileId: null, contactId: match?.decision === 'link' ? match.contactId : null, injuryIds: [], employerContactId: null, activityIds: [], notes: [] };
  const saveOut = () => db.prepare('UPDATE intakes SET result = ?, updated_at = ? WHERE id = ?').run(J(out), now(), intakeId);
  const steps = db.prepare('SELECT * FROM steps WHERE intake_id = ? ORDER BY seq').all(intakeId);
  db.prepare("UPDATE intakes SET status = 'running', updated_at = ? WHERE id = ?").run(now(), intakeId);

  for (const row of steps) {
    if (row.status === 'done' || row.status === 'skipped') continue;
    const step = P(row.request);
    for (;;) {
      const attempts = row.attempts + 1; row.attempts = attempts;
      // 'sent' means a previous run stopped after sending (crash); 'unknown' means no reply came back
      const needsCheck = row.status === 'unknown' || row.status === 'sent';
      const startedAt = needsCheck && row.started_at ? row.started_at : now();
      db.prepare("UPDATE steps SET status = 'sent', attempts = ?, started_at = ? WHERE intake_id = ? AND seq = ?").run(attempts, startedAt, intakeId, row.seq);
      row.started_at = startedAt;
      let checked = false;
      try {
        const prior = needsCheck ? await reconcile(ctx, step, out, lead, startedAt, intakeId) : null;
        checked = true;
        const res = prior ? { id: prior, note: 'found after a lost response; not sent again' } : await perform(ctx, step, out, lead, intake);
        db.prepare("UPDATE steps SET status = ?, result_id = ?, finished_at = ?, note = ? WHERE intake_id = ? AND seq = ?").run(res.skipped ? 'skipped' : 'done', res.id == null ? null : String(res.id), now(), res.note || null, intakeId, row.seq);
        row.status = 'done';
        saveOut();
        break;
      } catch (e) {
        const outcome = needsCheck && !checked ? 'unknown' : e instanceof MerusError ? e.outcome : 'unknown';
        if ((outcome === 'unknown' || outcome === 'failed') && attempts < MAX_ATTEMPTS) {
          row.status = outcome === 'unknown' ? 'unknown' : 'pending';
          db.prepare('UPDATE steps SET status = ?, note = ? WHERE intake_id = ? AND seq = ?').run(row.status, e.message, intakeId, row.seq);
          await ctx.sleep(ctx.retryDelayMs ?? 1000);
          continue;
        }
        db.prepare("UPDATE steps SET status = 'failed', note = ? WHERE intake_id = ? AND seq = ?").run(e.message, intakeId, row.seq);
        db.prepare("UPDATE intakes SET status = 'failed', errors = ?, updated_at = ? WHERE id = ?").run(J([`step ${row.seq} (${step.kind}): ${e.message}`]), now(), intakeId);
        saveOut();
        return { status: 'failed', error: e.message, result: out };
      }
    }
  }
  db.prepare("UPDATE intakes SET status = 'done', updated_at = ? WHERE id = ?").run(now(), intakeId);
  return { status: 'done', result: out };
}

async function perform(ctx, step, out, lead, intake) {
  const { merus, db, firm } = ctx;
  switch (step.kind) {
    case 'case': {
      const r = await merus.caseFilesAdd(step.models);
      if (!r.caseFileId) throw new MerusError('caseFiles/add returned no case file ID', { outcome: 'unknown' });
      out.caseFileId = r.caseFileId; out.contactId = out.contactId ?? r.contactId; if (r.injuryId) out.injuryIds.push(r.injuryId);
      if (!out.contactId) out.contactId = await applicantFromParties(ctx, r.caseFileId, step.match);
      if (step.models.Contact && out.contactId) indexContact(db, { id: out.contactId, first_name: lead.contact.first_name, last_name: lead.contact.last_name, date_of_birth: lead.contact.date_of_birth, email: lead.contact.email, phones: [lead.contact.phone, lead.contact.home_phone] }, 'bridge');
      return { id: r.caseFileId };
    }
    case 'contact-fill': {
      const cur = await merus.contactView(step.contactId);
      const blanks = {}; const differs = [];
      for (const [k, v] of Object.entries(step.fields)) {
        const have = cur?.[k];
        if (have == null || have === '') blanks[k] = v;
        else if (String(have).trim().toLowerCase() !== String(v).trim().toLowerCase()) differs.push(`${k}: MerusCase "${have}", GoHighLevel "${v}"`);
      }
      if (differs.length && !out.notes.some((n) => n.startsWith(`Existing contact ${step.contactId}`))) out.notes.push(`Existing contact ${step.contactId} kept as is; GoHighLevel had different values -> ${differs.join('; ')}`);
      if (!Object.keys(blanks).length) return { skipped: true, note: 'nothing blank to fill' };
      await merus.contactsEdit(step.contactId, blanks);
      return { id: step.contactId, note: `filled ${Object.keys(blanks).join(', ')}` };
    }
    case 'injury': {
      const id = await merus.injuriesAdd(out.caseFileId, step.fields);
      out.injuryIds.push(id); return { id };
    }
    case 'employer': {
      const found = findCompany(db, step.name);
      if (found) { out.employerContactId = found; return { id: found, note: 'existing employer contact' }; }
      const id = await merus.contactsAdd({ company_name: step.name, is_company: 1 });
      indexContact(db, { id, company: step.name }, 'bridge');
      out.employerContactId = id; return { id, note: 'new employer contact' };
    }
    case 'party': {
      const id = await merus.partiesAdd(out.employerContactId, out.caseFileId);
      return { id };
    }
    case 'activity': {
      const id = await merus.activitiesAdd({ case_file_id: out.caseFileId, activity_type_id: [step.typeId], activity: step.text, date: step.date });
      out.activityIds.push(id); return { id };
    }
    case 'notes': {
      if (!out.notes.length) return { skipped: true };
      const id = await merus.activitiesAdd({ case_file_id: out.caseFileId, activity_type_id: [step.typeId], activity: `${out.notes.join('\n')} ${step.marker}` });
      out.activityIds.push(id); return { id };
    }
    case 'ghl': {
      const cid = intake.ghl_contact_id;
      if (!cid || !ctx.ghl) return { skipped: true };
      await ctx.ghl.addTags(cid, [firm.ghlWriteBack.tagCreated]);
      await ctx.ghl.addNote(cid, `MerusCase case ${out.caseFileId} created (contact ${out.contactId}${out.injuryIds.length > 1 ? `, ${out.injuryIds.length} injuries` : ''}).`);
      return { id: cid };
    }
    default: throw new Error(`unknown step ${step.kind}`);
  }
}

async function applicantFromParties(ctx, caseFileId, who) {
  for (const p of await ctx.merus.partiesView(caseFileId)) {
    const c = await ctx.merus.contactView(p.contact_id);
    if (samePerson(c, who)) return Number(p.contact_id);
  }
  return null;
}
const samePerson = (c, who) => c && String(c.first_name).toLowerCase() === String(who.first_name).toLowerCase() && String(c.last_name).toLowerCase() === String(who.last_name).toLowerCase() && (!c.birth_date || c.birth_date === mdy(who.date_of_birth));

/** After a lost response: did MerusCase save it anyway? Returns the record's ID or null. */
async function reconcile(ctx, step, out, lead, startedAt, intakeId) {
  const { merus, db } = ctx;
  const claimed = new Set(db.prepare("SELECT result_id FROM steps WHERE kind = 'case' AND result_id IS NOT NULL AND intake_id != ?").all(intakeId).map((r) => Number(r.result_id)));
  switch (step.kind) {
    case 'case': {
      // MerusCase's clock and time zone are not documented, so look back a full day; the injury and
      // contact checks below, and cases already claimed by other intakes, keep the wider window safe
      const since = new Date(Date.parse(startedAt) - 86400000).toISOString().slice(0, 10) + ' 00:00:00';
      for (const cf of await merus.caseFilesIndex({ 'modified[gte]': since })) {
        const id = Number(cf.id);
        if (claimed.has(id)) continue;
        const injuries = await merus.injuriesView(id);
        if (!injuries.some((i) => i.date_of_injury === step.models.Injury.date_of_injury && Number(i.injury_type_id) === Number(step.models.Injury.injury_type_id))) continue;
        const parties = await merus.partiesView(id);
        let contactId = null;
        if (step.models.CaseFile.contact_id) { if (parties.some((p) => Number(p.contact_id) === Number(step.models.CaseFile.contact_id))) contactId = Number(step.models.CaseFile.contact_id); }
        else for (const p of parties) { const c = await merus.contactView(p.contact_id); if (samePerson(c, step.match)) { contactId = Number(p.contact_id); break; } }
        if (!contactId) continue;
        out.caseFileId = id; out.contactId = out.contactId ?? contactId;
        const inj = injuries.find((i) => i.date_of_injury === step.models.Injury.date_of_injury); if (inj && !out.injuryIds.includes(Number(inj.id))) out.injuryIds.push(Number(inj.id));
        if (step.models.Contact) indexContact(db, { id: contactId, first_name: lead.contact.first_name, last_name: lead.contact.last_name, date_of_birth: lead.contact.date_of_birth, email: lead.contact.email, phones: [lead.contact.phone, lead.contact.home_phone] }, 'bridge');
        return id;
      }
      return null;
    }
    case 'injury': {
      const hit = (await merus.injuriesView(out.caseFileId)).find((i) => i.date_of_injury === step.fields.date_of_injury && Number(i.injury_type_id) === Number(step.fields.injury_type_id) && !out.injuryIds.includes(Number(i.id)));
      if (hit) { out.injuryIds.push(Number(hit.id)); return Number(hit.id); }
      return null;
    }
    case 'party': {
      const hit = (await merus.partiesView(out.caseFileId)).find((p) => Number(p.contact_id) === Number(out.employerContactId));
      return hit ? Number(hit.id ?? hit.contact_id) : null;
    }
    case 'activity': case 'notes': {
      const mark = step.kind === 'notes' ? step.marker : step.text.match(/\[intake [^\]]+\]/)[0];
      const hit = (await merus.activitiesIndex(out.caseFileId)).find((a) => String(a.activity || '').includes(mark));
      if (hit) { out.activityIds.push(Number(hit.id)); return Number(hit.id); }
      return null;
    }
    default: return null; // contacts/edit is safe to repeat; employer contacts/add cannot be read back (see README)
  }
}

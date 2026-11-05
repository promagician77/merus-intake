// Intake lifecycle: received -> held (fails checks) | review (possible duplicate) | queued -> running -> done | failed
import { now, tx } from './db.js';
import { toLead } from './mapping.js';
import { validate } from './validate.js';
import { findPerson } from './dedupe.js';
import { buildPlan } from './plan.js';
import { runIntake } from './executor.js';

const J = JSON.stringify; const P = (s) => (s == null ? null : JSON.parse(s));

export function idemKeyOf(lead) {
  if (lead.source.opportunityId) return `opp:${lead.source.opportunityId}`;
  if (lead.source.contactId) return `contact:${lead.source.contactId}:${lead.gaps.signed_date || 'unsigned'}`;
  return null;
}

/** Store a webhook delivery. Returns { intakeId, duplicate, ignored } quickly; work happens in process(). */
export function receive(ctx, body) {
  const { db, mapping, firm, bodyDict } = ctx;
  const lead = toLead(body, mapping, { bodyDict, maxInjuries: firm.maxInjuries });
  const stage = lead.source.stage;
  if (stage && stage.trim().toLowerCase() !== firm.signedStage.stage.toLowerCase()) return { ignored: `stage "${stage}" is not "${firm.signedStage.stage}"` };
  const key = idemKeyOf(lead);
  if (!key) return { rejected: 'no contact or opportunity ID in the body' };
  return tx(db, () => {
    const prev = db.prepare('SELECT id, status FROM intakes WHERE idem_key = ?').get(key);
    if (prev && prev.status === 'held') {
      // fixed in GoHighLevel and sent again: replace the stored lead and check it again
      db.prepare("UPDATE intakes SET deliveries = deliveries + 1, body = ?, lead = ?, errors = NULL, status = 'received', updated_at = ? WHERE id = ?").run(J(body), J(lead), now(), prev.id);
      return { intakeId: prev.id, duplicate: true, requeued: true, status: 'received' };
    }
    if (prev) { db.prepare('UPDATE intakes SET deliveries = deliveries + 1, updated_at = ? WHERE id = ?').run(now(), prev.id); return { intakeId: prev.id, duplicate: true, status: prev.status }; }
    const r = db.prepare("INSERT INTO intakes(idem_key, ghl_contact_id, status, received_at, updated_at, body, lead) VALUES (?, ?, 'received', ?, ?, ?, ?)").run(key, lead.source.contactId, now(), now(), J(body), J(lead));
    return { intakeId: Number(r.lastInsertRowid), duplicate: false, status: 'received' };
  });
}

export async function process(ctx, intakeId, { resolve } = {}) {
  const { db, firm, mapping } = ctx;
  const it = db.prepare('SELECT * FROM intakes WHERE id = ?').get(intakeId);
  if (['done', 'running'].includes(it.status)) return { status: it.status };
  const lead = P(it.lead);
  if (!it.plan) {
    const errs = validate(lead, firm, { today: ctx.today?.() });
    if (errs.length) { setStatus(db, intakeId, 'held', { errors: errs }); await tellGhl(ctx, it, firm.ghlWriteBack.tagHeld, `Not sent to MerusCase:\n- ${errs.join('\n- ')}`); return { status: 'held', errors: errs }; }
    let match = findPerson(db, { first_name: lead.contact.first_name, last_name: lead.contact.last_name, date_of_birth: lead.contact.date_of_birth, email: lead.contact.email, phones: [lead.contact.phone, lead.contact.home_phone] });
    if (resolve) match = resolve.decision === 'link' ? { decision: 'link', contactId: resolve.contactId, reason: 'chosen by staff' } : { decision: 'new', reason: 'staff confirmed a new contact' };
    if (match.decision === 'review') {
      setStatus(db, intakeId, 'review', { match });
      await tellGhl(ctx, it, firm.ghlWriteBack.tagHeld, `Possible existing MerusCase client (${match.reason}). Candidates: ${match.candidates.map((c) => `#${c.contactId} ${c.name}`).join(', ')}. Resolve in the bridge.`);
      return { status: 'review', match };
    }
    const steps = buildPlan(lead, match, firm, mapping, it.idem_key);
    tx(db, () => {
      db.prepare("UPDATE intakes SET match = ?, plan = ?, status = 'queued', updated_at = ? WHERE id = ?").run(J(match), J(steps), now(), intakeId);
      for (const s of steps) db.prepare("INSERT INTO steps(intake_id, seq, kind, status, request) VALUES (?, ?, ?, 'pending', ?)").run(intakeId, s.seq, s.kind, J(s));
    });
  }
  return runIntake(ctx, intakeId);
}

function setStatus(db, id, status, { errors, match } = {}) {
  db.prepare('UPDATE intakes SET status = ?, errors = COALESCE(?, errors), match = COALESCE(?, match), updated_at = ? WHERE id = ?').run(status, errors ? J(errors) : null, match ? J(match) : null, now(), id);
}
async function tellGhl(ctx, it, tag, note) {
  if (!ctx.ghl || !it.ghl_contact_id) return;
  try { await ctx.ghl.addTags(it.ghl_contact_id, [tag]); await ctx.ghl.addNote(it.ghl_contact_id, note); } catch (e) { ctx.log?.({ ghlWriteBackFailed: e.message }); }
}

/** Staff decision on a review: link to an existing contact or confirm a new one, then run. */
export function resolveReview(ctx, intakeId, decision) {
  const it = ctx.db.prepare('SELECT status FROM intakes WHERE id = ?').get(intakeId);
  if (!it || it.status !== 'review') throw new Error('intake is not waiting for review');
  return process(ctx, intakeId, { resolve: decision });
}

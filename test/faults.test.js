// Lost responses, crashes and refusals: nothing in MerusCase is ever created twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, census } from './helpers/env.js';
import { rng, ghlBody, newPerson } from '../bench/synth.js';
import { runIntake } from '../src/executor.js';
import { receive, process as processIntake } from '../src/intake.js';

const run = async (E, body) => { const r = await E.post(body); const j = await r.json(); await E.server.drain(); return j; };
const steps = async (E, id) => (await (await E.admin(`/intakes/${id}`)).json()).steps;
const clean = (c) => { assert.equal(c.duplicateInjuries, 0, 'duplicate injury'); assert.equal(c.duplicateParties, 0, 'duplicate party'); assert.equal(c.duplicateActivities, 0, 'duplicate activity'); };

for (const [path, label] of [['caseFiles/add', 'case'], ['injuries/edit', 'injury'], ['parties/add', 'employer party'], ['activities/add', 'activity']]) {
  test(`MerusCase saves the ${label} but the reply is lost (500 after saving): found by a read, not sent again`, async () => {
    const E = await env(); const r = rng(20);
    try {
      E.M.st.faults.push({ method: 'POST', path, mode: 'after', times: 1 });
      const res = await run(E, ghlBody(newPerson(r, []), r, { id: 1, injuries: 2 }));
      const st = await steps(E, res.intakeId);
      const c = census(E.M.store);
      assert.deepEqual([c.cases, c.injuries, c.parties, c.activities], [1, 2, 2, 2]); clean(c);
      assert.ok(st.some((s) => /found after a lost response/.test(s.note || '')), 'reconciled by reading back');
    } finally { await E.close(); }
  });
}

test('the connection drops after caseFiles/add is saved: still one case', async () => {
  const E = await env(); const r = rng(21);
  try {
    E.M.st.faults.push({ method: 'POST', path: 'caseFiles/add', mode: 'drop-after', times: 1 });
    await run(E, ghlBody(newPerson(r, []), r, { id: 1 }));
    assert.equal(census(E.M.store).cases, 1);
  } finally { await E.close(); }
});

test('a 500 before saving is simply retried', async () => {
  const E = await env(); const r = rng(22);
  try {
    E.M.st.faults.push({ method: 'POST', path: 'injuries/edit', mode: 'before', times: 2 });
    const res = await run(E, ghlBody(newPerson(r, []), r, { id: 1, injuries: 3 }));
    const c = census(E.M.store);
    assert.equal(c.injuries, 3); clean(c);
    assert.equal((await steps(E, res.intakeId)).find((s) => s.kind === 'injury').attempts, 3);
  } finally { await E.close(); }
});

test('429 rate limit: waits and carries on', async () => {
  const E = await env(); const r = rng(23);
  try {
    E.M.st.faults.push({ method: 'POST', path: 'caseFiles/add', mode: '429', retryAfter: 2, times: 1 });
    await run(E, ghlBody(newPerson(r, []), r, { id: 1 }));
    assert.equal(census(E.M.store).cases, 1);
  } finally { await E.close(); }
});

test('the bridge dies right after MerusCase saved injury 3 (journal says "sent"): on restart it reads back instead of resending', async () => {
  const E = await env(); const r = rng(24);
  try {
    // first process: the third injury is saved, then the process never hears back (killed)
    let n = 0;
    const dying = { ...E.ctx, merus: { ...E.ctx.merus, injuriesAdd: async (...a) => { const id = await E.ctx.merus.injuriesAdd(...a); if (++n === 2) await new Promise(() => {}); return id; } } };
    const { intakeId } = receive(dying, ghlBody(newPerson(r, []), r, { id: 1, injuries: 3 }));
    processIntake(dying, intakeId);
    for (let i = 0; i < 200 && E.M.store.injuries.length < 3; i++) await new Promise((res) => setTimeout(res, 10));
    const journal = E.ctx.db.prepare("SELECT status FROM steps WHERE intake_id = ? AND seq = 3").get(intakeId).status;
    assert.equal(journal, 'sent');
    // restart: a fresh run over the same journal
    const out = await runIntake(E.ctx, intakeId);
    assert.equal(out.status, 'done');
    const c = census(E.M.store);
    assert.deepEqual([c.cases, c.injuries, c.activities], [1, 3, 2]); clean(c);
    assert.match(E.ctx.db.prepare("SELECT note FROM steps WHERE intake_id = ? AND seq = 3").get(intakeId).note, /found after a lost response/);
  } finally { await E.close(); }
});

test('MerusCase refuses a step (400): the intake fails with the step named, and Retry resumes where it stopped', async () => {
  const E = await env(); const r = rng(25);
  try {
    E.M.st.faults.push({ method: 'POST', path: 'parties/add', mode: 'before', times: 10 });
    const res = await run(E, ghlBody(newPerson(r, []), r, { id: 1, injuries: 2 }));
    let detail = await (await E.admin(`/intakes/${res.intakeId}`)).json();
    assert.equal(detail.intake.status, 'failed'); assert.match(detail.intake.errors, /step 4 \(party\)/);
    E.M.st.faults.length = 0;
    await E.admin(`/intakes/${res.intakeId}/retry`, { method: 'POST' }); await E.server.drain();
    detail = await (await E.admin(`/intakes/${res.intakeId}`)).json();
    assert.equal(detail.intake.status, 'done');
    const c = census(E.M.store);
    assert.deepEqual([c.cases, c.injuries], [1, 2]); clean(c);
  } finally { await E.close(); }
});

test('caseFiles/add with two injuries is refused by MerusCase - the bridge never sends more than one', async () => {
  const E = await env();
  try {
    const res = await fetch(new URL('caseFiles/add', E.M.url), { method: 'POST', headers: { authorization: `Bearer ${E.M.token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'data[Contact][last_name]=X&data[Injury][date_of_injury]=01/01/2025&data[Injury][date_of_injury]=02/01/2025&data[Injury][injury_type_id]=2' });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(E.M.st.log), /caseFiles/);
  } finally { await E.close(); }
});

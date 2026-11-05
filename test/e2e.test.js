// Webhook in, MerusCase records out, against the fake MerusCase and a fake GoHighLevel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, census } from './helpers/env.js';
import { rng, ghlBody, newPerson } from '../bench/synth.js';
import { indexContact } from '../src/dedupe.js';

const run = async (E, body) => { const r = await E.post(body); const j = await r.json(); await E.server.drain(); return { http: r.status, ...j }; };
const intake = async (E, id) => (await E.admin(`/intakes/${id}`)).json();

test('webhook auth: Bearer token or ?key=; anything else is 401', async () => {
  const E = await env();
  try {
    assert.equal((await E.post({}, { token: 'wrong' })).status, 401);
    assert.equal((await E.post({}, { token: null })).status, 401);
    assert.equal((await E.post({ contact_id: 'x', pipeline_stage: 'New' }, { token: null, query: '?key=hook-secret' })).status, 200);
  } finally { await E.close(); }
});

test('webhook hygiene: other stages ignored, bad JSON 400, oversized body 413, no IDs 422', async () => {
  const E = await env();
  try {
    assert.deepEqual(await (await E.post({ contact_id: 'x', pipeline_stage: 'Consult booked' })).json(), { ignored: 'stage "Consult booked" is not "Signed"' });
    assert.equal((await E.post('{not json')).status, 400);
    assert.equal((await E.post(JSON.stringify({ pad: 'x'.repeat(300 * 1024) }))).status, 413);
    assert.equal((await E.post({ pipeline_stage: 'Signed', first_name: 'A' })).status, 422);
  } finally { await E.close(); }
});

test('a new client with three injuries: one caseFiles/add, then injuries/edit twice, employer party, two activities', async () => {
  const E = await env(); const r = rng(5);
  try {
    const res = await run(E, ghlBody(newPerson(r, []), r, { id: 1, injuries: 3 }));
    assert.equal(res.http, 202);
    const { intake: it, steps } = await intake(E, res.intakeId);
    assert.equal(it.status, 'done');
    assert.deepEqual(steps.map((s) => s.kind), ['case', 'injury', 'injury', 'employer', 'party', 'activity', 'activity', 'notes', 'ghl']);
    const c = census(E.M.store);
    assert.deepEqual([c.cases, c.injuries, c.parties, c.activities], [1, 3, 2, 2]);
    assert.equal(E.M.st.calls['POST caseFiles/add'], 1); assert.equal(E.M.st.calls['POST injuries/edit'], 2);
    const signed = E.M.store.activities.find((a) => /Retainer signed/.test(a.activity));
    assert.equal(signed.date, '2026-10-20 09:00:00');
    assert.match(E.G.st.notes[0].body, /MerusCase case \d+ created .*3 injuries/);
    assert.deepEqual(E.G.st.tags[0].tags, ['merus-case-created']);
  } finally { await E.close(); }
});

test('the same webhook delivered again, or the lead re-entering Signed, never makes a second case', async () => {
  const E = await env(); const r = rng(6);
  try {
    const body = ghlBody(newPerson(r, []), r, { id: 2, injuries: 2 });
    await run(E, body); const again = await run(E, body); await run(E, body);
    assert.equal(again.duplicate, true);
    assert.equal(census(E.M.store).cases, 1);
    const { intake: it } = await intake(E, again.intakeId);
    assert.equal(it.deliveries, 3);
  } finally { await E.close(); }
});

test('an existing client: caseFiles/add gets the contact ID; only blank fields are filled; differences become a case note', async () => {
  const E = await env(); const r = rng(7);
  try {
    const id = E.M.store.addContact({ first_name: 'Guadalupe', last_name: 'Nuñez', birth_date: '05/06/1979', cell_phone: '4155550199', email: '' , city: 'Novato' });
    indexContact(E.ctx.db, { id, first_name: 'Guadalupe', last_name: 'Nuñez', date_of_birth: '1979-05-06', phones: ['4155550199'] });
    const res = await run(E, ghlBody({ first: 'Lupe', last: 'Nunez', dob: '1979-05-06', phone: '415-555-0199', email: 'lupe@example.com' }, r, { id: 3, overrides: { city: 'San Rafael' } }));
    const { intake: it, steps } = await intake(E, res.intakeId);
    assert.equal(JSON.parse(it.match).decision, 'link');
    assert.equal(census(E.M.store).contacts, 1 + 1, 'no second person contact (one employer contact added)');
    assert.equal(E.M.store.contacts.get(id).email, 'lupe@example.com', 'blank email filled');
    assert.equal(E.M.store.contacts.get(id).city, 'Novato', 'existing city kept');
    assert.match(E.M.store.activities.find((a) => /kept as is/.test(a.activity)).activity, /city: MerusCase "Novato", GoHighLevel "San Rafael"/);
    assert.equal(steps.find((s) => s.kind === 'contact-fill').status, 'done');
  } finally { await E.close(); }
});

test('a lead that fails the checks is held, tagged in GoHighLevel, and runs once fixed and sent again', async () => {
  const E = await env(); const r = rng(8);
  try {
    const p = newPerson(r, []);
    const body = ghlBody(p, r, { id: 4, overrides: { injury_1_type: 'CT', injury_1_end_date: '' } });
    const first = await run(E, body);
    const it1 = (await intake(E, first.intakeId)).intake;
    assert.equal(it1.status, 'held'); assert.match(it1.errors, /CT injury needs an end date/);
    assert.equal(census(E.M.store).cases, 0);
    assert.deepEqual(E.G.st.tags[0].tags, ['merus-needs-review']);
    const fixed = await run(E, { ...body, injury_1_end_date: '2025-08-31' });
    assert.equal(fixed.requeued, true);
    assert.equal((await intake(E, first.intakeId)).intake.status, 'done');
    assert.equal(census(E.M.store).cases, 1);
  } finally { await E.close(); }
});

test('a possible duplicate waits for staff; resolving it links the chosen contact', async () => {
  const E = await env(); const r = rng(9);
  try {
    const id = E.M.store.addContact({ first_name: 'Maria', last_name: 'Garcia', birth_date: '01/02/1970', cell_phone: '4155550123' });
    indexContact(E.ctx.db, { id, first_name: 'Maria', last_name: 'Garcia', date_of_birth: '1970-01-02', phones: ['4155550123'] });
    const res = await run(E, ghlBody({ first: 'Ana', last: 'Garcia', dob: '1994-03-03', phone: '4155550123', email: null }, r, { id: 5 }));
    const it = (await intake(E, res.intakeId)).intake;
    assert.equal(it.status, 'review');
    assert.match(JSON.parse(it.match).reason, /phone on file for someone with a different date of birth/);
    assert.equal(census(E.M.store).cases, 0);
    const out = await (await E.admin(`/intakes/${res.intakeId}/resolve`, { method: 'POST', body: JSON.stringify({ decision: 'new' }) })).json();
    assert.equal(out.status, 'done');
    assert.equal(census(E.M.store).cases, 1);
  } finally { await E.close(); }
});

test('admin endpoints need the admin token', async () => {
  const E = await env();
  try { assert.equal((await fetch(`${E.base}/intakes`)).status, 401); assert.equal((await E.admin('/intakes')).status, 200); } finally { await E.close(); }
});

test('a contact created by one intake is found by the next one, even before the index refresh', async () => {
  const E = await env(); const r = rng(10);
  try {
    const p = newPerson(r, []);
    await run(E, ghlBody(p, r, { id: 6, signed: '2026-10-01' }));
    const second = await run(E, ghlBody(p, r, { id: 6, signed: '2026-10-28' }));
    const it = (await intake(E, second.intakeId)).intake;
    assert.equal(JSON.parse(it.match).decision, 'link');
    const c = census(E.M.store);
    assert.equal(c.cases, 2); assert.equal([...E.M.store.contacts.values()].filter((x) => x.last_name).length, 1);
  } finally { await E.close(); }
});

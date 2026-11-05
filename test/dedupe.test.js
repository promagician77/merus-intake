import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { indexContact, findPerson, findCompany } from '../src/dedupe.js';
import { evalDedupe } from '../bench/dedupe-eval.js';

let db;
before(() => {
  db = openDb(':memory:');
  indexContact(db, { id: 1, first_name: 'José', last_name: 'García-López', date_of_birth: '1975-04-12', phones: ['(415) 555-0100'], email: 'jgl@example.com' });
  indexContact(db, { id: 2, first_name: 'Jose', last_name: 'Garcia', date_of_birth: '1988-09-30', phones: ['4155550101'] });
  indexContact(db, { id: 3, first_name: 'Robert', last_name: 'Smith', date_of_birth: '1961-01-01', phones: ['4155550102'] });
  indexContact(db, { id: 4, first_name: 'Robert', last_name: 'Smith Jr.', date_of_birth: '1989-01-01', phones: ['4155550102'] });
  indexContact(db, { id: 50, company: 'North Bay Builders, Inc.' });
});
const find = (p) => findPerson(db, p);

test('nickname, no accents, hyphen dropped, same DOB: links', () => {
  const m = find({ first_name: 'Pepe', last_name: 'Garcia Lopez', date_of_birth: '1975-04-12', phones: [] });
  assert.deepEqual([m.decision, m.contactId], ['link', 1]);
});

test('same name, different DOB, nothing shared: a different person, so a new contact', () => {
  assert.equal(find({ first_name: 'Jose', last_name: 'Garcia', date_of_birth: '1999-02-02', phones: ['4155559999'] }).decision, 'new');
});

test('Sr. and Jr. share a phone: the son is never linked to the father', () => {
  const m = find({ first_name: 'Robert', last_name: 'Smith', date_of_birth: '1989-01-01', phones: ['415-555-0102'] });
  assert.deepEqual([m.decision, m.contactId], ['link', 4]);
  const n = find({ first_name: 'Bobby', last_name: 'Smith', date_of_birth: '1995-05-05', phones: ['4155550102'] });
  assert.equal(n.decision, 'review');
});

test('a name alone never links: no DOB and no phone or email goes to review', () => {
  assert.equal(find({ first_name: 'Robert', last_name: 'Smith', phones: [] }).decision, 'review');
});

test('first and last name typed the wrong way round: links', () => {
  const m = find({ first_name: 'Smith', last_name: 'Robert', date_of_birth: '1961-01-01', phones: [] });
  assert.deepEqual([m.decision, m.contactId], ['link', 3]);
});

test('employers: one contact per company however the name is written', () => {
  assert.equal(findCompany(db, 'North Bay Builders Inc'), 50);
  assert.equal(findCompany(db, 'NORTH BAY BUILDERS, INC.'), 50);
  assert.equal(findCompany(db, 'North Bay Plumbing'), null);
});

test('synthetic file of 600 clients, 80 leads: no wrong links; returning clients mostly linked; lookalikes never linked', async () => {
  const r = await evalDedupe({ existing: 600, returning: 40, fresh: 30, negatives: 12, seed: 5 });
  assert.equal(r.wrongLinks, 0);
  assert.ok((r.returning['linked-correct'] || 0) >= 36, JSON.stringify(r.returning));
  assert.ok(!r.lookalike['linked-correct'] && !r.lookalike['linked-wrong']);
  assert.ok((r.fresh.new || 0) >= 28);
});

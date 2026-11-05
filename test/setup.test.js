// Go-live checks: firm IDs against the API, and the contact index built through the published endpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from './helpers/env.js';
import { checkConfig } from '../src/checkConfig.js';
import { buildIndex } from '../src/indexer.js';
import { meta } from '../src/db.js';
import { makeStore } from '../fake/merus.js';
import { rng, existingPeople, seedStore } from '../bench/synth.js';

test('check-config: users, case type and activity types verified; statuses, venues, offices listed for a manual check', async () => {
  const E = await env();
  try {
    const r = await checkConfig(E.ctx);
    assert.equal(r.missing.length, 0, r.missing.join('; '));
    assert.equal(r.ok.length, 6);
    assert.ok(r.manual.some((m) => /venue Marin/.test(m)));
  } finally { await E.close(); }
});

test('check-config: a wrong user ID is reported; --create adds missing activity types', async () => {
  const E = await env();
  try {
    E.ctx.firm.users['New Associate'] = 777;
    E.M.store.activityTypes = E.M.store.activityTypes.filter((t) => t.id !== 9002);
    const r = await checkConfig(E.ctx, { create: true });
    assert.ok(r.missing.some((m) => /New Associate/.test(m)));
    assert.match(r.created[0], /Retainer signed/);
  } finally { await E.close(); }
});

test('index build: 300 cases -> every applicant and employer indexed, through published endpoints only', async () => {
  const store = makeStore(); const r = rng(2); seedStore(store, existingPeople(300, r), r);
  const E = await env({ store });
  try {
    const out = await buildIndex(E.ctx);
    assert.equal(out.cases, 300); assert.equal(out.contacts, 315);
    assert.deepEqual(Object.keys(E.M.st.calls).sort(), ['GET caseFiles/index', 'GET contacts/view/:id', 'GET parties/view/:id']);
    assert.ok(meta.get(E.ctx.db, 'index_built_at'));
  } finally { await E.close(); }
});

test('index refresh: only cases modified since the last build are read', async () => {
  const store = makeStore(); const r = rng(3); seedStore(store, existingPeople(200, r), r);
  const E = await env({ store });
  try {
    await buildIndex(E.ctx);
    const id = store.addContact({ first_name: 'Teresa', last_name: 'Moreno', birth_date: '07/08/1990', cell_phone: '4155550777' });
    const caseId = store.addCase({ case_type_id: 10001 }, new Date(Date.now() + 60000)); store.addParty(id, caseId);
    const calls = E.ctx.merus.calls;
    const out = await buildIndex(E.ctx, { since: meta.get(E.ctx.db, 'index_built_at') });
    assert.equal(out.cases, 1); assert.ok(E.ctx.merus.calls - calls <= 3);
    assert.ok(E.ctx.db.prepare('SELECT 1 FROM contacts_index WHERE contact_id = ?').get(id));
  } finally { await E.close(); }
});

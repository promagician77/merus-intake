// Runs the measured scenarios once and writes results/measurements.json (the page and PDF read only that).
import { readFile, writeFile } from 'node:fs/promises';
import { env, census, mapping } from '../test/helpers/env.js';
import { evalDedupe } from './dedupe-eval.js';
import { buildIndex } from '../src/indexer.js';
import { makeStore } from '../fake/merus.js';
import { rng, existingPeople, seedStore, ghlBody, newPerson, returningVariant, hardNegative } from './synth.js';

const R = new URL('../', import.meta.url).pathname;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

// 1. dedupe accuracy, 3,000 synthetic clients, 300 leads
const dedupe = await evalDedupe({ existing: 3000, returning: 120, fresh: 150, negatives: 30, seed: 11 });

// 2. a day of intake through the HTTP endpoint, with faults
const r = rng(31);
const store = makeStore(); const people = existingPeople(3000, r); seedStore(store, people, r);
const E = await env({ store });
const index = await buildIndex(E.ctx);
const bodies = [];
let id = 100;
const add = (kind, body) => bodies.push({ kind, body });
for (let k = 0; k < 20; k++) add('new, 1 injury', ghlBody(newPerson(r, people), r, { id: ++id, injuries: 1 }));
for (let k = 0; k < 6; k++) add('new, 2 injuries', ghlBody(newPerson(r, people), r, { id: ++id, injuries: 2 }));
for (let k = 0; k < 3; k++) add('new, 3 injuries', ghlBody(newPerson(r, people), r, { id: ++id, injuries: 3 }));
for (let k = 0; k < 5; k++) { const p = people[Math.floor(r() * people.length)]; add('returning client', ghlBody(returningVariant(p, [1, 3, 6, 9, 10][k], r), r, { id: ++id })); }
add('held: CT without end date', ghlBody(newPerson(r, people), r, { id: ++id, overrides: { injury_1_type: 'CT', injury_1_end_date: '' } }));
add('held: unknown body part', ghlBody(newPerson(r, people), r, { id: ++id, overrides: { injury_1_body_parts: 'left knee, spleen' } }));
add('held: attorney not mapped', ghlBody(newPerson(r, people), r, { id: ++id, attorney: 'Associate (new hire)' }));
for (let k = 0; k < 2; k++) add('review: shares a phone', ghlBody(hardNegative(r, people, 1 + k * 3), r, { id: ++id }));
add('ignored: other stage', { ...ghlBody(newPerson(r, people), r, { id: ++id }), pipeline_stage: 'Consult booked' });
const resend = bodies.filter((b) => b.kind.startsWith('new')).slice(0, 10).map((b) => ({ kind: 'redelivery', body: b.body }));

const faults = [
  { method: 'POST', path: 'caseFiles/add', mode: 'after', times: 3 }, { method: 'POST', path: 'injuries/edit', mode: 'after', times: 2 },
  { method: 'POST', path: 'parties/add', mode: 'after', times: 2 }, { method: 'POST', path: 'activities/add', mode: 'after', times: 2 },
  { method: 'POST', path: 'caseFiles/add', mode: 'drop-after', times: 1 }, { method: 'POST', path: 'injuries/edit', mode: 'before', times: 2 },
  { method: 'POST', path: 'activities/add', mode: '429', retryAfter: 1, times: 2 },
];
E.M.st.faults.push(...faults.map((f) => ({ ...f })));
const plannedFaults = faults.reduce((s, f) => s + f.times, 0);
const callsBefore = { ...E.M.st.calls };
const acks = []; const t0 = Date.now();
for (const b of [...bodies, ...resend]) { const s = performance.now(); const res = await E.post(b.body); await res.json(); acks.push(performance.now() - s); }
await E.server.drain();
const elapsed = Date.now() - t0;
const intakes = E.ctx.db.prepare('SELECT id, status, deliveries, result, match, errors FROM intakes ORDER BY id').all();
const kinds = bodies.filter((b) => !b.kind.startsWith('ignored')).map((b) => b.kind);
const outcomes = intakes.map((i, k) => ({ kind: kinds[k], status: i.status, reason: i.status === 'review' ? JSON.parse(i.match).reason : i.status === 'held' ? JSON.parse(i.errors)[0] : null, deliveries: i.deliveries }));
const stepsAll = E.ctx.db.prepare('SELECT kind, status, attempts, note FROM steps').all();
const c = census(E.M.store);
const writes = Object.entries(E.M.st.calls).filter(([k]) => k.startsWith('POST')).reduce((s, [k, v]) => s + v - (callsBefore[k] || 0), 0);
const byKind = {};
for (const b of bodies) byKind[b.kind] = (byKind[b.kind] || 0) + 1;
const statuses = {}; for (const i of intakes) statuses[i.status] = (statuses[i.status] || 0) + 1;
const done = intakes.filter((i) => i.status === 'done');
const newCases = c.cases - 3000;
const faultsLeft = E.M.st.faults.reduce((s, f) => s + f.times, 0);
const reconciled = stepsAll.filter((s) => /found after a lost response/.test(s.note || '')).length;
const linked = done.filter((i) => JSON.parse(i.match).decision === 'link').length;

// 3. one sample: the requests for a new client with two injuries (synthetic person)
const sample = await (async () => {
  const S = await env(); const rr = rng(77);
  const body = ghlBody({ first: 'Rosa', last: 'Peña', dob: '1984-07-19', phone: '(415) 555-0147', email: 'rosa.example@example.com' }, rr, { id: 9, injuries: 2, overrides: { injury_1_type: 'CT', injury_1_date: '2022-02-01', injury_1_end_date: '2025-08-29', injury_1_body_parts: 'bilateral wrists, right shoulder, neck', injury_2_type: 'Specific', injury_2_date: '2025-09-12', injury_2_end_date: '', injury_2_body_parts: 'low back, L knee', injury_1_adj_number: '', injury_2_adj_number: '', employer_name: 'North Bay Builders, Inc.', referral_source: 'Former client', occupation: 'Carpenter', address1: '483 Fourth St', city: 'San Rafael', postal_code: '94901', preferred_language: 'Spanish', injury_2_description: 'Low back strain lifting drywall', injury_2_how: 'Lifting drywall sheets from the truck', injury_1_description: 'Wrists, shoulder and neck from years of overhead work', injury_1_how: 'Daily overhead drilling and framing', injury_1_claim_number: 'NB-2025-00871', injury_2_claim_number: 'NB-2025-01204', treating_doctors: '' } });
  await S.post(body); await S.server.drain();
  const posts = S.M.st.posts.map((p) => ({ endpoint: p.key.replace('POST ', ''), fields: [...new URLSearchParams(p.body)].map(([k, v]) => [k.replace(/^data/, ''), v]) }));
  const ghl = { tags: S.G.st.tags, notes: S.G.st.notes };
  await S.close();
  return { body, posts, ghl };
})();
await E.close();

const tap = await readFile(R + 'results/tests.tap', 'utf8').catch(() => '');
const tests = [...tap.matchAll(/^(ok|not ok) \d+ - (.+)$/gm)].map((m) => ({ ok: m[1] === 'ok', name: m[2].replace(/\\#/g, '#') }));

const m = {
  generatedAt: new Date().toISOString(),
  fields: mapping.map(({ n, label, scope, target, source, required }) => ({ n, label, scope, target, source, required })),
  dedupe,
  index: { cases: index.cases, contacts: index.contacts, calls: index.calls, modelMsPerCall: 500, modelMinutes: Math.round(index.calls * 0.5 / 60) },
  day: {
    posted: bodies.length + resend.length, unique: bodies.length, redeliveries: resend.length, byKind, statuses, newCases, linked,
    census: { injuriesNew: c.injuries - 3000, duplicateInjuries: c.duplicateInjuries, duplicateParties: c.duplicateParties, duplicateActivities: c.duplicateActivities },
    faults: plannedFaults, faultsUsed: plannedFaults - faultsLeft, reconciled, writes, elapsedMs: elapsed,
    ackP50: Math.round(pct(acks, 50) * 10) / 10, ackP95: Math.round(pct(acks, 95) * 10) / 10,
    retried: stepsAll.filter((s) => s.attempts > 1).length,
    outcomes,
  },
  sample, tests,
};
await writeFile(R + 'results/measurements.json', JSON.stringify(m, null, 1));
console.log(`dedupe: wrong links ${dedupe.wrongLinks}; returning ${JSON.stringify(dedupe.returning)}; new ${JSON.stringify(dedupe.fresh)}; lookalike ${JSON.stringify(dedupe.lookalike)}`);
console.log(`index: ${index.cases} cases, ${index.contacts} contacts, ${index.calls} calls (~${m.index.modelMinutes} min at 2/s)`);
console.log(`day: ${JSON.stringify(statuses)}; new cases ${newCases}; linked ${linked}; dupes ${JSON.stringify(m.day.census)}; faults ${m.day.faultsUsed}/${plannedFaults}; reconciled ${reconciled}; ack p50 ${m.day.ackP50} ms p95 ${m.day.ackP95} ms; tests ${tests.filter((t) => t.ok).length}/${tests.length}`);

// Dedupe accuracy on synthetic data: 3,000 existing clients indexed from the fake MerusCase through the
// real indexer, then 300 incoming leads of three kinds with known answers.
import { openDb } from '../src/db.js';
import { makeMerus } from '../src/merus/client.js';
import { buildIndex } from '../src/indexer.js';
import { findPerson } from '../src/dedupe.js';
import { fakeMerus, makeStore } from '../fake/merus.js';
import { rng, existingPeople, seedStore, returningVariant, newPerson, hardNegative } from './synth.js';

export async function evalDedupe({ existing = 3000, returning = 120, fresh = 150, negatives = 30, seed = 11 } = {}) {
  const r = rng(seed);
  const store = makeStore(); const people = existingPeople(existing, r); seedStore(store, people, r);
  const M = await fakeMerus({ store });
  const db = openDb(':memory:');
  const merus = makeMerus({ baseUrl: M.url, token: M.token, minIntervalMs: 0 });
  const t0 = Date.now();
  const built = await buildIndex({ db, merus });
  const buildMs = Date.now() - t0;
  await M.close();

  const cases = [];
  for (let k = 0; k < returning; k++) { const p = people[Math.floor(r() * people.length)]; const v = returningVariant(p, k, r); cases.push({ kind: 'returning', variant: v.kind, lead: v, truth: p.contactId }); }
  for (let k = 0; k < fresh; k++) { const v = newPerson(r, people); cases.push({ kind: 'new', variant: 'new', lead: v, truth: null }); }
  for (let k = 0; k < negatives; k++) { const v = hardNegative(r, people, k); cases.push({ kind: 'lookalike', variant: v.kind, lead: v, truth: null }); }

  const t1 = Date.now();
  const rows = cases.map((c) => {
    const m = findPerson(db, { first_name: c.lead.first, last_name: c.lead.last, date_of_birth: c.lead.dob, phones: [c.lead.phone], email: c.lead.email });
    const outcome = m.decision === 'link' ? (m.contactId === c.truth ? 'linked-correct' : 'linked-wrong') : m.decision;
    return { kind: c.kind, variant: c.variant, outcome, reason: m.reason, considered: m.considered };
  });
  const matchMs = Date.now() - t1;
  const tally = (kind) => { const o = {}; for (const x of rows.filter((y) => y.kind === kind)) o[x.outcome] = (o[x.outcome] || 0) + 1; return o; };
  const byVariant = {};
  for (const x of rows.filter((y) => y.kind !== 'new')) { const k = `${x.kind}:${x.variant}`; (byVariant[k] ||= {})[x.outcome] = (byVariant[k][x.outcome] || 0) + 1; }
  return {
    existing, built, buildMs, matchMs, leads: rows.length,
    returning: tally('returning'), fresh: tally('new'), lookalike: tally('lookalike'), byVariant,
    wrongLinks: rows.filter((x) => x.outcome === 'linked-wrong').length,
    avgCandidates: Math.round(rows.reduce((s, x) => s + x.considered, 0) / rows.length),
    samples: rows.filter((x) => x.outcome !== 'linked-correct' && x.outcome !== 'new').slice(0, 12),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await evalDedupe(), null, 1));

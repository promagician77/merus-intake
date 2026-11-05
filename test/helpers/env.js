import { readFileSync } from 'node:fs';
import { openDb } from '../../src/db.js';
import { loadMapping } from '../../src/mapping.js';
import { makeMerus } from '../../src/merus/client.js';
import { makeGhl } from '../../src/ghl/client.js';
import { makeServer } from '../../src/server.js';
import { fakeMerus, fakeGhl } from '../../fake/merus.js';

export const firm = () => JSON.parse(readFileSync(new URL('../../config/firm.json', import.meta.url), 'utf8'));
export const bodyDict = JSON.parse(readFileSync(new URL('../../config/bodyparts.json', import.meta.url), 'utf8'));
export const mapping = loadMapping();

export async function env({ store, today = '2026-11-05' } = {}) {
  const M = await fakeMerus(store ? { store } : {});
  const G = await fakeGhl();
  const ctx = {
    db: openDb(':memory:'), firm: firm(), bodyDict, mapping,
    merus: makeMerus({ baseUrl: M.url, token: M.token, minIntervalMs: 0, sleep: async () => {} }),
    ghl: makeGhl({ baseUrl: G.url, token: 'ghl-test' }),
    sleep: async () => {}, retryDelayMs: 0, today: () => today, webhookToken: 'hook-secret', adminToken: 'admin-secret', log: () => {},
  };
  const server = makeServer(ctx);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, { token = 'hook-secret', query = '' } = {}) => fetch(`${base}/hooks/ghl/signed${query}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const admin = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json', ...(init.headers || {}) } });
  return { M, G, ctx, server, base, post, admin, close: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await M.close(); await G.close(); } };
}

/** Counts that show duplicates: cases per contact, injuries per case, employer parties per case, activities by marker. */
export function census(store) {
  const markers = new Map();
  for (const a of store.activities) { const m = String(a.activity).match(/\[intake [^\]]+\]/)?.[0]; if (m) markers.set(m, (markers.get(m) || 0) + 1); }
  const partyKeys = new Map();
  for (const p of store.parties) { const k = `${p.case_file_id}:${p.contact_id}`; partyKeys.set(k, (partyKeys.get(k) || 0) + 1); }
  const injKeys = new Map();
  for (const i of store.injuries) { const k = `${i.case_file_id}:${i.date_of_injury}:${i.injury_type_id}`; injKeys.set(k, (injKeys.get(k) || 0) + 1); }
  return {
    cases: store.cases.size, contacts: store.contacts.size, injuries: store.injuries.length, parties: store.parties.length, activities: store.activities.length,
    duplicateActivities: [...markers.values()].filter((n) => n > 1).length,
    duplicateParties: [...partyKeys.values()].filter((n) => n > 1).length,
    duplicateInjuries: [...injKeys.values()].filter((n) => n > 1).length,
  };
}

// Builds and refreshes the local contact index used for dedupe.
// Full build: caseFiles/index -> parties/view per case -> contacts/view per new contact.
// Refresh:    caseFiles/index?modified[gte]=<last run> -> the same, for changed cases only.
import { indexContact } from './dedupe.js';
import { meta, now } from './db.js';
import { isoDate } from './normalize.js';

export function contactRecord(id, c) {
  const company = c.company_name || c.company || (Number(c.is_company) ? c.last_name : null);
  return {
    id: Number(id), company: Number(c.is_company) || (company && !c.first_name) ? company : null,
    first_name: c.first_name ?? null, last_name: c.last_name ?? null, date_of_birth: isoDate(c.birth_date || c.dob || c.date_of_birth),
    email: c.email ?? null, phones: [c.cell_phone, c.home_phone, c.work_phone, c.phone].filter(Boolean),
  };
}

export async function buildIndex(ctx, { since = null, onProgress = () => {} } = {}) {
  const { db, merus } = ctx;
  const started = now();
  const callsBefore = merus.calls;
  const cases = await merus.caseFilesIndex(since ? { 'modified[gte]': since } : undefined);
  const seen = new Set(db.prepare('SELECT contact_id FROM contacts_index').all().map((r) => r.contact_id));
  let added = 0; let refreshed = 0; let i = 0;
  for (const cf of cases) {
    for (const p of await merus.partiesView(cf.id)) {
      const id = Number(p.contact_id);
      if (seen.has(id) && !since) continue;
      const c = await merus.contactView(id);
      if (!c) continue;
      indexContact(db, contactRecord(id, c));
      if (seen.has(id)) refreshed++; else { added++; seen.add(id); }
    }
    if (++i % 250 === 0) onProgress({ cases: i, of: cases.length });
  }
  meta.set(db, 'index_built_at', started.slice(0, 19).replace('T', ' '));
  return { cases: cases.length, added, refreshed, calls: merus.calls - callsBefore, contacts: db.prepare('SELECT COUNT(*) n FROM contacts_index').get().n };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { makeContext } = await import('./server.js');
  const ctx = makeContext();
  const since = process.argv.includes('--full') ? null : meta.get(ctx.db, 'index_built_at');
  const r = await buildIndex(ctx, { since, onProgress: (p) => console.log(`${p.cases}/${p.of} cases`) });
  console.log(JSON.stringify(r));
}

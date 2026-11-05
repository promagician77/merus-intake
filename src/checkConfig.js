// Checks config/firm.json against the firm's MerusCase before go-live.
// Verifiable through published endpoints: user IDs (users/index, admin token), case type
// (caseTypes/index), activity types (activityTypes/index; --create adds missing ones via activityTypes/add).
// Not verifiable through published endpoints: case status, venue and office IDs, body-part IDs -
// these are listed for a manual check against the firm's spreadsheet.
export async function checkConfig(ctx, { create = false } = {}) {
  const { merus, firm } = ctx;
  const report = { ok: [], missing: [], created: [], manual: [] };
  const users = new Set((await merus.usersIndex()).map((u) => Number(u.id)));
  for (const [name, id] of Object.entries(firm.users)) (users.has(Number(id)) ? report.ok : report.missing).push(`user "${name}" = ${id}`);
  const types = new Set((await merus.caseTypesIndex()).map((t) => Number(t.id)));
  (types.has(Number(firm.caseFile.case_type_id)) ? report.ok : report.missing).push(`case type ${firm.caseFile.case_type_id}`);
  const acts = await merus.activityTypesIndex();
  for (const [key, a] of Object.entries(firm.activityTypes)) {
    const byId = acts.find((t) => Number(t.id) === Number(a.id));
    const byName = acts.find((t) => String(t.type).toLowerCase() === a.label.toLowerCase());
    if (byId) report.ok.push(`activity type "${a.label}" = ${a.id}`);
    else if (byName) report.missing.push(`activity type "${a.label}" exists as ${byName.id}, config says ${a.id}`);
    else if (create) { const id = await merus.activityTypesAdd(a.label); report.created.push(`activity type "${a.label}" = ${id} (update config)`); firm.activityTypes[key].id = id; }
    else report.missing.push(`activity type "${a.label}" (run with --create to add it)`);
  }
  report.manual.push(`case status ${firm.caseFile.case_status_id}`, `office ${firm.caseFile.office_id}`, ...Object.entries(firm.caseFile.venue_id_by_county).map(([k, v]) => `venue ${k} = ${v}`), 'body-part IDs in config/bodyparts.json');
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { makeContext } = await import('./server.js');
  const r = await checkConfig(makeContext(), { create: process.argv.includes('--create') });
  for (const k of ['ok', 'created', 'missing', 'manual']) for (const line of r[k]) console.log(`${k.padEnd(8)} ${line}`);
  process.exitCode = r.missing.length ? 1 : 0;
}

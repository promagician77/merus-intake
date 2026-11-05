// MerusCase API client. From the published developer guide: base https://api.meruscase.com,
// OAuth authorization-code tokens sent as "Authorization: Bearer ...", POST bodies as data[Model][field].
// Not published (read from the firm's endpoint spreadsheet): caseFiles/add, contacts/add,
// contacts/edit, and the response envelope - so ids are read defensively from several shapes.

export class MerusError extends Error {
  constructor(message, { status, outcome, body } = {}) { super(message); this.status = status; this.outcome = outcome; this.body = body; }
}

/** Flatten { CaseFile: {a: 1}, Injury: {b: 2} } into data[CaseFile][a]=1&data[Injury][b]=2 */
export function formEncode(models) {
  const p = new URLSearchParams();
  for (const [model, fields] of Object.entries(models)) for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(`data[${model}][${k}][]`, String(x)));
    else p.append(`data[${model}][${k}]`, String(v));
  }
  return p;
}

export function idFrom(body, model) {
  const cands = [body?.data?.[model]?.id, body?.[model]?.id, body?.data?.id, body?.id, body?.data?.[model.toLowerCase() + '_id'], body?.[`${model.charAt(0).toLowerCase()}${model.slice(1)}_id`]];
  const v = cands.find((x) => x !== undefined && x !== null);
  return v === undefined ? null : Number(v);
}

export function makeMerus({ baseUrl = 'https://api.meruscase.com', token, fetchFn = fetch, minIntervalMs = 500, timeoutMs = 20000, retries = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  let last = 0; let calls = 0;
  async function throttle() { const wait = last + minIntervalMs - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); }

  async function request(method, path, { form, query } = {}) {
    const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.append(k, v);
    for (let attempt = 0; ; attempt++) {
      await throttle(); calls++;
      let res;
      try {
        res = await fetchFn(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? form.toString() : undefined, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        // the request may or may not have reached MerusCase: only a read can tell
        if (method === 'GET' && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
        throw new MerusError(`${method} ${path}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`, { outcome: method === 'GET' ? 'failed' : 'unknown' });
      }
      if (res.status === 429 && attempt < retries) { const ra = Number(res.headers.get('retry-after')); await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt); continue; }
      if (res.status === 401) throw new MerusError('MerusCase rejected the token (401): re-authorise the app', { status: 401, outcome: 'failed' });
      const text = await res.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
      if (res.status >= 500) {
        if (method === 'GET' && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
        throw new MerusError(`${method} ${path}: HTTP ${res.status}`, { status: res.status, outcome: method === 'GET' ? 'failed' : 'unknown', body });
      }
      if (res.status >= 400 || body?.success === 0 || body?.success === false || body?.errors) throw new MerusError(`${method} ${path}: ${JSON.stringify(body?.errors || body?.message || body).slice(0, 300)}`, { status: res.status, outcome: 'rejected', body });
      log({ method, path, status: res.status });
      return body;
    }
  }
  const list = (b, model) => (Array.isArray(b?.data) ? b.data : Array.isArray(b) ? b : Object.values(b?.data || {})).map((x) => x?.[model] ?? x);

  return {
    get calls() { return calls; },
    request,
    // published endpoints
    caseFilesIndex: async (query) => list(await request('GET', 'caseFiles/index', { query }), 'CaseFile'),
    caseFileView: (id) => request('GET', `caseFiles/view/${id}`),
    contactView: async (id) => { const b = await request('GET', `contacts/view/${id}`); return b?.data?.Contact ?? b?.Contact ?? b?.data ?? b; },
    partiesView: async (caseId) => list(await request('GET', `parties/view/${caseId}`), 'Party'),
    partiesAdd: async (contactId, caseId) => idFrom(await request('POST', 'parties/add', { form: formEncode({ Party: { contact_id: contactId, case_file_id: caseId } }) }), 'Party'),
    injuriesView: async (caseId) => list(await request('GET', `injuries/view/${caseId}`), 'Injury'),
    injuriesAdd: async (caseId, injury) => idFrom(await request('POST', 'injuries/edit', { form: formEncode({ Injury: { case_file_id: caseId, ...injury } }) }), 'Injury'),
    activitiesIndex: async (caseId) => list(await request('GET', `activities/index/${caseId}`), 'Activity'),
    activitiesAdd: async (a) => idFrom(await request('POST', 'activities/add', { form: formEncode({ Activity: a }) }), 'Activity'),
    activityTypesIndex: async () => list(await request('GET', 'activityTypes/index'), 'ActivityType'),
    activityTypesAdd: async (type) => idFrom(await request('POST', 'activityTypes/add', { form: formEncode({ ActivityType: { type } }) }), 'ActivityType'),
    usersIndex: async () => list(await request('GET', 'users/index'), 'User'),
    caseTypesIndex: async () => list(await request('GET', 'caseTypes/index'), 'CaseType'),
    // from the firm's endpoint list (shapes to confirm against the spreadsheet)
    caseFilesAdd: async (models) => {
      const b = await request('POST', 'caseFiles/add', { form: formEncode(models) });
      const only = (m) => { const v = b?.data?.[m]?.id ?? b?.[m]?.id; return v == null ? null : Number(v); };
      return { caseFileId: idFrom(b, 'CaseFile'), contactId: only('Contact'), injuryId: only('Injury'), body: b };
    },
    contactsAdd: async (contact) => idFrom(await request('POST', 'contacts/add', { form: formEncode({ Contact: contact }) }), 'Contact'),
    contactsEdit: async (id, contact) => request('POST', 'contacts/edit', { form: formEncode({ Contact: { id, ...contact } }) }),
  };
}

// Local stand-in for the MerusCase API, for tests and the bench. Published endpoints follow
// docs.meruscase.com (paths, data[Model][field] parameters, injuries/edit add-vs-edit rule, MM/DD/YYYY
// injury dates, injury_type_id 1 = CT / 2 = Specific). caseFiles/add, contacts/add and contacts/edit
// are not published: their shapes here are assumptions to replace with the firm's spreadsheet.
// The response envelope { success, data: { Model: {...} } } is also an assumption.
import http from 'node:http';

export function parseForm(text) {
  const out = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const m = k.match(/^data\[(\w+)\]\[(\w+)\](\[\])?$/);
    if (!m) continue;
    out[m[1]] ||= {};
    if (m[3]) (out[m[1]][m[2]] ||= []).push(v);
    else if (out[m[1]][m[2]] !== undefined) out[m[1]][m[2]] = [].concat(out[m[1]][m[2]], v); // repeated key = more than one value
    else out[m[1]][m[2]] = v;
  }
  return out;
}
const ts = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');
const MDY = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/;

export function makeStore() {
  const s = { seq: { contact: 1000, case: 5000, party: 1, injury: 1, activity: 1, activityType: 9100 }, contacts: new Map(), cases: new Map(), parties: [], injuries: [], activities: [],
    activityTypes: [{ id: 9001, type: 'Intake: referral source' }, { id: 9002, type: 'Retainer signed' }, { id: 9003, type: 'Intake: data notes' }, { id: 1, type: 'Telephone Call' }],
    users: [{ id: 501, name: 'Attorney A' }, { id: 502, name: 'Staff B' }], caseTypes: [{ id: 10001, name: "Workers' Compensation" }] };
  s.addContact = (c) => { const id = c.id ?? ++s.seq.contact; s.contacts.set(id, { ...c, id }); return id; };
  s.addCase = (cf, when = new Date()) => { const id = ++s.seq.case; s.cases.set(id, { id, file_number: `HL-${id}`, date_opened: when.toISOString().slice(0, 10), modified: ts(when), ...cf }); return id; };
  s.addParty = (contact_id, case_file_id) => { const id = s.seq.party++; s.parties.push({ id, contact_id: Number(contact_id), case_file_id: Number(case_file_id) }); return id; };
  s.addInjury = (inj) => { const id = s.seq.injury++; s.injuries.push({ ...inj, id, case_file_id: Number(inj.case_file_id) }); return id; };
  return s;
}

export function fakeMerus({ token = 'merus-test-token', store = makeStore() } = {}) {
  const st = { store, faults: [], calls: {}, log: [], posts: [] };
  const ok = (data) => ({ success: 1, data });
  const bad = (res, code, msg) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: 0, errors: [msg] })); };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname.replace(/^\//, '');
      const key = `${req.method} ${path.replace(/\/\d+$/, '/:id')}`;
      st.calls[key] = (st.calls[key] || 0) + 1;
      st.log.push(key);
      if (req.method === 'POST') st.posts.push({ key, body });
      if (req.headers.authorization !== `Bearer ${token}`) return bad(res, 401, 'invalid token');
      const fault = st.faults.find((f) => f.method === req.method && path.startsWith(f.path) && f.times > 0);
      if (fault) fault.times--;
      if (fault?.mode === 'before') return bad(res, 500, 'injected 500 before saving');
      if (fault?.mode === '429') { res.writeHead(429, { 'retry-after': String(fault.retryAfter ?? 1) }); return res.end('{}'); }
      let out;
      try { out = route(req.method, path, url.searchParams, req.method === 'POST' ? parseForm(body) : {}); }
      catch (e) { return bad(res, 400, e.message); }
      if (fault?.mode === 'after') return bad(res, 500, 'injected 500 after saving');
      if (fault?.mode === 'drop-after') return res.socket.destroy();
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });

  function filterCases(q) {
    let list = [...store.cases.values()];
    for (const [k, v] of q) {
      const m = k.match(/^(\w+)\[(gte|min|start|lte|max|end|gt|lt)?\]$/); if (!m) continue;
      const [, field, op = 'eq'] = m;
      list = list.filter((c) => { const x = String(c[field] ?? ''); return op === 'eq' ? x === v : /gte|min|start/.test(op) ? x >= v : /lte|max|end/.test(op) ? x <= v : op === 'gt' ? x > v : x < v; });
    }
    return list;
  }

  function route(method, path, q, f) {
    const [res, act, idStr] = path.split('/'); const id = Number(idStr);
    const ep = `${method} ${res}/${act}`;
    switch (ep) {
      case 'GET caseFiles/index': return ok(filterCases(q).map((c) => ({ CaseFile: c })));
      case 'GET caseFiles/view': return ok({ CaseFile: store.cases.get(id) });
      case 'POST caseFiles/add': {
        const { CaseFile: cf = {}, Contact: ct, Injury: inj } = f;
        if (!inj) throw new Error('Injury data required');
        if (Object.values(inj).some(Array.isArray)) throw new Error('Only one injury per request');
        let contactId = cf.contact_id ? Number(cf.contact_id) : null;
        if (contactId && !store.contacts.has(contactId)) throw new Error(`Contact ${contactId} not found`);
        if (!contactId && !ct?.last_name) throw new Error('Contact last_name or CaseFile contact_id required');
        checkInjury(inj);
        if (!contactId) contactId = store.addContact({ ...ct });
        const caseId = store.addCase({ case_type_id: Number(cf.case_type_id), case_status_id: Number(cf.case_status_id), venue_id: Number(cf.venue_id), office_id: Number(cf.office_id), attorney_user_id: Number(cf.attorney_user_id) || null });
        store.addParty(contactId, caseId);
        const injuryId = store.addInjury({ ...inj, case_file_id: caseId });
        return ok({ CaseFile: { id: caseId }, Contact: { id: contactId }, Injury: { id: injuryId } });
      }
      case 'GET contacts/view': return store.contacts.has(id) ? ok({ Contact: store.contacts.get(id) }) : (() => { throw new Error('Contact not found'); })();
      case 'POST contacts/add': return ok({ Contact: { id: store.addContact({ ...(f.Contact || {}) }) } });
      case 'POST contacts/edit': { const c = store.contacts.get(Number(f.Contact?.id)); if (!c) throw new Error('Contact not found'); Object.assign(c, f.Contact, { id: c.id }); return ok({ Contact: { id: c.id } }); }
      case 'GET parties/view': return ok(store.parties.filter((p) => p.case_file_id === id).map((p) => ({ Party: p })));
      case 'POST parties/add': {
        const { contact_id, case_file_id } = f.Party || {};
        if (!store.contacts.has(Number(contact_id)) || !store.cases.has(Number(case_file_id))) throw new Error('contact_id and case_file_id must exist');
        return ok({ Party: { id: store.addParty(contact_id, case_file_id) } });
      }
      case 'GET injuries/view': return ok(store.injuries.filter((i) => i.case_file_id === id).map((i) => ({ Injury: i })));
      case 'POST injuries/edit': {
        const inj = f.Injury || {};
        if (Object.values(inj).some(Array.isArray)) throw new Error('Only one injury per request');
        if (inj.id) { const cur = store.injuries.find((i) => i.id === Number(inj.id)); if (!cur) throw new Error('Injury not found'); Object.assign(cur, inj, { id: cur.id }); return ok({ Injury: { id: cur.id } }); }
        if (!store.cases.has(Number(inj.case_file_id))) throw new Error('case_file_id required to add an injury');
        checkInjury(inj);
        const c = store.cases.get(Number(inj.case_file_id)); c.modified = ts();
        return ok({ Injury: { id: store.addInjury(inj) } });
      }
      case 'GET activities/index': return ok(store.activities.filter((a) => a.case_file_id === id).map((a) => ({ Activity: a })));
      case 'POST activities/add': {
        const a = f.Activity || {};
        if (!store.cases.has(Number(a.case_file_id))) throw new Error('case_file_id required');
        if (!a.activity_type_id) throw new Error('activity_type_id required');
        if (a.date && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(a.date)) throw new Error('date must be YYYY-MM-DD HH:MM:SS');
        const aid = store.seq.activity++; store.activities.push({ ...a, id: aid, case_file_id: Number(a.case_file_id) }); return ok({ Activity: { id: aid } });
      }
      case 'GET activityTypes/index': return ok(store.activityTypes.map((t) => ({ ActivityType: t })));
      case 'POST activityTypes/add': { const t = { id: ++store.seq.activityType, type: f.ActivityType?.type }; store.activityTypes.push(t); return ok({ ActivityType: { id: t.id } }); }
      case 'GET users/index': return ok(store.users.map((u) => ({ User: u })));
      case 'GET caseTypes/index': return ok(store.caseTypes.map((t) => ({ CaseType: t })));
      default: throw new Error(`no route ${ep}`);
    }
  }
  function checkInjury(inj) {
    if (!['1', '2'].includes(String(inj.injury_type_id))) throw new Error('injury_type_id must be 1 (CT) or 2 (Specific)');
    if (!MDY.test(inj.date_of_injury || '')) throw new Error('date_of_injury must be MM/DD/YYYY');
    if (inj.date_of_injury_end && !MDY.test(inj.date_of_injury_end)) throw new Error('date_of_injury_end must be MM/DD/YYYY');
    for (let n = 11; n <= 20; n++) if (inj[`q1_injury_description_${n}_id`]) throw new Error('at most 10 body parts');
  }

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, st, store, token, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

export function fakeGhl() {
  const st = { tags: [], notes: [] };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = req.url.match(/^\/contacts\/([^/]+)\/(tags|notes)$/);
      if (!m || req.method !== 'POST' || !req.headers.version) { res.writeHead(404); return res.end('{}'); }
      st[m[2]].push({ contactId: m[1], ...JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, st, close: () => new Promise((r) => server.close(r)) })));
}

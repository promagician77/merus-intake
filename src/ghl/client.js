// GoHighLevel write-back with a Private Integration token (static OAuth token; Bearer + Version header,
// base https://services.leadconnectorhq.com; HighLevel recommends rotating it every 90 days).
// POST /contacts/{id}/tags is documented; the note uses the matching /contacts/{id}/notes path.
export function makeGhl({ baseUrl = 'https://services.leadconnectorhq.com', token, fetchFn = fetch, version = '2021-07-28' }) {
  async function post(path, body) {
    if (!token) return { skipped: true };
    const res = await fetchFn(new URL(path, baseUrl), { method: 'POST', headers: { Authorization: `Bearer ${token}`, Version: version, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GoHighLevel ${path}: HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }
  return {
    addTags: (contactId, tags) => post(`/contacts/${contactId}/tags`, { tags }),
    addNote: (contactId, body) => post(`/contacts/${contactId}/notes`, { body }),
  };
}

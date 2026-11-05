// HTTP service: GoHighLevel posts here when an opportunity reaches the "Signed" stage.
//   POST /hooks/ghl/signed         Authorization: Bearer <WEBHOOK_TOKEN>  (Custom Webhook action)
//                                  or ?key=<WEBHOOK_TOKEN>               (plain Webhook action)
//   GET  /health
//   GET  /intakes, GET /intakes/:id, POST /intakes/:id/retry, POST /intakes/:id/resolve  (ADMIN_TOKEN)
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDb } from './db.js';
import { loadMapping } from './mapping.js';
import { makeMerus } from './merus/client.js';
import { makeGhl } from './ghl/client.js';
import { receive, process as runOne, resolveReview } from './intake.js';

const MAX_BODY = 256 * 1024;
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); };

export function makeContext(env = process.env, overrides = {}) {
  const firm = JSON.parse(readFileSync(env.FIRM_CONFIG || new URL('../config/firm.json', import.meta.url), 'utf8'));
  const bodyDict = JSON.parse(readFileSync(env.BODY_PARTS || new URL('../config/bodyparts.json', import.meta.url), 'utf8'));
  return {
    db: openDb(env.DB_PATH || 'intake.sqlite'), firm, bodyDict, mapping: loadMapping(env.MAPPING_CSV || undefined),
    merus: makeMerus({ baseUrl: env.MERUS_BASE_URL, token: env.MERUS_TOKEN, minIntervalMs: Number(env.MERUS_MIN_INTERVAL_MS || 500) }),
    ghl: env.GHL_TOKEN ? makeGhl({ baseUrl: env.GHL_BASE_URL, token: env.GHL_TOKEN }) : null,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o })),
    webhookToken: env.WEBHOOK_TOKEN, adminToken: env.ADMIN_TOKEN,
    ...overrides,
  };
}

export function makeServer(ctx) {
  const queue = []; let busy = false; let idle = Promise.resolve(); let markIdle = () => {};
  const kick = () => {
    if (busy) return;
    busy = true; idle = new Promise((r) => { markIdle = r; });
    (async () => {
      while (queue.length) {
        const id = queue.shift();
        try { await runOne(ctx, id); } catch (e) { ctx.log?.({ intake: id, error: e.message }); }
      }
      busy = false; markIdle();
    })();
  };
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    // over the limit: stop buffering, read to the end so the 413 reaches the sender, cut off past 8x
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); else if (size > MAX_BODY * 8) req.destroy(); });
    req.on('end', () => (size > MAX_BODY ? reject(Object.assign(new Error('body too large'), { code: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, queued: queue.length });
      if (req.method === 'POST' && url.pathname === '/hooks/ghl/signed') {
        if (!ctx.webhookToken || !(safeEq(bearer(req), ctx.webhookToken) || safeEq(url.searchParams.get('key'), ctx.webhookToken))) return send(res, 401, { error: 'unauthorised' });
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'body too large' : 'body is not JSON' }); }
        const r = receive(ctx, body);
        if (r.ignored) return send(res, 200, { ignored: r.ignored });
        if (r.rejected) return send(res, 422, { error: r.rejected });
        if (!r.duplicate || r.requeued) { queue.push(r.intakeId); setImmediate(kick); }
        return send(res, 202, r);
      }
      if (url.pathname.startsWith('/intakes')) {
        if (!ctx.adminToken || !safeEq(bearer(req), ctx.adminToken)) return send(res, 401, { error: 'unauthorised' });
        const m = url.pathname.match(/^\/intakes(?:\/(\d+))?(?:\/(retry|resolve))?$/);
        if (!m) return send(res, 404, { error: 'not found' });
        const id = m[1] && Number(m[1]);
        if (req.method === 'GET' && !id) return send(res, 200, ctx.db.prepare('SELECT id, idem_key, status, received_at, updated_at, deliveries, errors FROM intakes ORDER BY id DESC LIMIT 200').all());
        if (req.method === 'GET' && id) return send(res, 200, { intake: ctx.db.prepare('SELECT id, idem_key, status, match, result, errors, deliveries FROM intakes WHERE id = ?').get(id), steps: ctx.db.prepare('SELECT seq, kind, status, result_id, attempts, note FROM steps WHERE intake_id = ? ORDER BY seq').all(id) });
        if (req.method === 'POST' && m[2] === 'retry') { ctx.db.prepare("UPDATE intakes SET status = CASE WHEN plan IS NULL THEN 'received' ELSE 'queued' END WHERE id = ? AND status IN ('failed','held')").run(id); queue.push(id); setImmediate(kick); return send(res, 202, { queued: id }); }
        if (req.method === 'POST' && m[2] === 'resolve') { const d = JSON.parse(await readBody(req) || '{}'); return send(res, 200, await resolveReview(ctx, id, d)); }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      ctx.log?.({ error: e.message });
      return send(res, 500, { error: 'internal error' });
    }
  });
  server.drain = async () => { for (;;) { if (busy) await idle; else if (queue.length) await new Promise((r) => setTimeout(r, 5)); else return; } };
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = makeContext();
  for (const k of ['MERUS_TOKEN', 'WEBHOOK_TOKEN', 'ADMIN_TOKEN']) if (!process.env[k]) { console.error(`${k} is not set`); process.exit(1); }
  const port = Number(process.env.PORT || 8787);
  makeServer(ctx).listen(port, () => ctx.log({ listening: port }));
}

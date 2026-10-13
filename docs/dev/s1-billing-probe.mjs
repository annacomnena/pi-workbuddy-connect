// S1 billing experiment probe (auxiliary, read-only against the loopback gateway).
//
// Declared helper for docs/dev/S1-billing-experiment.md. It talks to
// 127.0.0.1:<port> only. It never prints the bearer; the bearer is read from
// this project's own gateway.json (env: WORKBUDDY_GATEWAY_TOKEN overrides).
//
// Usage: node docs/dev/s1-billing-probe.mjs <port> <models|credits|chat|status>
//   models  GET /v1/models            -> id + credit-rate + context, sorted by rate
//   credits GET /v1/workbuddy/credits -> total + per-package remain/size/endTime
//   chat    POST /v1/chat/completions -> one non-streamed completion (args follow)
//   status  GET /healthz              -> readiness probe (no bearer)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const port = process.argv[2];
const command = process.argv[3];
if (!port || !command) {
  console.error('usage: node s1-billing-probe.mjs <port> <models|credits|chat|status> [json]');
  process.exit(2);
}

function bearer() {
  const env = typeof process.env.WORKBUDDY_GATEWAY_TOKEN === 'string'
    && process.env.WORKBUDDY_GATEWAY_TOKEN.trim() !== '';
  if (env) return process.env.WORKBUDDY_GATEWAY_TOKEN.trim();
  const file = join(process.env.APPDATA ?? '', 'pi-workbuddy-connect', 'gateway.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof doc.token !== 'string' || doc.token === '') throw new Error('gateway.json carries no token');
  return doc.token;
}

const base = `http://127.0.0.1:${port}`;
const auth = { Authorization: `Bearer ${bearer()}` };

async function get(path) {
  const response = await fetch(`${base}${path}`, { headers: auth });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

function sizeLabel(pack) {
  const size = pack.size ?? 0;
  return size > 0 ? `${pack.remain}/${size}` : `${pack.remain}/?`;
}

async function main() {
  if (command === 'status') {
    const response = await fetch(`${base}/healthz`);
    console.log(response.status, await response.text());
    return;
  }
  if (command === 'models') {
    const { status, body } = await get('/v1/models');
    if (status !== 200) { console.log('HTTP', status, JSON.stringify(body)); return; }
    const rateOf = (model) => {
      const raw = model.credits;
      if (typeof raw !== 'string') return undefined;
      const match = /x?\s*([0-9]*\.?[0-9]+)/iu.exec(raw);
      return match === null ? undefined : Number(match[1]);
    };
    const rows = body.data.map((model) => ({
      id: model.id,
      credits: model.credits ?? '(none)',
      rate: rateOf(model),
      context: model.context_window,
      maxOut: model.max_output_tokens,
    }));
    const cheapest = rows.filter((row) => row.rate !== undefined).sort((a, b) => a.rate - b.rate);
    const priciest = [...cheapest].reverse();
    console.log('source=', body.workbuddy_source ?? body.source, 'count=', rows.length);
    console.log('--- lowest rates ---');
    for (const row of cheapest.slice(0, 5)) console.log(JSON.stringify(row));
    console.log('--- highest rates ---');
    for (const row of priciest.slice(0, 5)) console.log(JSON.stringify(row));
    console.log('--- all ---');
    for (const row of rows) console.log(JSON.stringify(row));
    return;
  }
  if (command === 'credits') {
    const { status, body } = await get('/v1/workbuddy/credits');
    if (status !== 200) { console.log('HTTP', status, JSON.stringify(body)); return; }
    console.log('at=', new Date().toISOString(), 'fetchedAt=', body.fetchedAt);
    console.log('total=', body.total, 'unlimited=', body.unlimited, 'cycles=', body.cycleResetTime ?? '(none)');
    body.packages.forEach((pack, index) => {
      console.log(`  [${index}] ${pack.name} remain/size=${sizeLabel(pack)} endTime=${pack.endTime ?? '(none)'}`);
    });
    return;
  }
  if (command === 'chat') {
    const request = JSON.parse(process.argv[4] ?? '{}');
    const started = Date.now();
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const elapsedMs = Date.now() - started;
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    console.log('http=', response.status, 'elapsedMs=', elapsedMs, 'bytes=', text.length);
    if (typeof body === 'object' && body !== null) {
      console.log('usage=', JSON.stringify(body.usage));
      console.log('finish_reason=', body.choices?.[0]?.finish_reason);
      console.log('content_length=', String(body.choices?.[0]?.message?.content ?? '').length);
      const meta = { ...body };
      delete meta.choices;
      console.log('envelope=', JSON.stringify(meta).slice(0, 800));
    } else {
      console.log('body=', String(body).slice(0, 800));
    }
    return;
  }
  console.error(`unknown command: ${command}`);
  process.exit(2);
}

await main();

// Smoke test de GET /-/cuota (SC-2337) contra bin/claude-router.js: el router anota la ultima lectura de las cabeceras
// anthropic-ratelimit-unified-* de cada respuesta de Anthropic por sha256(Bearer) y la sirve en loopback.
// Un Anthropic falso responde lo que se pida en el campo `fake` del cuerpo ({status, headers}). Se verifica:
//   - sin trafico, /-/cuota es {} (y no sale a Anthropic),
//   - una respuesta con las cabeceras => la lectura aparece bajo sha256(Bearer)[0:16], con 5 h, 7 d, resets, status y hora,
//   - la ultima lectura sustituye a la anterior; un 429 `rejected` tambien se anota,
//   - sin cabeceras, con valores rotos o sin Bearer (x-api-key) => nada, y la respuesta llega igual al cliente,
//   - el token no aparece en /-/cuota, /-/health ni en el log,
//   - solo GET y sin Origin ni Sec-Fetch-*: lo demas, 403/405 sin salir a Anthropic.
// Sin dependencias.
//
//   node tests/smoke-cuota.js [ruta/al/claude-router.js]
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROUTER = process.argv[2] || path.join(__dirname, '..', 'plugins', 'local-router', 'bin', 'claude-router.js');
const P_ANT = 18941, P_ROUTER = 18942;
const U = 'anthropic-ratelimit-unified-';
const TOKEN_A = 'sk-ant-oat01-CANARIO-A-no-debe-salir-en-ninguna-parte';
const TOKEN_B = 'sk-ant-oat01-CANARIO-B-no-debe-salir-en-ninguna-parte';
const hashOf = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

let antHits = 0;
const ant = http.createServer((req, res) => {
  antHits++;
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    let fake = {};
    try { fake = JSON.parse(b || '{}').fake || {}; } catch {}
    res.writeHead(fake.status || 200, { 'content-type': 'application/json', ...(fake.headers || {}) });
    res.end(JSON.stringify({ who: 'anthropic', ok: true }));
  });
});

const call = (method, urlPath, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const rq = http.request({ host: '127.0.0.1', port: P_ROUTER, path: urlPath, method, headers, timeout: 5000 }, (r) => {
    let d = ''; r.on('data', (c) => d += c); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: d }));
  });
  rq.on('error', reject);
  rq.end(body);
});
const message = (token, fake, extra = {}) => {
  const body = JSON.stringify({ model: 'claude-opus-4-1', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], fake });
  return call('POST', '/v1/messages', { body, headers: { 'content-type': 'application/json',
    'content-length': Buffer.byteLength(body), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });
};
const cuota = async () => JSON.parse((await call('GET', '/-/cuota')).body);

let fails = 0;
function check(name, cond, extra) { if (!cond) { fails++; console.log(`FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); } else console.log(`ok   ${name}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lectura = (u5, u7, status = 'allowed', claim = 'five_hour') => ({ status: 200, headers: {
  [`${U}status`]: status, [`${U}representative-claim`]: claim, [`${U}reset`]: '1791808200',
  [`${U}5h-utilization`]: String(u5), [`${U}5h-reset`]: '1791808200',
  [`${U}7d-utilization`]: String(u7), [`${U}7d-reset`]: '1792267200' } });

(async () => {
  const envFile = '/tmp/cuota-smoke-env';
  fs.writeFileSync(envFile, 'export ANTHROPIC_BASE_URL=http://127.0.0.1:1\nexport ANTHROPIC_AUTH_TOKEN=sk-litellm-fake\n');
  await new Promise((r) => ant.listen(P_ANT, '127.0.0.1', r));
  const router = spawn(process.execPath, [ROUTER], {
    env: { ...process.env, CLAUDE_ROUTER_PORT: String(P_ROUTER), CLAUDE_ROUTER_ENV_FILE: envFile,
      CLAUDE_ROUTER_ANTHROPIC_URL: `http://127.0.0.1:${P_ANT}`,
      CLAUDE_ROUTER_ROUTING_CONFIG_URL: 'http://127.0.0.1:1/nadie',
      CLAUDE_ROUTER_FLIP_DIR: '/tmp/cuota-smoke-flip' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; router.stdout.on('data', (d) => log.push(String(d))); router.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 40; i++) { try { await call('GET', '/-/health'); break; } catch { await sleep(250); } }

  try {
    const hits0 = antHits;
    const vacia = await call('GET', '/-/cuota');
    check('sin trafico, /-/cuota es {} y no sale a Anthropic', vacia.status === 200 && vacia.body === '{}' && antHits === hits0, vacia);
    check('/-/cuota es JSON sin cache', /json/.test(vacia.headers['content-type'] || '') && vacia.headers['cache-control'] === 'no-store', vacia.headers);

    // una respuesta 200 con las cabeceras unificadas
    const r1 = await message(TOKEN_A, lectura(0.34, 0.26));
    check('la respuesta llega intacta al cliente (200 + cabeceras unificadas)', r1.status === 200
      && r1.headers[`${U}5h-utilization`] === '0.34' && JSON.parse(r1.body).who === 'anthropic', r1);
    let q = await cuota();
    const ka = hashOf(TOKEN_A), l = q[ka];
    check('la lectura aparece bajo sha256(Bearer)[0:16]', Object.keys(q).length === 1 && !!l, q);
    check('lleva 5 h y 7 d con sus resets', l && l.fiveHour.utilization === 0.34 && l.fiveHour.resetsAt === 1791808200
      && l.sevenDay.utilization === 0.26 && l.sevenDay.resetsAt === 1792267200, l);
    check('lleva status, reclamo y hora de lectura', l && l.status === 'allowed' && l.representativeClaim === 'five_hour'
      && Math.abs(l.readAt - Date.now() / 1000) < 10, l);

    // la ultima lectura sustituye; un 429 rejected tambien se anota
    await message(TOKEN_A, lectura(0.5, 1, 'rejected', 'seven_day'));
    await message(TOKEN_B, { ...lectura(0.1, 0.2), status: 429 });
    q = await cuota();
    check('la ultima lectura sustituye a la anterior', q[ka].fiveHour.utilization === 0.5 && q[ka].sevenDay.utilization === 1
      && q[ka].status === 'rejected' && q[ka].representativeClaim === 'seven_day', q[ka]);
    check('un 429 con las cabeceras tambien se anota (otra cuenta, otra entrada)', Object.keys(q).length === 2
      && q[hashOf(TOKEN_B)] && q[hashOf(TOKEN_B)].sevenDay.utilization === 0.2, q);

    // sin cabeceras, valores rotos o sin Bearer: nada, y la respuesta llega igual
    const n = Object.keys(q).length;
    const sin = await message('sk-ant-oat01-CANARIO-C', { status: 200, headers: {} });
    const rota = await message('sk-ant-oat01-CANARIO-D', { status: 200, headers: { [`${U}5h-utilization`]: 'no-es-un-numero', [`${U}7d-utilization`]: '' } });
    const apikey = await message(null, lectura(0.9, 0.9), { 'x-api-key': 'sk-ant-api03-CANARIO-E' });
    check('sin cabeceras unificadas no se anota nada', Object.keys(await cuota()).length === n);
    check('con valores rotos tampoco, y el cliente recibe su 200', sin.status === 200 && rota.status === 200 && Object.keys(await cuota()).length === n);
    check('sin Bearer (x-api-key) tampoco', apikey.status === 200 && Object.keys(await cuota()).length === n);

    // el token no sale en /-/cuota, /-/health ni en el log
    const todo = [JSON.stringify(await cuota()), (await call('GET', '/-/health')).body, log.join('')].join('\n');
    check('ningun token en /-/cuota, /-/health ni en el log', !/CANARIO|sk-ant-/.test(todo) && todo.includes('listen'), todo.slice(0, 300));

    // solo GET, sin Origin ni Sec-Fetch-*: nada de eso sale a Anthropic
    const hits1 = antHits;
    const post = await call('POST', '/-/cuota', { body: '{}', headers: { 'content-length': '2', authorization: `Bearer ${TOKEN_A}` } });
    const origen = await call('GET', '/-/cuota', { headers: { origin: 'http://evil.example' } });
    const fetchSite = await call('GET', '/-/cuota', { headers: { 'sec-fetch-site': 'same-origin' } });
    const query = await call('GET', '/-/cuota?x=1', { headers: { authorization: `Bearer ${TOKEN_A}` } });
    check('POST /-/cuota: 405', post.status === 405 && post.headers.allow === 'GET', post);
    check('con Origin: 403', origen.status === 403 && !/utilization/.test(origen.body), origen);
    check('con Sec-Fetch-*: 403', fetchSite.status === 403 && !/utilization/.test(fetchSite.body), fetchSite);
    check('con query string sigue siendo la ruta (no se reenvia a Anthropic con el Bearer)', query.status === 200 && !!JSON.parse(query.body)[ka], query);
    check('ninguna de esas salio a Anthropic', antHits === hits1, { antHits, hits1 });
  } catch (e) { fails++; console.log('FAIL excepcion', e);
  } finally {
    router.kill();
    ant.close();
    process.exit(fails ? 1 : 0);
  }
})();

// Regresion SC-2094: un fallo al leer /api/model-routing/config NO cambia la politica del gate.
// Antes, un timeout cacheaba cfg=null 60 s y claudeGate() caia al entorno del unit (solo Opus):
// cada claude-sonnet-5-5 de la compania salia como GATE-LOCAL (reescrito al qwen).
// Fakes: LiteLLM, Anthropic y el servidor de config. Sin dependencias.
//
//   node tests/smoke-routing-config-stale.js [ruta/al/claude-router.js]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROUTER = process.argv[2] || path.join(__dirname, '..', 'plugins', 'local-router', 'bin', 'claude-router.js');
const P_LLM = 18921, P_ANT = 18922, P_CFG = 18923, P_ROUTER_A = 18924, P_ROUTER_B = 18925, P_DEAD = 18929;
const COMPANY = { 'x-claude-class': 'company' };
const SONNET = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hola' }] };
// Lo que publica el panel: Opus y Sonnet dentro del gate.
const CFG_BOTH = { sticky: false, default_plan: 'local', session_plans: {},
  company: { claude: true, claude_gate: { mode: 'rewrite', allow: ['claude-opus-5-5', 'claude-sonnet-5-5'], target: 'qwen38-flash-next' } } };
const CFG_OPUS_ONLY = { ...CFG_BOTH, company: { claude: true, claude_gate: { mode: 'rewrite', allow: ['claude-opus-5-5'], target: 'qwen38-flash-next' } } };

let cfgBody = CFG_BOTH, cfgDelayMs = 0, cfgServer = null;
const hits = { llm: 0, ant: 0 };
let fails = 0, checks = 0;
function check(name, cond, extra) { checks++; if (!cond) { fails++; console.log(`FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); } else console.log(`ok   ${name}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const mk = tag => http.createServer((req, res) => {
  req.on('data', () => {}); req.on('end', () => { hits[tag]++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ who: tag })); });
});
const startCfg = () => new Promise(r => {
  cfgServer = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(cfgBody)); }, cfgDelayMs);
  });
  cfgServer.listen(P_CFG, '127.0.0.1', r);
});
const stopCfg = () => new Promise(r => { if (!cfgServer) return r(); cfgServer.closeAllConnections(); cfgServer.close(r); cfgServer = null; });

function post(port, bodyObj, headers = COMPANY) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const h = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      authorization: 'Bearer oauth', 'x-claude-code-session-id': 'sid-company-12345678', ...headers };
    const rq = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: h, timeout: 10000 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(d || '{}') }));
    });
    rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.end(body);
  });
}
const health = port => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/-/health' }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
});

function startRouter(port, env, logs) {
  const envFile = `/tmp/routing-stale-smoke-env-${port}`;
  fs.writeFileSync(envFile, `export ANTHROPIC_BASE_URL=http://127.0.0.1:${P_LLM}\nexport ANTHROPIC_AUTH_TOKEN=sk-litellm-fake\n`);
  const p = spawn(process.execPath, [ROUTER], { env: { ...process.env, CLAUDE_ROUTER_PORT: String(port),
    CLAUDE_ROUTER_ENV_FILE: envFile, CLAUDE_ROUTER_ANTHROPIC_URL: `http://127.0.0.1:${P_ANT}`,
    // El entorno del unit de produccion: gate rewrite con SOLO Opus. Es lo que hay que NO usar mientras haya una config buena.
    CLAUDE_ROUTER_CLAUDE_GATE: 'rewrite', CLAUDE_ROUTER_CLAUDE_GATE_ALLOW: 'claude-opus-5-5', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => { logs.push(String(d)); process.stdout.write(`  [router:${port}] ${d}`); });
  p.stderr.on('data', d => process.stderr.write(`  [router:${port}!] ${d}`));
  return p;
}
async function ready(port) { for (let i = 0; i < 40; i++) { try { await health(port); return; } catch { await sleep(250); } } }

(async () => {
  const llm = mk('llm'), ant = mk('ant');
  await new Promise(r => llm.listen(P_LLM, '127.0.0.1', r));
  await new Promise(r => ant.listen(P_ANT, '127.0.0.1', r));
  const logsA = [], logsB = [];
  // A: TTL 1 s y timeout 500 ms para forzar el fallo rapido.
  const A = startRouter(P_ROUTER_A, { CLAUDE_ROUTER_ROUTING_CONFIG_URL: `http://127.0.0.1:${P_CFG}/api/model-routing/config`,
    CLAUDE_ROUTER_ROUTING_CONFIG_TTL_MS: '1000', CLAUDE_ROUTER_ROUTING_CONFIG_TIMEOUT_MS: '500' }, logsA);
  await ready(P_ROUTER_A);
  try {
    // 1. Config buena: Sonnet esta en la lista del panel => Anthropic.
    await startCfg();
    let r = await post(P_ROUTER_A, SONNET);
    check('config buena: Sonnet de la compania -> Anthropic', r.json.who === 'ant', r);

    // 2. Endpoint LENTO (mas que el timeout) tras una config buena: se sirve la ultima buena.
    cfgDelayMs = 2500; // > 2 s (timeout viejo) y > 500 ms (timeout del test)
    await sleep(1100); // vence el TTL
    r = await post(P_ROUTER_A, SONNET);
    check('endpoint lento: Sonnet NO se reescribe (sirve la ultima config buena)', r.json.who === 'ant', r);
    check('endpoint lento: el router registro el timeout', logsA.some(l => /routing-config ERROR timeout; sirve la ultima config buena/.test(l)), logsA);

    // 3. Endpoint CAIDO tras una config buena: igual.
    await stopCfg();
    await sleep(1100);
    r = await post(P_ROUTER_A, SONNET);
    check('endpoint caido: Sonnet NO se reescribe', r.json.who === 'ant', r);
    check('endpoint caido: ningun GATE-LOCAL de Sonnet en el log', !logsA.some(l => /GATE-LOCAL model=claude-sonnet-5-5/.test(l)), logsA);
    const h = await health(P_ROUTER_A);
    check('health: gate_rewritten = 0', h.gate_rewritten === 0, h);

    // 4. El endpoint vuelve con otra politica (solo Opus): la config fresca GANA a la rancia.
    cfgBody = CFG_OPUS_ONLY; cfgDelayMs = 0; await startCfg();
    await sleep(1100);
    r = await post(P_ROUTER_A, SONNET);
    check('endpoint de vuelta con gate solo-Opus: Sonnet se reescribe (la rancia no se pega)', r.json.who === 'llm', r);
    cfgBody = CFG_BOTH;
  } finally { A.kill(); }

  // 5. Sin ninguna config buena previa, el fail-safe de siempre: manda el entorno del unit (aqui, solo Opus).
  const C = startRouter(P_ROUTER_B, { CLAUDE_ROUTER_ROUTING_CONFIG_URL: `http://127.0.0.1:${P_DEAD}/api/model-routing/config`,
    CLAUDE_ROUTER_ROUTING_CONFIG_TTL_MS: '1000' }, logsB);
  await ready(P_ROUTER_B);
  try {
    const r = await post(P_ROUTER_B, SONNET);
    check('sin config buena previa: manda el entorno del unit (Sonnet reescrito)', r.json.who === 'llm', r);
    check('sin config buena previa: log "sin desvio"', logsB.some(l => /routing-config ERROR .*fail-safe = sin desvio/.test(l)), logsB);
  } finally { C.kill(); }

  // 6. Timeout por defecto = 5 s (antes 2 s): un panel que tarda 2,5 s ya se lee.
  const logsD = [];
  cfgBody = CFG_OPUS_ONLY; cfgDelayMs = 2500; await stopCfg(); await startCfg();
  const D = startRouter(P_ROUTER_B, { CLAUDE_ROUTER_ROUTING_CONFIG_URL: `http://127.0.0.1:${P_CFG}/api/model-routing/config`,
    // el entorno permite Sonnet; solo la config leida (solo Opus) lo reescribe
    CLAUDE_ROUTER_CLAUDE_GATE_ALLOW: 'claude-opus-5-5,claude-sonnet-5-5' }, logsD);
  await ready(P_ROUTER_B);
  try {
    const r = await post(P_ROUTER_B, SONNET);
    check('timeout por defecto > 2,5 s: la config lenta se lee (Sonnet reescrito por ella)', r.json.who === 'llm', r);
    check('timeout por defecto: sin routing-config ERROR', !logsD.some(l => /routing-config ERROR/.test(l)), logsD);
  } finally { D.kill(); }

  llm.close(); ant.close(); await stopCfg();
  console.log(`\n${checks - fails}/${checks} ok`);
  process.exit(fails ? 1 : 0);
})();

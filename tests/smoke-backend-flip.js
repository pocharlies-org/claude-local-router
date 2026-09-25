// Smoke test de los eventos de flip de backend (26-09-2026) contra bin/claude-router.js.
// Un LiteLLM falso responde con la cabecera `x-litellm-model-group` que se le pida en el
// cuerpo (campo `group`). Se verifica en backend-events.jsonl (CLAUDE_ROUTER_FLIP_DIR a
// /tmp):
//   - primer avistamiento de una sesion => SIN evento (linea de base),
//   - local -> alibaba => evento, alibaba -> local => evento (recuperacion),
//   - repeticion del mismo backend => sin evento,
//   - peticion sin x-claude-code-session-id => sin evento,
//   - respuesta sin grupo (passthrough) => no toca el mapa.
// Sin dependencias.
//
//   node tests/smoke-backend-flip.js [ruta/al/claude-router.js]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROUTER = process.argv[2] || path.join(__dirname, '..', 'plugins', 'local-router', 'bin', 'claude-router.js');
const P_LLM = 18931, P_ANT = 18932, P_ROUTER = 18934;
const FLIP_DIR = '/tmp/backend-flip-smoke';
const FLIP_FILE = path.join(FLIP_DIR, 'backend-events.jsonl');

const llm = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const group = JSON.parse(b || '{}').group || 'qwen38-flash-next';
    res.writeHead(200, { 'content-type': 'application/json',
      'x-litellm-model-group': group, 'x-litellm-attempted-fallbacks': group.startsWith('alibaba-') ? '1' : '0' });
    res.end(JSON.stringify({ who: 'llm', ok: true }));
  });
});
const ant = http.createServer((req, res) => { res.writeHead(200); res.end('{}'); });

function post(bodyObj, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const rq = http.request({ host: '127.0.0.1', port: P_ROUTER, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...extraHeaders },
      timeout: 5000 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode }));
    });
    rq.on('error', reject);
    rq.end(body);
  });
}

let fails = 0, checks = 0;
function check(name, cond, extra) { checks++; if (!cond) { fails++; console.log(`FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); } else console.log(`ok   ${name}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const msg = (group) => ({ model: 'qwen38-flash-next', max_tokens: 10, group, messages: [{ role: 'user', content: 'hola' }] });
const SID = { 'x-claude-code-session-id': 'sid-flip-1' };
const events = () => fs.existsSync(FLIP_FILE)
  ? fs.readFileSync(FLIP_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

(async () => {
  fs.rmSync(FLIP_DIR, { recursive: true, force: true });
  const envFile = '/tmp/backend-flip-smoke-env';
  fs.writeFileSync(envFile, `export ANTHROPIC_BASE_URL=http://127.0.0.1:${P_LLM}\nexport ANTHROPIC_AUTH_TOKEN=sk-litellm-fake\n`);
  await new Promise(r => llm.listen(P_LLM, '127.0.0.1', r));
  await new Promise(r => ant.listen(P_ANT, '127.0.0.1', r));
  const router = spawn(process.execPath, [ROUTER], {
    env: { ...process.env, CLAUDE_ROUTER_PORT: String(P_ROUTER), CLAUDE_ROUTER_ENV_FILE: envFile,
      CLAUDE_ROUTER_ANTHROPIC_URL: `http://127.0.0.1:${P_ANT}`,
      CLAUDE_ROUTER_ROUTING_CONFIG_URL: 'http://127.0.0.1:1/nadie',
      CLAUDE_ROUTER_FLIP_DIR: FLIP_DIR },
    stdio: ['ignore', 'pipe', 'pipe'] });
  router.stderr.on('data', d => process.stderr.write(`  [router!] ${d}`));
  const out = []; router.stdout.on('data', d => out.push(String(d)));
  for (let i = 0; i < 40; i++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: P_ROUTER, path: '/-/health' }, r => { r.resume(); r.on('end', res); }).on('error', rej)); break; } catch { await sleep(250); } }

  try {
    // linea de base: primera peticion en local => sin evento
    await post(msg('qwen38-flash-next'), SID); await sleep(150);
    check('primer avistamiento no emite evento', events().length === 0, events());
    // repeticion local => sin evento
    await post(msg('qwen38-flash-next'), SID); await sleep(150);
    check('repeticion local no emite evento', events().length === 0, events());
    // flip a alibaba
    await post(msg('alibaba-q38-flash'), SID); await sleep(150);
    let ev = events();
    check('flip local->alibaba emite evento', ev.length === 1 && ev[0].from === 'local' && ev[0].to === 'alibaba'
      && ev[0].group === 'alibaba-q38-flash' && ev[0].fallbacks === 1 && ev[0].sid === 'sid-flip-1', ev);
    // recuperacion
    await post(msg('qwen38-flash-next'), SID); await sleep(150);
    ev = events();
    check('flip alibaba->local (recuperacion)', ev.length === 2 && ev[1].from === 'alibaba' && ev[1].to === 'local', ev);
    // otra sesion no contamina la primera
    await post(msg('alibaba-q38-flash'), { 'x-claude-code-session-id': 'sid-flip-2' }); await sleep(150);
    ev = events();
    check('sesion distinta tiene su propia linea de base (sin evento)', ev.length === 2, ev);
    // sin sid => sin evento
    await post(msg('qwen38-flash-next')); await sleep(150);
    check('peticion sin session-id no emite', events().length === 2, events());
    check('el journal tiene la linea flip', out.join('').includes('flip local -> alibaba'), out.join(''));
  } catch (e) {
    fails++; console.log('FAIL excepcion', e.message);
  } finally {
    router.kill(); llm.close(); ant.close();
  }
  console.log(`\n${checks - fails}/${checks} checks OK`);
  process.exit(fails ? 1 : 0);
})();

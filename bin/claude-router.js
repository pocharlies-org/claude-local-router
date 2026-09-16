#!/usr/bin/env node
'use strict';
// claude-router — proxy local por-modelo para Claude Code.
//
//   POST /v1/messages{,/count_tokens} con model ~ LOCAL_RE  -> LiteLLM (auth sustituida por la key
//                                                              virtual; el OAuth NUNCA sale hacia LiteLLM)
//   todo lo demas                                          -> api.anthropic.com tal cual (passthrough,
//                                                              cabeceras intactas, cuerpo byte a byte)
//
// Solo escucha en 127.0.0.1. Sin dependencias. Config por entorno:
//   CLAUDE_ROUTER_PORT       (18791)
//   CLAUDE_ROUTER_LOCAL_RE   ('^(qwen|tooling|or-|litellm/)', case-insensitive)
//   CLAUDE_ROUTER_ENV_FILE   (~/.config/claude-local/env: export ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)
//   CLAUDE_ROUTER_MIXED      ('strip') strip | block | off  -- guardrail historial local -> Anthropic
//                            strip: borra las claves prohibidas del payload y reenvia igual
//                            block: (comportamiento viejo) corta con 400 y manda a la skill de limpieza
//                            off:   no toca nada, reenvia el bloque envenenado tal cual (para depurar)
//   CLAUDE_ROUTER_BAD_KEYS   ('provider_specific_fields') claves prohibidas, separadas por comas
//   CLAUDE_ROUTER_CLOUD_FALLBACK_MODEL ('' = off) modelo LOCAL al que desviar cuando la CUOTA de
//                                   Anthropic se agota (decide la respuesta de Anthropic, no un reloj).
//   CLAUDE_ROUTER_CLOUD_FALLBACK_RE   ('^claude-fable') que modelos de Anthropic son divertibles.
//   CLAUDE_ROUTER_CLOUD_COOLDOWN_S    (300) segundos de breaker tras un error de cuota: durante el
//                                   breaker los divertibles van directos a local sin pagar el error.
//   CLAUDE_ROUTER_ANTHROPIC_URL       (https://api.anthropic.com) destino Anthropic (test).
//   CLAUDE_ROUTER_FALLBACK_MODEL    ('claude-opus-5') modelo de Anthropic al que desviar cuando el
//                                   backend local esta saturado DE VERDAD. 'off' (o vacio) lo desactiva.
//   CLAUDE_ROUTER_FALLBACK_BETA     ('context-1m-2025-08-07') betas que se anaden al desviar
//   CLAUDE_ROUTER_FALLBACK_SLOW_MS  (180000) una peticion local cuenta como ATASCADA a partir de aqui
//   CLAUDE_ROUTER_FALLBACK_STALLED  (3) cuantas atascadas a la vez disparan el desvio
//   CLAUDE_ROUTER_PANEL_URL         (http://127.0.0.1:8799/v1/accounts) reloj UNICO de cuota del host
//   CLAUDE_ROUTER_QUOTA_EMAIL       (oauthAccount de ~/.claude.json) cuenta cuya cuota manda
//   CLAUDE_ROUTER_FALLBACK_MAX_UTIL (0.9) si la ventana de 5h o la de 7d pasa de eso, NO se desvia
//   CLAUDE_ROUTER_QUOTA_STALE_MS    (1500000 = 25 min, el mismo umbral del panel) lectura vieja = NO desviar
// SIGHUP recarga el fichero de entorno. GET /-/health devuelve contadores.
const http = require('http'), https = require('https'), fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');

const PORT = Number(process.env.CLAUDE_ROUTER_PORT || 18791);
const LOCAL_RE = new RegExp(process.env.CLAUDE_ROUTER_LOCAL_RE || '^(qwen|tooling|or-|litellm/)', 'i');
const ENV_FILE = process.env.CLAUDE_ROUTER_ENV_FILE || path.join(os.homedir(), '.config', 'claude-local', 'env');
const ANTHROPIC = new URL(process.env.CLAUDE_ROUTER_ANTHROPIC_URL || 'https://api.anthropic.com');

// --- desvio a Anthropic cuando el backend local esta saturado -------------------
// El 14-09-2026 dieciseis sesiones de Claude Code contra la UNICA instancia de
// qwen38-flash-next dejaron la latencia en p50 98s / p90 306s / max 851s. El cliente se
// cansa de esperar y el turno muere MUDO: el .jsonl acaba en un tool_result, sin mensaje
// del asistente detras y sin ningun error grabado, y la sesion se queda parada. El router
// lo ve antes que nadie, porque sabe cuantas peticiones locales tiene en vuelo y desde cuando.
//
// La senal es VIVA: cuantas peticiones locales llevan YA mas de SLOW_MS sin terminar. No se
// usa la media de lo ya completado porque llega tarde -- una peticion de 9 minutos no aporta
// su muestra hasta el minuto 9, cuando el dano ya esta hecho. Y se recupera sola: en cuanto
// la cola drena, el contador baja y las peticiones vuelven al modelo local.
//
// El id de modelo es el de la API (`claude-opus-5`), NO el del CLI: `claude-opus-5[1m]` da
// 404 not_found_error -- el sufijo `[1m]` es una convencion del cliente y la ventana de 1M se
// pide por cabecera. Se anade al desviar porque las sesiones locales corren con
// CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144 (la ventana real de qwen38-flash-next), que NO cabe
// en los 200k estandar de Opus. La credencial y el resto de cabeceras van intactas: es el
// OAuth de la cuenta del usuario, el mismo con el que ya habla el passthrough.
const FALLBACK_MODEL = (() => {
  const v = process.env.CLAUDE_ROUTER_FALLBACK_MODEL ?? 'claude-opus-5';
  return /^(off|no|0)$/i.test(v.trim()) ? '' : v.trim();
})();
const FALLBACK_BETA = (process.env.CLAUDE_ROUTER_FALLBACK_BETA ?? 'context-1m-2025-08-07')
  .split(',').map((x) => x.trim()).filter(Boolean);
const FALLBACK_SLOW_MS = Number(process.env.CLAUDE_ROUTER_FALLBACK_SLOW_MS || 180000);
const FALLBACK_STALLED = Number(process.env.CLAUDE_ROUTER_FALLBACK_STALLED || 3);
const localInFlight = new Set(); // una entrada { t0 } por peticion local viva

// --- desvio a LOCAL cuando la CUOTA de Anthropic se agota (15-09-2026) ----------------
// El planificador de la compania (tech-lead) va pinneado a claude-fable-5-1, pero la cuota
// semanal de la cuenta se agota y el turno moria con el limite a la vista. El CEO pidio: cada
// spawn INTENTA fable y SOLO cae a qwen38-flash-next si no queda cuota. Aqui no decide un reloj
// (el del panel envejece horas, y el gate local->Opus de abajo se apaga cuando no lo ve fresco):
// decide la RESPUESTA de Anthropic. Se pasa tal cual; si el error es de CUOTA (no overload: un
// 529 sigue siendo error visible, no se enmascara) se reintenta la MISMA peticion contra LiteLLM
// y el breaker abre COOLDOWN_S para no pagar el error en cada turno. Al vencer se sonda otra vez:
// cuando la cuota vuelve, el modelo vuelve solo. No hace falta el gate de gasto de abajo: el
// destino es el backend local, gratis; el riesgo es de calidad, no de bolsillo.
const CLOUD_FALLBACK_MODEL = (() => {
  const v = (process.env.CLAUDE_ROUTER_CLOUD_FALLBACK_MODEL || '').trim();
  return /^(off|no|0)$/i.test(v) ? '' : v;
})();
const CLOUD_FALLBACK_RE = new RegExp(process.env.CLAUDE_ROUTER_CLOUD_FALLBACK_RE || '^claude-fable', 'i');
const CLOUD_COOLDOWN_MS = Number(process.env.CLAUDE_ROUTER_CLOUD_COOLDOWN_S || 300) * 1000;
const cloudBreaker = { until: 0, reason: '' };

// Un 4xx con forma de CUOTA. Deliberadamente NO entra el 529 overloaded_error (caida
// transitoria: enmascararla con el local ocultaria que Anthropic esta mal) ni un 400 de
// payload (no es cuota, reintentarlo contra local daria el mismo 400). Casa los tres
// spellings medidos en el panel del host: usage_limit_reached, "hit your weekly/session
// limit" y rate_limit_error con el texto del limite.
function isQuotaError(status, text) {
  if (status < 400 || status > 499) return false;
  return /usage_limit|hit your (weekly|session|daily) limit|out of (extra )?usage|rate_limit_error/i.test(text);
}

function stalledLocal() {
  const now = Date.now();
  let n = 0;
  for (const e of localInFlight) if (now - e.t0 >= FALLBACK_SLOW_MS) n++;
  return n;
}

// --- gate de cuota: solo se desvia si QUEDA cuota ---------------------------------
// El desvio gasta la suscripcion de Anthropic y el cliente NO lo ve: VS Code sigue
// anunciando qwen38 porque el router reescribe `model` cuando el CLI ya decidio. El
// 14-09 salto 129 veces en 24 h y 37 de esas peticiones ni siquiera sirvieron (28x400,
// 18x429, 2x401). Decide sobre el RELOJ UNICO de cuota del host: el panel :8799
// (plugin opencode-claude), que es el unico que pregunta a Anthropic y lo hace en
// temporizador. Preguntar aqui a /api/oauth/usage seria montar el SEGUNDO reloj de la
// maquina, y el segundo reloj es lo que produce los 429 (regla del operador, 11-09-2026).
//
// Fail-closed: sin panel, sin fila para este login, sin numero, o con la lectura vieja
// -> NO se desvia. La cuota es dinero; gastar sin saber hace mas daño que no desviar,
// que solo devuelve el comportamiento de antes de existir el fallback.
const PANEL_URL = process.env.CLAUDE_ROUTER_PANEL_URL || 'http://127.0.0.1:8799/v1/accounts';
const FALLBACK_MAX_UTIL = Number(process.env.CLAUDE_ROUTER_FALLBACK_MAX_UTIL || 0.9);
const QUOTA_STALE_MS = Number(process.env.CLAUDE_ROUTER_QUOTA_STALE_MS || 25 * 60 * 1000); // el del panel
const QUOTA_TTL_S = 60, QUOTA_TTL_ERROR_S = 600;   // reintentar al minuto tras un error ES el 429

// La cuenta que manda es la del login de ~/.claude, porque la credencial que viaja en el
// desvio es la del cliente. El panel empareja por LOGIN y no por config dir: ~/.claude no
// esta en su registro, pero su cuenta si, montada en otro dir (mismo criterio que
// claude-rc-status.py).
function hostEmail() {
  if (process.env.CLAUDE_ROUTER_QUOTA_EMAIL) return process.env.CLAUDE_ROUTER_QUOTA_EMAIL.trim().toLowerCase();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    return String((j.oauthAccount || {}).emailAddress || '').trim().toLowerCase();
  } catch { return ''; }
}
const HOST_EMAIL = hostEmail();

const quota = { ts: 0, allow: false, reason: 'sin consultar', detail: '', ttl: 0, inflight: null };

function panelFetch() {
  return new Promise((resolve, reject) => {
    const rq = http.get(PANEL_URL, { timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`panel HTTP ${res.statusCode}`)); }
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout 3s')));
    rq.on('error', reject);
  });
}

function evalQuota(panel) {
  const rows = (panel && Array.isArray(panel.data)) ? panel.data : [];
  if (!HOST_EMAIL) return { allow: false, reason: 'sin login local (~/.claude.json)' };
  const row = rows.find((r) => String(((r || {}).identity || {}).email || '').toLowerCase() === HOST_EMAIL);
  if (!row) return { allow: false, reason: `el panel no tiene fila para ${HOST_EMAIL}` };
  const q = row.quota || {}, w = q.windows || {};
  const u5 = (w.fiveHour || {}).utilization, u7 = (w.sevenDay || {}).utilization;
  const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : '?');
  if (typeof u5 !== 'number' && typeof u7 !== 'number') return { allow: false, reason: 'el panel no da utilization' };
  const age = typeof row.quotaDataAgeMs === 'number' ? row.quotaDataAgeMs
            : (typeof q.fetchedAt === 'number' ? Date.now() - q.fetchedAt : Infinity);
  const d = `5h=${pct(u5)} 7d=${pct(u7)} edad=${Math.round(age / 60000)}min`;
  if (age > QUOTA_STALE_MS) return { allow: false, reason: `lectura vieja (${d}, tope ${Math.round(QUOTA_STALE_MS / 60000)}min)`, detail: d };
  if (q.status === 'rejected' || (row.rateLimit || {}).limited) return { allow: false, reason: `cuota rechazada (${d})`, detail: d };
  const maxU = Math.max(typeof u5 === 'number' ? u5 : 0, typeof u7 === 'number' ? u7 : 0);
  if (maxU >= FALLBACK_MAX_UTIL) return { allow: false, reason: `sin margen: max=${Math.round(maxU * 100)}% >= ${Math.round(FALLBACK_MAX_UTIL * 100)}% (${d})`, detail: d };
  return { allow: true, reason: `hay cuota (${d})`, detail: d };
}

function quotaGate() {
  if (quota.ts && Date.now() - quota.ts < quota.ttl * 1000) return Promise.resolve(quota);
  if (quota.inflight) return quota.inflight;
  quota.inflight = panelFetch()
    .then((panel) => {
      const r = evalQuota(panel);
      Object.assign(quota, { ts: Date.now(), allow: r.allow, reason: r.reason, detail: r.detail || '', ttl: QUOTA_TTL_S });
      return quota;
    })
    .catch((e) => {
      Object.assign(quota, { ts: Date.now(), allow: false, reason: `panel no contesta: ${e.message}`, ttl: QUOTA_TTL_ERROR_S });
      return quota;
    })
    .finally(() => { quota.inflight = null; });
  return quota.inflight;
}

function log(s) { process.stdout.write(`${new Date().toISOString()} ${s}\n`); }

function loadLiteLLM() {
  const out = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*export\s+([A-Z_]+)=["']?([^"'#]*)["']?/);
    if (m) out[m[1]] = m[2].trim();
  }
  if (!out.ANTHROPIC_BASE_URL || !out.ANTHROPIC_AUTH_TOKEN) throw new Error(`${ENV_FILE}: faltan ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN`);
  return { url: new URL(out.ANTHROPIC_BASE_URL), key: out.ANTHROPIC_AUTH_TOKEN };
}
let LITELLM = loadLiteLLM();
process.on('SIGHUP', () => { try { LITELLM = loadLiteLLM(); log(`reload ok litellm=${LITELLM.url.host}`); } catch (e) { log(`reload ERROR ${e.message}`); } });

const agents = { 'https:': new https.Agent({ keepAlive: true }), 'http:': new http.Agent({ keepAlive: true }) };
const stats = { started: new Date().toISOString(), anthropic: 0, litellm: 0, errors: 0, blocked: 0, cleaned: 0, models: 0, fallbacks: 0, fallback_blocked: 0, cloud_fallbacks: 0 };

// --- guardrail: historial del modelo LOCAL hacia Anthropic ----------------------
// Los tool_use que emite LiteLLM (capa OpenAI-compat) llevan claves extra que la API de
// Anthropic rechaza con 400 "Extra inputs are not permitted". El error no es reintentable,
// asi que salta el fallback a Sonnet -- que falla igual, porque el bloque envenenado sigue
// en el historial. Resultado: la sesion queda inservible con el cartel enganoso
// "Opus 5 no esta disponible". Por defecto se limpia aqui mismo, en caliente, antes de salir
// a Anthropic: es lo mismo que hace la skill claude-session-clean-local sobre el .jsonl, pero
// por peticion y sin tocar el fichero en disco ni requerir cerrar la sesion.
const MIXED = (process.env.CLAUDE_ROUTER_MIXED || 'strip').toLowerCase();
const BAD_KEYS = (process.env.CLAUDE_ROUTER_BAD_KEYS || 'provider_specific_fields')
  .split(',').map((x) => x.trim()).filter(Boolean);
const CLEAN_SKILL = 'claude-session-clean-local';
const MAX_HITS = 5;

// Mira SOLO claves de bloques estructurados. Nunca busca la cadena en el texto: una sesion
// que hable de este gotcha (como la que lo descubrio) se auto-bloquearia.
// Con strip=true borra las claves encontradas (TODAS, sin tope) y devuelve como hits solo
// las primeras MAX_HITS para el log; sin strip, se para en el primer hit de cada bloque
// (el conteo no importa, solo saber que hay veneno).
function scanLocalArtifacts(payload, strip) {
  const hits = [];
  const msgs = payload && Array.isArray(payload.messages) ? payload.messages : [];
  for (let i = 0; i < msgs.length; i++) {
    const c = msgs[i] && msgs[i].content;
    if (!Array.isArray(c)) continue;
    for (let j = 0; j < c.length; j++) {
      const b = c[j];
      if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
      let hitKey = null;
      for (const k of BAD_KEYS) {
        if (Object.prototype.hasOwnProperty.call(b, k)) {
          if (!hitKey) hitKey = k;
          if (strip) delete b[k]; else break;
        }
      }
      if (hitKey && hits.length < MAX_HITS) {
        const id = b.id || b.tool_use_id || '';
        hits.push(`messages.${i}.content.${j}.${b.type || '?'}.${hitKey}${id ? ` (id ${id})` : ''}`);
      }
    }
  }
  return hits;
}

function blockMixed(res, model, hits) {
  stats.blocked++;
  const msg =
    `BLOQUEADO por claude-router: esta sesion arrastra historial del modelo LOCAL y no puede ir a NINGUN ` +
    `modelo de Anthropic. Opus NO esta caido ni sin cuota, y el fallback a Sonnet falla por lo mismo. ` +
    `Limpia la sesion con la skill \`${CLEAN_SKILL}\` y sigue en Opus, ` +
    `o vuelve al modelo local (/model qwen38-flash-next). ` +
    `Causa: los tool_use de LiteLLM llevan claves que la API de Anthropic rechaza con ` +
    `400 "Extra inputs are not permitted", y el fallback a Sonnet reenvia el mismo bloque y falla igual. ` +
    `Bloques: ${hits.join(', ')}${hits.length >= MAX_HITS ? ' (+mas)' : ''}. ` +
    `Escape: CLAUDE_ROUTER_MIXED=off.`;
  if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: msg } }));
}


function fail(res, status, msg) {
  stats.errors++;
  if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `claude-router: ${msg}` } }));
}

function forward(req, res, target, headers, body, tag, track) {
  const t0 = Date.now();
  const entry = track ? { t0 } : null;
  if (entry) localInFlight.add(entry);
  let done = false;
  const finish = () => { if (!done) { done = true; if (entry) localInFlight.delete(entry); } };
  const mod = target.protocol === 'https:' ? https : http;
  const up = mod.request({
    protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, agent: agents[target.protocol],
    method: req.method, path: req.url, headers: { ...headers, host: target.host },
  }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
    ur.on('end', () => { finish(); log(`${tag} ${ur.statusCode} ${Date.now() - t0}ms ${req.method} ${req.url}`); });
    ur.on('error', finish); // respuesta cortada a medias: no dejar la entrada colgada como "atascada"
  });
  up.on('error', (e) => { finish(); log(`${tag} ERROR ${e.code || ''} ${e.message}`); fail(res, 502, `${target.host}: ${e.message}`); });
  res.on('close', () => { if (!res.writableFinished) { finish(); up.destroy(); } }); // el cliente se fue: cancela arriba
  if (body !== undefined) up.end(body); else req.pipe(up);
}

// Como `forward`, pero con los 4xx se detiene antes de reenviarlos: los buffer (son JSON
// pequeno) y pregunta. Si `onQuota` los reclama como cuota, no se emite nada al cliente:
// `onQuota` reintenta contra el otro backend. Un 2xx (incluido el SSE del stream) va tal
// cual, sin buffer. Solo se usa en el camino Anthropic->divertible; el resto del trafico
// sigue por `forward`, que no toca el stream.
function forwardSniffQuota(req, res, target, headers, body, tag, onQuota) {
  const t0 = Date.now();
  const mod = target.protocol === 'https:' ? https : http;
  const up = mod.request({
    protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, agent: agents[target.protocol],
    method: req.method, path: req.url, headers: { ...headers, host: target.host },
  }, (ur) => {
    if (ur.statusCode < 400) {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
      ur.on('end', () => log(`${tag} ${ur.statusCode} ${Date.now() - t0}ms ${req.method} ${req.url}`));
      ur.on('error', () => {}); // stream cortado: el cliente ya tiene cabeceras
      return;
    }
    const ch = [];
    ur.on('data', (c) => ch.push(c));
    ur.on('end', () => {
      const raw = Buffer.concat(ch);
      // El cuerpo de error llega COMPRIMIDO (br/gzip — medido 15-09: el sniff en crudo no
      // casaba el regex y el 429 de cuota se reenviaba tal cual). Se descomprime SOLO para
      // la decision; al cliente se le reenvian los bytes originales con sus cabeceras.
      let text = '';
      const enc = String(ur.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc.includes('br')) text = zlib.brotliDecompressSync(raw).toString('utf8');
        else if (enc.includes('gzip')) text = zlib.gunzipSync(raw).toString('utf8');
        else if (enc.includes('deflate')) text = zlib.inflateSync(raw).toString('utf8');
        else text = raw.toString('utf8');
      } catch { text = ''; } // no decodea o pasa de 64 KiB: no se reclama, se reenvia igual
      // El tope de 64 KiB limita la DECISION (un error de cuota es JSON de cientos de bytes),
      // nunca el reenvio: los bytes originales salen siempre intactos.
      if (raw.length <= 65536 && text && onQuota(ur.statusCode, text)) {
        log(`${tag} ${ur.statusCode} ${Date.now() - t0}ms ${req.method} ${req.url} -> reintentado en LOCAL (cuota)`);
        return; // onQuota ya escribio en `res`
      }
      res.writeHead(ur.statusCode, ur.headers);
      res.end(raw);
      log(`${tag} ${ur.statusCode} ${Date.now() - t0}ms ${req.method} ${req.url}`);
    });
    ur.on('error', () => fail(res, 502, `${target.host}: upstream error`));
  });
  up.on('error', (e) => fail(res, 502, `${target.host}: ${e.message}`));
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  if (body !== undefined) up.end(body); else up.end();
}

const server = http.createServer((req, res) => {
  if (req.url === '/-/health') {
    // El gate se consulta AQUI, no solo al desviar: el problema no era solo gastar cuota,
    // era gastarla sin que nadie lo viera. Sin esto habria que esperar a una saturacion
    // para saber por que el desvio esta apagado.
    return quotaGate().then((q) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: PORT, gateway: LITELLM.url.host, local_re: LOCAL_RE.source, mixed: MIXED, bad_keys: BAD_KEYS,
        fallback_model: FALLBACK_MODEL || 'off', fallback_beta: FALLBACK_BETA, fallback_slow_ms: FALLBACK_SLOW_MS, fallback_stalled: FALLBACK_STALLED,
        fallback_allowed: q.allow, fallback_reason: q.reason, fallback_quota: q.detail || null,
        cloud_fallback_model: CLOUD_FALLBACK_MODEL || 'off', cloud_fallback_re: CLOUD_FALLBACK_RE.source,
        cloud_breaker_until: cloudBreaker.until ? new Date(cloudBreaker.until).toISOString() : null,
        cloud_breaker_reason: cloudBreaker.reason || null,
        quota_email: HOST_EMAIL || null, quota_panel: PANEL_URL,
        local_inflight: localInFlight.size, local_stalled: stalledLocal(), ...stats }));
    }).catch(() => fail(res, 500, 'health'));
  }
  // GET /v1/models: el CLI de Claude valida --model contra esta lista (arranque frio y
  // subagentes la vuelven a pedir). Sin handler cae en el passthrough a api.anthropic.com,
  // que no lista los modelos locales -> el CLI corta con "unrecognized_model qwen38-flash-next"
  // de forma intermitente. Servimos aqui los modelos locales (CLAUDE_ROUTER_MODELS).
  if (req.method === 'GET' && /^\/v1\/models(\?|$)/.test(req.url)) {
    const ids = (process.env.CLAUDE_ROUTER_MODELS || 'qwen38-flash-next,qwen38-flash-next-uncensored')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const data = ids.map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' }));
    stats.models++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data, has_more: false, first_id: ids[0], last_id: ids[ids.length - 1] }));
  }
  const routed = req.method === 'POST' && /^\/v1\/messages(\/count_tokens)?(\?|$)/.test(req.url);
  if (!routed) {
    const h = { ...req.headers }; delete h.host;
    stats.anthropic++;
    return forward(req, res, ANTHROPIC, h, undefined, 'ANTHROPIC(passthrough)');
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let payload = null;
    try { payload = JSON.parse(body.toString('utf8')); } catch {} // no parsea: se reenvia tal cual
    const model = (payload && payload.model) || '?';
    const h = { ...req.headers }; delete h.host; delete h['transfer-encoding']; h['content-length'] = String(body.length);
    if (LOCAL_RE.test(model)) {
      // count_tokens NO se desvia: es barato, no hace cola, y Anthropic no conoce el modelo local.
      const divertible = Boolean(FALLBACK_MODEL) && payload !== null && !/count_tokens/.test(req.url);
      const stalled = divertible ? stalledLocal() : 0;
      const toLiteLLM = () => {
        delete h['x-api-key']; delete h.authorization;
        h.authorization = `Bearer ${LITELLM.key}`;
        stats.litellm++;
        return forward(req, res, LITELLM.url, h, body, `LITELLM  model=${model}`, true);
      };
      if (divertible && stalled >= FALLBACK_STALLED) {
        // Antes de gastar hay que tener cuota: el desvio paga la suscripcion del usuario y
        // el cliente no se entera (ver el gate de cuota mas arriba).
        return quotaGate().then((g) => {
          if (!g.allow) {
            stats.fallback_blocked++;
            log(`FALLBACK-SIN-CUOTA model=${model} saturacion=${stalled} NO se desvia (${g.reason}) -> sigue LOCAL`);
            return toLiteLLM();
          }
          // El strip es OBLIGATORIO aqui, pase lo que pase con MIXED: el historial que arrastra la
          // sesion lo escribio el modelo local y Anthropic lo rechaza con 400 "Extra inputs are not
          // permitted" (ver el guardrail de arriba). Sin esto el desvio falla siempre.
          const hits = scanLocalArtifacts(payload, true);
          const original = payload.model;
          payload.model = FALLBACK_MODEL;
          const outBody = Buffer.from(JSON.stringify(payload));
          h['content-length'] = String(outBody.length); // credencial del cliente INTACTA: es la cuenta del usuario
          const betas = (h['anthropic-beta'] || '').split(',').map((x) => x.trim()).filter(Boolean);
          for (const b of FALLBACK_BETA) if (!betas.includes(b)) betas.push(b);
          if (betas.length) h['anthropic-beta'] = betas.join(',');
          stats.fallbacks++; stats.anthropic++;
          if (hits.length) stats.cleaned++;
          log(`FALLBACK model=${original} -> ${FALLBACK_MODEL} saturacion=${stalled} atascadas >${Math.round(FALLBACK_SLOW_MS / 1000)}s ` +
              `de ${localInFlight.size} en vuelo cuota="${g.reason}"${hits.length ? ` limpiados ${hits.length}+ bloque(s)` : ''}`);
          return forward(req, res, ANTHROPIC, h, outBody, `ANTHROPIC(fallback) model=${FALLBACK_MODEL}`);
        });
      }
      return toLiteLLM();
    }
    let outBody = body;
    if (MIXED === 'block' && payload) {
      const hits = scanLocalArtifacts(payload, false);
      if (hits.length) {
        log(`BLOQUEADO model=${model} ${req.url} historial-local ${hits.length} bloque(s): ${hits[0]}`);
        return blockMixed(res, model, hits);
      }
    } else if (MIXED === 'strip' && payload) {
      const hits = scanLocalArtifacts(payload, true);
      if (hits.length) {
        stats.cleaned++;
        outBody = Buffer.from(JSON.stringify(payload));
        h['content-length'] = String(outBody.length);
        log(`LIMPIADO model=${model} ${req.url} historial-local ${hits.length}+ bloque(s): ${hits[0]}`);
      }
    }
    // --- Anthropic divertible: se pasa, y SOLO si la respuesta dice "cuota" se cae a local ---
    // (ver el bloque CLOUD_FALLBACK arriba). count_tokens fuera: es barato y un error ahi no
    // mata ningun turno. Con el breaker abierto no se paga ni el error: va directo a local.
    if (CLOUD_FALLBACK_MODEL && payload !== null && CLOUD_FALLBACK_RE.test(model) && !/count_tokens/.test(req.url)) {
      const toLocalQuota = (why) => {
        const original = payload.model;
        payload.model = CLOUD_FALLBACK_MODEL;
        const out = Buffer.from(JSON.stringify(payload));
        h['content-length'] = String(out.length);
        delete h['x-api-key']; delete h.authorization; // la credencial del cliente no sale hacia LiteLLM
        h.authorization = `Bearer ${LITELLM.key}`;
        stats.litellm++; stats.cloud_fallbacks++;
        log(`CLOUD-FALLBACK model=${original} -> ${CLOUD_FALLBACK_MODEL} (${why})`);
        return forward(req, res, LITELLM.url, h, out, `LITELLM(cuota) model=${CLOUD_FALLBACK_MODEL}`);
      };
      if (Date.now() < cloudBreaker.until) return toLocalQuota(`breaker abierto, ${Math.ceil((cloudBreaker.until - Date.now()) / 1000)}s mas: ${cloudBreaker.reason}`);
      return forwardSniffQuota(req, res, ANTHROPIC, h, outBody, `ANTHROPIC model=${model}`, (status, text) => {
        if (!isQuotaError(status, text)) return false; // 400 de payload, 401, 529...: se reenvia tal cual
        cloudBreaker.until = Date.now() + CLOUD_COOLDOWN_MS;
        cloudBreaker.reason = `HTTP ${status}: ${text.slice(0, 140).replace(/\s+/g, ' ')}`;
        log(`CUOTA-MUERTA model=${model}: breaker ${Math.round(CLOUD_COOLDOWN_MS / 1000)}s (${cloudBreaker.reason})`);
        toLocalQuota(`cuota agotada (HTTP ${status})`);
        return true;
      });
    }
    stats.anthropic++;
    return forward(req, res, ANTHROPIC, h, outBody, `ANTHROPIC model=${model}`);
  });
});
server.keepAliveTimeout = 75000; server.headersTimeout = 80000;
server.listen(PORT, '127.0.0.1', () => log(`listen 127.0.0.1:${PORT} litellm=${LITELLM.url.host} local_re=${LOCAL_RE}`));

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
//   CLAUDE_ROUTER_LOCAL_RE   ('^(qwen|tooling|or-|alibaba-|q38-|litellm/)', case-insensitive)
//                            `q38-` son los cuatro perfiles de chat (OWU-50):
//                            q38-flash, q38-flash-think, q38-flash-u, q38-flash-u-think.
//                            Sin rama en esta regex, esos nombres se van a Anthropic
//                            y el CLI corta con 404 (medido el 21-09).
//   CLAUDE_ROUTER_MODELS     lista de /v1/models (default: el set desplegado en el x86,
//                            ver systemd/claude-router.service)
//   CLAUDE_ROUTER_ENV_FILE   (~/.config/claude-local/env: export ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)
//   CLAUDE_ROUTER_MIXED      ('strip') strip | block | off  -- guardrail historial local -> Anthropic
//                            strip: borra las claves prohibidas del payload y reenvia igual
//                            block: (comportamiento viejo) corta con 400 y manda a la skill de limpieza
//                            off:   no toca nada, reenvia el bloque envenenado tal cual (para depurar)
//   CLAUDE_ROUTER_BAD_KEYS   ('provider_specific_fields') claves prohibidas, separadas por comas
//   CLAUDE_ROUTER_ANTHROPIC_URL       (https://api.anthropic.com) destino Anthropic (test).
//   CLAUDE_ROUTER_ROUTING_CONFIG_URL  (http://10.43.80.147:9002/api/model-routing/config)
//                            INFRA-208: config del panel de routing del dashboard. El router
//                            la consulta SOLO en la rama LOCAL_RE y SOLO para la puerta
//                            claude (plan de la sesion = claude -> Anthropic passthrough).
//                            Local-vs-Alibaba NO es competencia del router: eso lo decide el
//                            hook session_router.py dentro de LiteLLM (frontera del mandato 8).
//   CLAUDE_ROUTER_ROUTING_CONFIG_TTL_MS (60000) cache de esa config (patron quotaGate);
//                            inalcanzable/vieja => NO se desvia (fail-safe = comportamiento actual).
//   CLAUDE_ROUTER_CLAUDE_PLAN_MODEL   ('claude-opus-5') modelo Anthropic del desvio plan=claude.
//   CLAUDE_ROUTER_CLAUDE_PLAN_BETA    ('context-1m-2025-08-07'; 'off' lo quita) beta anadida al
//                            desviar: las sesiones locales corren con ventana de 262144 que no
//                            cabe en los 200k estandar.
//   CLAUDE_ROUTER_CLAUDE_PLAN_MAX_TOKENS (64000) tope de max_tokens al desviar (0 = no tocar):
//                            el destino trae SU tope, no hereda el del modelo local (leccion
//                            del desvio por cuota retirado el 17-09).
// NO hay desvio automatico a ningun modelo de Anthropic por saturacion local: ver
// "Por que ya no hay desvio a Opus" en el README. A Opus se va solo si lo elige el usuario.
// La UNICA excepcion es la puerta claude de INFRA-208: no es automatica, es la voluntad
// EXPLICITA del operador en el panel (plan de la sesion = claude), y se loguea por peticion.
// SIGHUP recarga el fichero de entorno. GET /-/health devuelve contadores.
const http = require('http'), https = require('https'), fs = require('fs'), os = require('os'), path = require('path');

const PORT = Number(process.env.CLAUDE_ROUTER_PORT || 18791);
const LOCAL_RE = new RegExp(process.env.CLAUDE_ROUTER_LOCAL_RE || '^(qwen|tooling|or-|alibaba-|q38-|litellm/)', 'i');
const ENV_FILE = process.env.CLAUDE_ROUTER_ENV_FILE || path.join(os.homedir(), '.config', 'claude-local', 'env');
const ANTHROPIC = new URL(process.env.CLAUDE_ROUTER_ANTHROPIC_URL || 'https://api.anthropic.com');

// --- NUNCA se desvia a Anthropic por saturacion local (17-09-2026) --------------------
// Hubo un desvio automatico local -> claude-opus-5 (14-09) y va fuera: media mal y el
// cliente no lo veia. Su senal era "cuantas peticiones locales llevan YA mas de SLOW_MS",
// pero con streaming NINGUNA duracion separa "muerto" de "lento": medido el 17-09, las 10
// peticiones que pasaron de 600s en 6h devolvieron TODAS 200, y la mas larga del dia tardo
// 2089s (35 min) y acabo bien. El request_timeout:600 de LiteLLM NO corta un stream que
// sigue soltando tokens, asi que el umbral caia dentro de la cola sana: 257 desvios en una
// hora, gastando la suscripcion del usuario en peticiones que iban a salir. Y era peor de
// lo que parecia: al desviar, el desvio MISMO descargaba el modelo local, asi que al
// cerrarlo la cola crece y las atascadas suben solas -- se retroalimentaba.
//
// Queda solo lo que decide el usuario: si elige Opus en el picker, eso es passthrough y
// funciona igual. Lo que NO se hace aqui es decidir por el, en silencio.
//
// Si algun dia se vuelve a mirar la saturacion, la senal que si significa "timeout" es el
// TIEMPO SIN RECIBIR UN BYTE (entry.last en cada chunk), no el tiempo desde que empezo.

// --- NO hay desvio a LOCAL por cuota: retirado el 17-09-2026 --------------------------
// Lo hubo (15-09): fable -> qwen38-flash-next cuando el reloj del panel decia que quedaba
// poca cuota. Fuera, por la misma razon que el desvio a Opus: decidia en silencio y el
// cliente no lo veia. Y ademas rompia el turno -- reescribia `model` pero NO `max_tokens`,
// asi que la peticion llegaba al modelo local (262144 de ventana) pidiendo los 64000 de
// salida de fable: el prompt utilizable se quedaba en 198144 y toda sesion por encima moria
// con un 400 ContextWindowExceeded. En bucle, porque el reintento manda el mismo prompt y el
// CLI no compacta hasta los 250k que cree tener; y cambiar de modelo en el picker tampoco la
// salvaba, porque el desvio ocurria DESPUES, aqui. Sesion tapiada sin salida desde dentro.
//
// Si vuelve a hacer falta desviar por cuota, el destino tiene que traer SU ventana y SU tope
// de salida, no heredar los del modelo de origen.

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
const stats = { started: new Date().toISOString(), anthropic: 0, litellm: 0, errors: 0, blocked: 0, cleaned: 0, models: 0, plan_claude: 0 };

// --- puerta claude (INFRA-208 PR 4/4) ------------------------------------------------
// El router decide claude-vs-litellm; el hook de LiteLLM decide local-vs-alibaba. Aqui
// SOLO se consulta el plan de la sesion cuando el modelo pedido es LOCAL: opus/fable son
// passthrough y nunca consultan el mapa (mandato 8 del arquitecto). Plan = claude =>
// Anthropic con el modelo del plan (la sesion local pide qwen38-flash-next, que Anthropic
// no conoce: hay que reescribir el modelo, meter la beta de ventana y topar max_tokens —
// el destino trae SU ventana y SU tope, leccion del desvio por cuota retirado el 17-09).
// Fail-safe: config inalcanzable o vieja => null => sin desvio, comportamiento actual.
const ROUTING_CONFIG_URL = process.env.CLAUDE_ROUTER_ROUTING_CONFIG_URL
  || 'http://10.43.80.147:9002/api/model-routing/config';
const ROUTING_CONFIG_TTL_MS = Number(process.env.CLAUDE_ROUTER_ROUTING_CONFIG_TTL_MS || 60000);
const PLAN_MODEL = process.env.CLAUDE_ROUTER_CLAUDE_PLAN_MODEL || 'claude-opus-5';
const PLAN_BETA = (() => {
  const v = process.env.CLAUDE_ROUTER_CLAUDE_PLAN_BETA ?? 'context-1m-2025-08-07';
  return /^(off|no|0)$/i.test(v.trim()) ? '' : v.trim();
})();
const PLAN_MAX_TOKENS = Number(process.env.CLAUDE_ROUTER_CLAUDE_PLAN_MAX_TOKENS ?? 64000);

const routingCache = { cfg: null, expires: 0, inflight: null };
function routingConfig() {
  const now = Date.now();
  if (now < routingCache.expires) return Promise.resolve(routingCache.cfg);
  if (routingCache.inflight) return routingCache.inflight; // single-flight
  routingCache.inflight = new Promise((resolve) => {
    const done = (cfg) => {
      routingCache.cfg = cfg;
      routingCache.expires = Date.now() + ROUTING_CONFIG_TTL_MS;
      routingCache.inflight = null;
      resolve(cfg);
    };
    const rq = http.get(ROUTING_CONFIG_URL, { timeout: 2000 }, (r) => {
      let buf = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { buf += c; if (buf.length > 65536) r.destroy(); });
      r.on('end', () => {
        try { done(r.statusCode === 200 ? JSON.parse(buf) : null); } catch { done(null); }
      });
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout')));
    rq.on('error', (e) => { log(`routing-config ERROR ${e.message}; fail-safe = sin desvio`); done(null); });
  });
  return routingCache.inflight;
}
function planIsClaude(cfg, sid) {
  if (!cfg || typeof cfg !== 'object') return false;
  const plans = (cfg.session_plans && typeof cfg.session_plans === 'object') ? cfg.session_plans : {};
  // Entrada explicita de la sesion gana SIEMPRE (incluso para decir "no claude").
  if (sid && Object.prototype.hasOwnProperty.call(plans, sid)) return plans[sid] === 'claude';
  // Default solo con sticky activo: misma semantica que el hook de LiteLLM (los flags
  // gobiernan los mecanismos automaticos; sin sticky, el default_plan no aplica).
  return cfg.sticky === true && cfg.default_plan === 'claude';
}

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

function forward(req, res, target, headers, body, tag) {
  const t0 = Date.now();
  const mod = target.protocol === 'https:' ? https : http;
  const up = mod.request({
    protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, agent: agents[target.protocol],
    method: req.method, path: req.url, headers: { ...headers, host: target.host },
  }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
    ur.on('end', () => log(`${tag} ${ur.statusCode} ${Date.now() - t0}ms ${req.method} ${req.url}`));
    // Un stream cortado a medias emite 'error': sin oyente eso es un proceso muerto.
    ur.on('error', (e) => log(`${tag} ERROR stream ${e.message}`));
  });
  up.on('error', (e) => { log(`${tag} ERROR ${e.code || ''} ${e.message}`); fail(res, 502, `${target.host}: ${e.message}`); });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); }); // el cliente se fue: cancela arriba
  if (body !== undefined) up.end(body); else req.pipe(up);
}

// Como `forward`, pero con los 4xx se detiene antes de reenviarlos: los buffer (son JSON
// pequeno) y pregunta. Si `onQuota` los reclama como cuota, no se emite nada al cliente:
// `onQuota` reintenta contra el otro backend. Un 2xx (incluido el SSE del stream) va tal
// cual, sin buffer. Solo se usa en el camino Anthropic->divertible; el resto del trafico
// sigue por `forward`, que no toca el stream.
const server = http.createServer((req, res) => {
  if (req.url === '/-/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, port: PORT, litellm: LITELLM.url.host, local_re: LOCAL_RE.source,
      mixed: MIXED, bad_keys: BAD_KEYS, ...stats }));
  }
  // GET /v1/models: el CLI de Claude valida --model contra esta lista (arranque frio y
  // subagentes la vuelven a pedir). Sin handler cae en el passthrough a api.anthropic.com,
  // que no lista los modelos locales -> el CLI corta con "unrecognized_model qwen38-flash-next"
  // de forma intermitente. Servimos aqui los modelos locales (CLAUDE_ROUTER_MODELS).
  if (req.method === 'GET' && /^\/v1\/models(\?|$)/.test(req.url)) {
    const ids = (process.env.CLAUDE_ROUTER_MODELS
      // Default = el set que la unidad systemd del x86 ya pinneaba por entorno
      // (drift reconciliado, INFRA-208): instalar desde main reproduce lo desplegado
      // sin depender del env de la unidad. Los cuatro `q38-flash*` son los perfiles
      // de chat de OWU-50 (los mismos que ve Open WebUI).
      || 'qwen38-flash-next,qwen38-flash-next-uncensored,tooling,alibaba-q38-flash,alibaba-q38-max,'
        + 'q38-flash,q38-flash-think,q38-flash-u,q38-flash-u-think')
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
    // Camino Anthropic: passthrough OAuth + guardrail MIXED (strip/block del
    // historial local envenenado). Tambien lo usa la puerta claude de INFRA-208.
    const sendAnthropic = (hdrs, inBody, tag) => {
      let outBody = inBody;
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
          // payload ya lleva los cambios del desvio (si los hubo); re-serializar
          // aqui mantiene strip + desvio en el MISMO body.
          outBody = Buffer.from(JSON.stringify(payload));
          hdrs['content-length'] = String(outBody.length);
          log(`LIMPIADO model=${model} ${req.url} historial-local ${hits.length}+ bloque(s): ${hits[0]}`);
        }
      }
      stats.anthropic++;
      return forward(req, res, ANTHROPIC, hdrs, outBody, tag);
    };
    const sendLocal = () => {
      // Local es local, siempre. Si el modelo local esta saturado el turno tarda o se queda
      // mudo, y eso es VISIBLE: es el problema real, y taparlo con la suscripcion del usuario
      // era el desvio que va fuera (ver arriba). count_tokens tampoco se toca.
      delete h['x-api-key']; delete h.authorization;
      h.authorization = `Bearer ${LITELLM.key}`;
      stats.litellm++;
      return forward(req, res, LITELLM.url, h, body, `LITELLM  model=${model}`);
    };
    // Puerta claude (INFRA-208): solo en la rama LOCAL_RE, solo claude-vs-litellm.
    // Local-vs-alibaba lo decide el hook session_router.py dentro de LiteLLM; el
    // router NUNCA reescribe entre ellos (frontera del mandato 8 del arquitecto).
    // Fail-safe: sin config o error => sendLocal() = comportamiento actual.
    if (LOCAL_RE.test(model)) {
      const sid = req.headers['x-claude-code-session-id'] || req.headers['x-litellm-session-id'] || '';
      if (!payload) return sendLocal(); // body ilegible: no hay desvio posible
      return routingConfig().then((cfg) => {
        if (!planIsClaude(cfg, sid)) return sendLocal();
        stats.plan_claude++;
        // La sesion local pide un alias que Anthropic no conoce: el desvio trae
        // SU modelo, SU ventana (beta) y SU tope de salida. OAuth se conserva
        // (los headers de la peticion YA son los de Anthropic; sendLocal los
        // cambiaria por la key de LiteLLM — aqui no se toca nada de eso).
        payload.model = PLAN_MODEL;
        if (PLAN_MAX_TOKENS && typeof payload.max_tokens === 'number'
            && payload.max_tokens > PLAN_MAX_TOKENS) payload.max_tokens = PLAN_MAX_TOKENS;
        const hdrs = { ...h };
        if (PLAN_BETA && !(hdrs['anthropic-beta'] || '').includes(PLAN_BETA)) {
          hdrs['anthropic-beta'] = hdrs['anthropic-beta']
            ? `${hdrs['anthropic-beta']},${PLAN_BETA}` : PLAN_BETA;
        }
        const outBody = Buffer.from(JSON.stringify(payload));
        hdrs['content-length'] = String(outBody.length);
        log(`PLAN-CLAUDE model=${model} -> ${PLAN_MODEL} sid=${sid || '-'}`);
        // El historial local viaja igual a Anthropic: el desvio NO exime del
        // guardrail MIXED (los tool_use envenenados siguen ahi).
        return sendAnthropic(hdrs, outBody, `ANTHROPIC(plan=claude) model=${PLAN_MODEL}`);
      }, () => sendLocal());
    }
    return sendAnthropic(h, body, `ANTHROPIC model=${model}`);
  });
});
server.keepAliveTimeout = 75000; server.headersTimeout = 80000;
server.listen(PORT, '127.0.0.1', () => log(`listen 127.0.0.1:${PORT} litellm=${LITELLM.url.host} local_re=${LOCAL_RE}`));

# SC-2337 · evidencia: C0 (medición previa) y tests

Rol: developer · Fecha: 2026-10-12 · Rama: sc-2337-router-cuota

## C0 · medido antes de construir (12-10-2026, x86)

Resultado: **la opción (b) se construye.** Un 200 de suscripción trae las dos ventanas, y las conversaciones de VS Code pasan por `claude-router-front`.
Nada de lo siguiente imprime ni toca un token, ni reinicia o reconfigura servicios; no se gastó cuota (solo lecturas y un `GET /-/health`).

### Cabeceras (nombres exactos, 5 h y 7 d)

- `anthropic-ratelimit-unified-5h-utilization` y `anthropic-ratelimit-unified-5h-reset`
- `anthropic-ratelimit-unified-7d-utilization` y `anthropic-ratelimit-unified-7d-reset`
- además: `anthropic-ratelimit-unified-status` (`allowed|allowed_warning|rejected`), `anthropic-ratelimit-unified-representative-claim` (`five_hour|seven_day`) y `anthropic-ratelimit-unified-reset`.

Fuentes que lo prueban, de tres lados distintos:

1. **El CLI 2.1.296** (`~/.local/share/claude/versions/2.1.296`, `grep -a` de sus cadenas): lee `e.headers.get(`anthropic-ratelimit-unified-${s}-utilization`)` y `...-reset` para `s` en `5h`, `7d`, `7d_oi`, `overage`. Su propia
   comprobación de cuota (`quota_check`) manda `max_tokens: 1` y lee esas cabeceras de la respuesta (`.asResponse()`), o sea de un 200.
2. **El panel `opencode-claude`** (`~/.local/share/opencode-claude/quota.json`, `source: "probe"`): una llamada real a Messages (`probeAccountQuota` → `recordQuotaFromHeaders(account.id, response.headers, "probe")`), hecha el 12-10 08:04:33Z,
   dejó para una cuenta con `status: allowed` las dos ventanas con utilización y reset. `allowed` no es un 429: es una respuesta de éxito.
3. **El propio router** ya las lee en un 429 (`esLimiteDeCuenta`, `LIMITE-429`) con estos mismos nombres (`{U}status`, `{U}representative-claim`, `{U}reset`).

No medido: una captura cruda de un 200 **a través del router**. El router instalado no loguea las cabeceras de un 200 (ni `LIMITE-429`: es anterior a SC-2161), y no se reinicia para medirlo. La primera lectura real de `GET /-/cuota` tras el despliegue es la confirmación; si un 200 no las trajera, `/-/cuota` quedaría vacío (la prueba «sin cabeceras → nada» lo cubre) y no rompe nada.

### VS Code pasa por el front

- `~/.claude/settings.json` → `env`: `HTTPS_PROXY=http://127.0.0.1:18792` (`claude-router-front`), `NO_PROXY=127.0.0.1,localhost,::1`, `ANTHROPIC_BASE_URL=https://api.anthropic.com` (first-party, sin base URL del router: RC sigue publicando).
- `ss -tnp` (12-10, ~08:30Z): el binario nativo `claude` de la extensión de VS Code (`anthropic.claude-code-2.1.295`, pid 3039407) tiene 5 conexiones establecidas a `127.0.0.1:18792`; en total hay 124 hacia el front.
  (El proceso no lleva `HTTPS_PROXY` en su `environ`: el CLI lo aplica desde `settings.json`; lo que mide es la conexión.)
- `GET http://127.0.0.1:18791/-/health`: `anthropic: 46404` peticiones desde el arranque, subiendo (la spec citaba 44.442).

## Tests

`node tests/smoke-cuota.js` (rama `sc-2337-router-cuota`; primero falló: 5 FAIL y una excepción, la ruta no existía y caía al passthrough):

```
ok   sin trafico, /-/cuota es {} y no sale a Anthropic
ok   /-/cuota es JSON sin cache
ok   la respuesta llega intacta al cliente (200 + cabeceras unificadas)
ok   la lectura aparece bajo sha256(Bearer)[0:16]
ok   lleva 5 h y 7 d con sus resets
ok   lleva status, reclamo y hora de lectura
ok   la ultima lectura sustituye a la anterior
ok   un 429 con las cabeceras tambien se anota (otra cuenta, otra entrada)
ok   sin cabeceras unificadas no se anota nada
ok   con valores rotos tampoco, y el cliente recibe su 200
ok   sin Bearer (x-api-key) tampoco
ok   ningun token en /-/cuota, /-/health ni en el log
ok   POST /-/cuota: 405
ok   con Origin: 403
ok   con Sec-Fetch-*: 403
ok   con query string sigue siendo la ruta (no se reenvia a Anthropic con el Bearer)
ok   ninguna de esas salio a Anthropic
```

- `node tests/smoke-backend-flip.js`: `7/7 checks OK`. `python3 -m unittest plugins/local-router/scripts/test_settings_env.py plugins/local-router/scripts/test_backend_flip_notify.py`: `Ran 16 tests ... OK`.
- Smokes de `proxy-claude` contra este router: `smoke-plan-gate` 27/27, `smoke-company-inflight` 4/4, `smoke-company-claude-gate` 13/13. `smoke-routing-config-stale` da 4/11 **también con el router de `main` sin tocar** (falla antes de este cambio: espera un timeout por defecto que el router ya no tiene).
- `tests/check-plugin-version.sh origin/main HEAD`: OK (plugin 2.8.0 → 2.9.0). `company-duplicados`: sin duplicación nueva.

## Criterios

- C0: este documento (cabeceras medidas y camino por el front).
- C1: `anotarCuota` en `plugins/local-router/bin/claude-router.js`; `smoke-cuota.js`: «la lectura aparece bajo sha256(Bearer)[0:16]», «lleva 5 h y 7 d con sus resets», «lleva status, reclamo y hora de lectura», «la ultima lectura sustituye».
- C2: `GET /-/cuota` (`# CONTRACT: http.claude-router.cuota.v1`): «sin trafico, /-/cuota es {}», «POST: 405», «con Origin: 403», «con Sec-Fetch-*: 403», «con query string sigue siendo la ruta».
- C3: la llamada va antes de escribir la respuesta, dentro de `try/catch`, sin I/O ni salto; «la respuesta llega intacta al cliente», «con valores rotos tampoco, y el cliente recibe su 200».
- C4: los tres casos de la spec: lectura bajo el hash, «sin cabeceras → nada», «ningun token en /-/cuota, /-/health ni en el log».

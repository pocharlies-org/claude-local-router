# ARCHITECTURE — claude-local-router

Plugin público de Claude Code (marketplace `claude-local-router`, plugin `local-router` 2.0.0) que empaqueta y despliega el router de modelos por petición y permite inspeccionarlo en vivo. **No es la fuente del router:** lleva una copia de `pocharlies-org/proxy-claude/bin/claude-router.js`.

## Clientes y versiones

- Claude Code (hook `SessionStart` y comandos `/local-router:install`, `/local-router:status`, `/local-router:reload`).
- El router empaquetado escucha en `127.0.0.1` y enruta por nombre de modelo: los que casan `CLAUDE_ROUTER_LOCAL_RE` van a la pasarela local (LiteLLM, vLLM, OpenRouter) y el resto a `api.anthropic.com` sin tocar el cuerpo.
- Versión: `plugins/local-router/.claude-plugin/plugin.json` 2.7.0 (commit `f159858`, #21, 26-09-2026, aviso dentro de la sesión cuando cambia el backend); `.claude-plugin/marketplace.json` sigue en 2.0.0: desalineado.

## Dependencias (en ambos sentidos)

- Depende de: `proxy-claude` (fuente de `bin/claude-router.js`; su workflow `bundle-drift.yml` comprueba que las dos copias coinciden), una pasarela compatible con OpenAI/Anthropic y el panel DGX para la configuración de enrutado (`CLAUDE_ROUTER_ROUTING_CONFIG_URL`).
- Dependen de él: todas las sesiones de Claude Code que instalan el plugin; su hook reescribe `~/.local/bin/claude-router.js` en cada sesión.
- Las dos copias deben coincidir; lo comprueba `bundle-drift.yml` en `proxy-claude`.

## Stack

Node sin dependencias (`plugins/local-router/bin/claude-router.js`), Python 3 (`settings_env.py`, `backend_flip_notify.py`), shell (`scripts/deploy.sh`) y marketplace de plugin de Claude Code.

## Componentes compartidos

- `plugins/local-router/bin/claude-router.js`: **copia**; no se edita aquí. Cualquier cambio de ruteo se hace en `proxy-claude/bin/claude-router.js` y el bundle se actualiza después.
- `plugins/local-router/scripts/settings_env.py`: respeta el modo frente al ajuste del entorno en `~/.claude/settings.json`.
- `plugins/local-router/hooks/hooks.json`: apunta al desplegador.

## Cómo se construye

Un cambio de comportamiento del router NO se hace aquí; aquí solo cambian el empaquetado, los comandos y los scripts del plugin. Tras cambiar el router en `proxy-claude`, se copia el fichero a `plugins/local-router/bin/` en el mismo ciclo.

## Tests

`tests/smoke-backend-flip.js` y los unitarios de Python (`test_settings_env.py`, `test_backend_flip_notify.py`).

## CI/CD y despliegue

`.github/workflows/bundle.yml` (runner `ubuntu-latest`, no `arc-k8s`; ver Decisiones): `node --check` del router empaquetado, `deploy.sh` coherente con el binario, el hook sigue apuntando al desplegador, `settings_env` respeta el modo frente y aviso de cambio de backend; además los workflows estándar `duplicados.yml` y `pr-review.yml`. Se instala por `/plugin marketplace add` y el hook `SessionStart`.

## Decisiones y trampas

- Repo **público** con una copia de código de un repo **privado**: la comprobación de deriva va en `proxy-claude` y no aquí, porque leer de público a privado necesita secreto y al revés no.
- El 21-09-2026 el bundle rancio reactivó el desvío a Opus retirado el 17-09 y borró los perfiles de chat de OWU-50 sin que se notara: el hook solo toca teclas si los bytes difieren y siempre diferían.
- El proxy descarta `authorization` y `x-api-key` y pone la clave del gateway: el OAuth de Anthropic nunca llega al gateway local.
- Los desvíos automáticos (saturación local → nube, cuota → local) se retiraron el 17-09-2026 con su código; las variables `CLAUDE_ROUTER_QUOTA_*` y `FALLBACK_*` ya no se leen.
- El job de CI en `ubuntu-latest` debería ir a `arc-k8s` (skill `ci-runners-arc`).
- Duplicación: ver C5 de SC-1425.

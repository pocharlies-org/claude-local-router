#!/usr/bin/env python3
"""settings_env — apunta ~/.claude/settings.json al router y registra sus modelos en el picker.

Lo llama deploy.sh (entorno: SETTINGS, ROUTER_MODELS, PORT). Antes era un heredoc dentro de
deploy.sh; vive aparte para poder probarlo (test_settings_env.py, en el CI del bundle).

ANTHROPIC_BASE_URL: SE RESPETA EL MODO FRENTE (23-09-2026)
Hay hosts donde el router NO va en ANTHROPIC_BASE_URL a propósito: el CLI solo publica la
sesión en el bridge de Remote Control si esa URL es literalmente api.anthropic.com, así que
se deja la URL real y el tráfico se desvía por un proxy local (HTTPS_PROXY en loopback) que
se lo devuelve al router — en el x86, claude-router-front (:18792) + claude-router (:18791),
fijado por x86-host-runtime/libexec/claude-router-front-env.py. Ese host se reconoce por:

    HTTPS_PROXY (o https_proxy) en env apuntando a loopback, y
    ANTHROPIC_BASE_URL ausente o igual a https://api.anthropic.com

En ese caso aquí no se toca ANTHROPIC_BASE_URL: el tráfico ya pasa por el router. Antes se
reescribía a http://127.0.0.1:<PORT> en cada despliegue completo (tras subir la versión del
plugin, o con el router caído en un SessionStart), lo que dejaba de publicar las sesiones:
pasó el 23-09-2026 en el x86 y hubo que restaurar el settings a mano.

Todo lo demás es como antes: sin proxy de loopback, ANTHROPIC_BASE_URL apunta al router.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from urllib.parse import urlsplit

FIRST_PARTY = ("https://api.anthropic.com", "https://api.anthropic.com/")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
MARCA = "via claude-local-router"


def es_loopback(url: str | None) -> bool:
    if not url:
        return False
    try:
        host = urlsplit(url if "://" in url else f"http://{url}").hostname
    except ValueError:
        return False
    return host in LOOPBACK


def modo_frente(env: dict) -> bool:
    proxy = env.get("HTTPS_PROXY") or env.get("https_proxy")
    base = env.get("ANTHROPIC_BASE_URL")
    return es_loopback(proxy) and (base in (None, "") or base in FIRST_PARTY)


def aplicar(cfg: dict, port: str, models: list[str]) -> tuple[list[str], list[str], list[str], str | None]:
    """Muta `cfg`. Devuelve (changed, added, removed, nota)."""
    changed: list[str] = []
    added: list[str] = []
    nota = None
    env = cfg.setdefault("env", {})
    want = f"http://127.0.0.1:{port}"
    if modo_frente(env):
        nota = (f"modo frente: ANTHROPIC_BASE_URL={env.get('ANTHROPIC_BASE_URL') or '(por defecto)'} "
                f"via HTTPS_PROXY={env.get('HTTPS_PROXY') or env.get('https_proxy')} — no se toca")
    elif env.get("ANTHROPIC_BASE_URL") != want:
        env["ANTHROPIC_BASE_URL"] = want
        changed.append("env.ANTHROPIC_BASE_URL")

    picker = cfg.setdefault("modelPicker", {})
    opts = picker.setdefault("options", [])
    # Las filas que pone ESTE script se marcan con su descripcion y son las unicas
    # que puede retirar. Sin esta reconciliacion el picker solo crece: un alias que
    # el router deja de publicar (un renombrado, un perfil retirado) se queda como
    # fila para siempre y el usuario ve el mismo modelo varias veces con nombres
    # distintos — medido el 22-09-2026, cinco alias muertos resucitados en cada
    # SessionStart porque el hook re-ejecuta este deploy en cada arranque.
    removed = [o.get("model") for o in opts
               if isinstance(o, dict) and o.get("description") == MARCA and o.get("model") not in models]
    if removed:
        opts[:] = [o for o in opts
                   if not (isinstance(o, dict) and o.get("description") == MARCA
                           and o.get("model") not in models)]
    have = {o.get("model") for o in opts if isinstance(o, dict)}
    for m in models:
        if m in have:
            continue
        opts.append({"model": m, "label": f"{m} (local)", "description": MARCA, "behavesAs": "sonnet"})
        added.append(m)
    return changed, added, removed, nota


def main() -> int:
    path = os.environ["SETTINGS"]
    port = os.environ["PORT"]
    models = [m.strip() for m in os.environ["ROUTER_MODELS"].split(",") if m.strip()]
    try:
        cfg = json.load(open(path))
        if not isinstance(cfg, dict):
            raise ValueError("raiz no es objeto JSON")
    except FileNotFoundError:
        cfg = {}
    except Exception as e:  # noqa: BLE001 — un settings roto no se pisa
        print(f"! {path}: {e} — edítalo a mano: env.ANTHROPIC_BASE_URL=http://127.0.0.1:{port}")
        return 0
    changed, added, removed, nota = aplicar(cfg, port, models)
    if nota:
        print("  " + nota)
    if changed or added or removed:
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
            f.write("\n")
        if os.path.exists(path):
            shutil.copymode(path, tmp)   # conserva los permisos del settings original
        os.replace(tmp, path)
        if changed:
            print("  " + ", ".join(changed))
        if added:
            print("  picker: " + ", ".join(added))
        if removed:
            print("  picker (retiradas, ya no las publica el router): " + ", ".join(removed))
    return 0


if __name__ == "__main__":
    sys.exit(main())

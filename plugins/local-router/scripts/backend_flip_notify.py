#!/usr/bin/env python3
"""Stop hook: avisa DENTRO de la sesion cuando el backend de la session cambio.

Lee los eventos que escribe claude-router.js (noteBackend -> backend-events.jsonl)
y compara con el cursor de esta sesion. Si hay transiciones nuevas (local<->alibaba),
emite un systemMessage: «ha saltado el fallback» o «recuperado el residente».

Contrato del Stop hook de Claude Code: JSON por stdin (session_id, transcript_path...),
JSON por stdout ({"systemMessage": ...}) para que se vea en la UI. Cualquier fallo =>
silencio y exit 0: un hook de observabilidad jamas puede romper un turno.
"""
import json
import os
import sys


def flip_dir():
    return os.environ.get("CLAUDE_ROUTER_FLIP_DIR") or os.path.join(
        os.path.expanduser("~"), ".cache", "claude-local-router")


def tail_lines(path, max_bytes=262144):
    """Ultimas lineas del JSONL sin leer el fichero entero (crece indefinidamente)."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            chunk = f.read().decode("utf-8", "replace")
    except OSError:
        return []
    lines = chunk.splitlines()
    if size > max_bytes and lines:
        lines = lines[1:]  # la primera puede estar cortada por el seek
    return lines


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    sid = str(payload.get("session_id") or "").strip()
    if not sid or not all(c.isalnum() or c in "_-" for c in sid):
        return 0
    d = flip_dir()
    events_path = os.path.join(d, "backend-events.jsonl")
    cursor_path = os.path.join(d, f"flip-cursor-{sid}")
    try:
        seen = open(cursor_path).read().strip()
    except OSError:
        seen = ""
    mine = []
    for line in tail_lines(events_path):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("sid") == sid and str(ev.get("ts", "")) > seen:
            mine.append(ev)
    if not mine:
        return 0
    try:
        os.makedirs(d, exist_ok=True)
        with open(cursor_path, "w") as f:
            f.write(str(mine[-1]["ts"]))
    except OSError:
        pass
    last = mine[-1]
    n = len(mine)
    extra = f" (+{n - 1} cambios previos sin avisar)" if n > 1 else ""
    if last.get("to") == "alibaba":
        fb = f", fallbacks intentados: {last['fallbacks']}" if last.get("fallbacks") else ""
        msg = (f"⚠️ Backend: este turno lo sirvio Alibaba (grupo `{last.get('group')}`), "
               f"NO el residente local{fb}{extra}. El aviso de recuperacion llegara cuando vuelva.")
    else:
        msg = f"✓ Backend recuperado: el residente local vuelve a servir esta sesion{extra}."
    print(json.dumps({"systemMessage": msg}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)

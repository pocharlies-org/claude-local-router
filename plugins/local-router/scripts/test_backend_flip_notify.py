#!/usr/bin/env python3
"""Tests de backend_flip_notify.py: el Stop hook que avisa del flip local<->alibaba.

    python3 -m unittest plugins/local-router/scripts/test_backend_flip_notify.py -v
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

AQUI = Path(__file__).resolve().parent
NOTIFY = AQUI / "backend_flip_notify.py"


def run_hook(stdin_obj, flip_dir, sid=None):
    payload = json.dumps({"session_id": sid or "", "transcript_path": "/dev/null"})
    p = subprocess.run([sys.executable, str(NOTIFY)], input=payload, capture_output=True, text=True,
                       env={"CLAUDE_ROUTER_FLIP_DIR": flip_dir, "PATH": "/usr/bin:/bin"}, timeout=10)
    return p.returncode, p.stdout.strip(), p.stderr


def ev(ts, sid, frm, to, group="alibaba-q38-flash", fallbacks=1):
    return json.dumps({"ts": ts, "sid": sid, "from": frm, "to": to, "group": group, "fallbacks": fallbacks})


class FlipNotify(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.d = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def write_events(self, *lines):
        (Path(self.d) / "backend-events.jsonl").write_text("\n".join(lines) + "\n")

    def test_sin_eventos_silencio(self):
        rc, out, _ = run_hook(None, self.d, sid="s1")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "")

    def test_flip_a_alibaba_avisa(self):
        self.write_events(ev("2026-09-26T10:00:00.000Z", "s1", "local", "alibaba"))
        rc, out, _ = run_hook({}, self.d, sid="s1")
        self.assertEqual(rc, 0)
        msg = json.loads(out)["systemMessage"]
        self.assertIn("Alibaba", msg)
        self.assertIn("alibaba-q38-flash", msg)

    def test_cursor_deduplica(self):
        self.write_events(ev("2026-09-26T10:00:00.000Z", "s1", "local", "alibaba"))
        _, out1, _ = run_hook({}, self.d, sid="s1")
        self.assertNotEqual(out1, "")
        rc, out2, _ = run_hook({}, self.d, sid="s1")
        self.assertEqual(rc, 0)
        self.assertEqual(out2, "", "el segundo paso no debe repetir el aviso")

    def test_recuperacion_avisa(self):
        self.write_events(ev("2026-09-26T10:00:00.000Z", "s1", "local", "alibaba"))
        _, out1, _ = run_hook({}, self.d, sid="s1")  # consume el flip a Alibaba
        self.assertIn("Alibaba", json.loads(out1)["systemMessage"])
        with (Path(self.d) / "backend-events.jsonl").open("a") as f:
            f.write(ev("2026-09-26T10:05:00.000Z", "s1", "alibaba", "local",
                       group="qwen38-flash-next", fallbacks=0) + "\n")
        _, out, _ = run_hook({}, self.d, sid="s1")
        msg = json.loads(out)["systemMessage"]
        self.assertIn("recuperado", msg)

    def test_sesion_ajena_no_contamina(self):
        self.write_events(ev("2026-09-26T10:00:00.000Z", "otra", "local", "alibaba"))
        rc, out, _ = run_hook({}, self.d, sid="s1")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "")

    def test_sid_malicioso_no_escribe_fuera(self):
        self.write_events(ev("2026-09-26T10:00:00.000Z", "x", "local", "alibaba"))
        rc, out, _ = run_hook({}, self.d, sid="../escape")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "")
        self.assertEqual(list(Path(self.d).glob("flip-cursor-*")), [])

    def test_stdin_basura_exit_0(self):
        p = subprocess.run([sys.executable, str(NOTIFY)], input="no-es-json", capture_output=True, text=True,
                           env={"CLAUDE_ROUTER_FLIP_DIR": self.d, "PATH": "/usr/bin:/bin"}, timeout=10)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()

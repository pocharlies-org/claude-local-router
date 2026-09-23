#!/usr/bin/env python3
"""Tests de settings_env.py: lo que deploy.sh escribe en ~/.claude/settings.json.

    python3 -m unittest plugins/local-router/scripts/test_settings_env.py -v
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
import settings_env as se  # noqa: E402

MODELOS = ["qwen38-flash-next", "alibaba-q38-max"]


class ModoFrente(unittest.TestCase):
    """El caso del 23-09-2026: el x86 con el frente no debe perder su ANTHROPIC_BASE_URL."""

    def test_frente_del_x86_no_se_toca(self):
        cfg = {"env": {"ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                       "HTTPS_PROXY": "http://127.0.0.1:18792"}}
        changed, _, _, nota = se.aplicar(cfg, "18791", MODELOS)
        self.assertEqual(cfg["env"]["ANTHROPIC_BASE_URL"], "https://api.anthropic.com")
        self.assertNotIn("env.ANTHROPIC_BASE_URL", changed)
        self.assertIn("modo frente", nota)

    def test_frente_sin_base_url_no_la_anade(self):
        """claude-rc-baseurl.sh la quita un momento al arrancar Remote Control: sin URL el CLI
        va a api.anthropic.com por el proxy, que es lo correcto; no se mete la del router."""
        for proxy_key, proxy in (("HTTPS_PROXY", "http://localhost:18792"), ("https_proxy", "127.0.0.1:18792"),
                                 ("HTTPS_PROXY", "http://[::1]:18792")):
            cfg = {"env": {proxy_key: proxy}}
            se.aplicar(cfg, "18791", MODELOS)
            self.assertNotIn("ANTHROPIC_BASE_URL", cfg["env"], proxy)

    def test_proxy_no_loopback_no_es_frente(self):
        cfg = {"env": {"ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                       "HTTPS_PROXY": "http://proxy.empresa.com:3128"}}
        se.aplicar(cfg, "18791", MODELOS)
        self.assertEqual(cfg["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:18791")

    def test_sin_proxy_se_apunta_al_router_como_siempre(self):
        for env in ({}, {"ANTHROPIC_BASE_URL": "https://api.anthropic.com"},
                    {"ANTHROPIC_BASE_URL": "http://127.0.0.1:9999"}):
            cfg = {"env": dict(env)}
            changed, _, _, nota = se.aplicar(cfg, "18791", MODELOS)
            self.assertEqual(cfg["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:18791")
            self.assertEqual(changed, ["env.ANTHROPIC_BASE_URL"])
            self.assertIsNone(nota)

    def test_frente_con_url_rara_no_es_frente(self):
        """Con proxy de loopback pero la URL ya en otro sitio (p.ej. el router viejo), manda la
        regla de siempre: el router."""
        cfg = {"env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:9999", "HTTPS_PROXY": "http://127.0.0.1:18792"}}
        se.aplicar(cfg, "18791", MODELOS)
        self.assertEqual(cfg["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:18791")


class Picker(unittest.TestCase):
    def test_reconcilia_solo_sus_filas(self):
        cfg = {"modelPicker": {"options": [
            {"model": "opus[1m]", "label": "Opus", "description": "Suscripcion oficial"},
            {"model": "muerto", "label": "muerto (local)", "description": se.MARCA},
            {"model": "qwen38-flash-next", "label": "a mano", "description": "mia"},
        ]}}
        _, added, removed, _ = se.aplicar(cfg, "18791", MODELOS)
        modelos = [o["model"] for o in cfg["modelPicker"]["options"]]
        self.assertEqual(removed, ["muerto"])
        self.assertEqual(added, ["alibaba-q38-max"])
        self.assertEqual(modelos, ["opus[1m]", "qwen38-flash-next", "alibaba-q38-max"])


class Script(unittest.TestCase):
    """El script entero como lo llama deploy.sh: fichero, permisos e idempotencia."""

    def correr(self, path):
        env = dict(os.environ, SETTINGS=str(path), PORT="18791", ROUTER_MODELS=",".join(MODELOS))
        return subprocess.run([sys.executable, str(AQUI / "settings_env.py")], env=env,
                              capture_output=True, text=True, check=True).stdout

    def test_frente_intacto_y_permisos_conservados(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "settings.json"
            p.write_text(json.dumps({"env": {"ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                                             "HTTPS_PROXY": "http://127.0.0.1:18792"},
                                     "modelPicker": {"options": [
                                         {"model": m, "label": m, "description": se.MARCA} for m in MODELOS]}}))
            os.chmod(p, 0o600)
            antes = p.read_bytes()
            out = self.correr(p)
            self.assertIn("modo frente", out)
            self.assertEqual(p.read_bytes(), antes, "nada que cambiar: no se reescribe")

    def test_sin_frente_escribe_y_conserva_permisos(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "settings.json"
            p.write_text("{}")
            os.chmod(p, 0o600)
            self.correr(p)
            self.assertEqual(json.loads(p.read_text())["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:18791")
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)

    def test_settings_roto_no_se_pisa(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "settings.json"
            p.write_text("{roto")
            out = self.correr(p)
            self.assertIn("edítalo a mano", out)
            self.assertEqual(p.read_text(), "{roto")


if __name__ == "__main__":
    unittest.main()

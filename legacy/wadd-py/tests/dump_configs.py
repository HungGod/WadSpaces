"""Writes fixtures/python-state/configs.json: YAML cases and what parse_config
makes of them, for the Rust wadd's reader (crates/wad-store) to match.
Run: cd legacy/wadd-py && .venv/bin/python tests/dump_configs.py"""
import json
import sys
from dataclasses import asdict
from pathlib import Path

import yaml

WADD = Path(__file__).resolve().parents[1]
REPO = WADD.parents[1]
sys.path.insert(0, str(WADD))
from wadd.config import ConfigError, parse_config  # noqa: E402

CASES = {
    "image": (REPO / "host/etc/wadspaces/workspaces.yaml").read_text(),
    "dev": (WADD / "dev/workspaces.dev.yaml").read_text(),
    "old-names": """
version: 1
daemon:
  base_registry: ghcr.io/old
  hotkeys: {enabled: false}
cloud: {project_id: p, storage_bucket: gone}
workspaces:
  - {id: a, name: A, image: i, port: 3100, env: {N: 1, B: true, S: "x", Z: null}}
""",
    "defaults": """
workspaces:
  - {id: a, name: A, image: i, port: 3100}
  - {id: b, name: B, image: i, display: host, hotkey: 2, shm_size: null, container_name: custom, enabled: false}
  - id: c
    name: C
    image: i
    display: host
    projects: [{id: p1, mount: Notes}, {id: d1, mount: Photos, path: /run/media/x}]
""",
    "unknown-key": "workspaces: [{id: a, name: A, image: i, port: 3100, colour: red}]",
    "stream-without-port": "workspaces: [{id: a, name: A, image: i}]",
    "bad-display": "workspaces: [{id: a, name: A, image: i, display: tv}]",
    "bad-id": "workspaces: [{id: A_1, name: A, image: i, port: 3100}]",
    "duplicate-id": "workspaces: [{id: a, name: A, image: i, port: 3100}, {id: a, name: B, image: i, port: 3101}]",
    "port-clash": "workspaces: [{id: a, name: A, image: i, port: 8080}]",
    "port-clash-wadcreator": "workspaces: [{id: a, name: A, image: i, port: 8081}]",
    "port-ok-wadcreator-off": "wadcreator: {enabled: false}\nworkspaces: [{id: a, name: A, image: i, port: 8081}]",
    "hotkey-range": "workspaces: [{id: a, name: A, image: i, port: 3100, hotkey: 10}]",
    "hotkey-twice": "workspaces: [{id: a, name: A, image: i, port: 3100, hotkey: 1}, {id: b, name: B, image: i, port: 3101, hotkey: 1}]",
    "hotkey-twice-disabled": "workspaces: [{id: a, name: A, image: i, port: 3100, hotkey: 1}, {id: b, name: B, image: i, port: 3101, hotkey: 1, enabled: false}]",
    "project-shape": "workspaces: [{id: a, name: A, image: i, display: host, projects: [{id: p}]}]",
    "project-path": "workspaces: [{id: a, name: A, image: i, display: host, projects: [{id: p, mount: M, path: 'rel:x'}]}]",
    "project-twice": "workspaces: [{id: a, name: A, image: i, display: host, projects: [{id: p, mount: M}, {id: p, mount: N}]}]",
    "mount-twice": "workspaces: [{id: a, name: A, image: i, display: host, projects: [{id: p, mount: M}, {id: q, mount: M}]}]",
    "version-2": "version: 2",
    "cloud-no-project": "cloud: {heartbeat_s: 5}",
    "bad-backend": "daemon: {backend: docker}",
    "empty": "",
}

out = []
for name, text in CASES.items():
    data = yaml.safe_load(text) or {}
    try:
        cfg = parse_config(data)
        out.append({"name": name, "yaml": text, "machine": cfg.machine_name, "cloud": bool(cfg.cloud),
                    "workspaces": [asdict(w) for w in cfg.workspaces]})
    except ConfigError as e:
        out.append({"name": name, "yaml": text, "error": str(e)})
(REPO / "fixtures/python-state/configs.json").write_text(json.dumps(out, indent=1) + "\n")
print(f"{len(out)} cases")

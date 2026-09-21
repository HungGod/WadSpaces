import pytest
import yaml

from wadd.config import ConfigError, config_to_dict, load_config, parse_config, save_config
from conftest import FIXTURES


def ws(**kw):
    base = {"id": "a", "name": "A", "image": "img", "port": 3100}
    return {**base, **kw}


def test_defaults():
    cfg = parse_config({"workspaces": [ws(hotkey=1)]})
    w = cfg.workspaces[0]
    assert w.container_name == "wad-a"
    assert w.unit == "wad-a.service"
    assert w.url == "http://127.0.0.1:3100/"
    assert cfg.by_hotkey(1) is w
    assert cfg.daemon.backend == "systemd"
    assert cfg.wadcreator.port == 8081 and cfg.cloud is None


@pytest.mark.parametrize("bad, msg", [
    ([ws(), ws(port=3101)], "duplicate id"),
    ([ws(), ws(id="b")], "already used"),
    ([ws(port=8080)], "already used"),
    ([ws(port=8081)], "already used"),
    ([ws(hotkey=0)], "1..9"),
    ([ws(hotkey=1), ws(id="b", port=3101, hotkey=1)], "hotkey 1"),
    ([ws(id="Bad_Id")], "id must match"),
    ([{"id": "a", "name": "A", "port": 1}], "missing image"),
    ([ws(nope=1)], "unknown keys"),
])
def test_validation(bad, msg):
    with pytest.raises(ConfigError, match=msg):
        parse_config({"workspaces": bad})


def test_disabled_workspace_may_reuse_hotkey():
    cfg = parse_config({"workspaces": [ws(hotkey=1), ws(id="b", port=3101, hotkey=1, enabled=False)]})
    assert [w.id for w in cfg.enabled_workspaces] == ["a"]


def test_round_trip(tmp_path):
    data = {"machine": {"name": "m"}, "workspaces": [yaml.safe_load((FIXTURES / "writing.yaml").read_text())]}
    p = tmp_path / "w.yaml"
    p.write_text(yaml.safe_dump(data))
    cfg = load_config(p)
    save_config(cfg)
    again = load_config(p)
    assert config_to_dict(again) == config_to_dict(cfg)
    assert again.workspaces[0].env["PUID"] == "1000"


def test_shipped_configs_are_valid():
    root = FIXTURES.parents[1]
    for p in ["host/etc/wadspaces/workspaces.yaml", "dev/workspaces.dev.yaml"]:
        assert len(load_config(root / p).workspaces) == 6

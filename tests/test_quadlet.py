import yaml

from wadd.config import WorkspaceSpec, parse_config
from wadd.quadlet import gen_quadlets, render_container_unit
from conftest import FIXTURES


def writing():
    return WorkspaceSpec(**yaml.safe_load((FIXTURES / "writing.yaml").read_text()))


def test_matches_fixture():
    # Shared with WadCreator/src/templates/quadlet.test.ts: both renderers must agree.
    assert render_container_unit(writing()) == (FIXTURES / "wad-writing.container").read_text()


def test_gen_prunes_stale(tmp_path):
    (tmp_path / "wad-old.container").write_text("x")
    (tmp_path / "other.container").write_text("x")
    cfg = parse_config({"workspaces": [{"id": "a", "name": "A", "image": "i", "port": 3100}]})
    gen_quadlets(cfg, tmp_path)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["other.container", "wad-a.container"]

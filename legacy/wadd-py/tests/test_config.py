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


def test_autostart_is_optional_and_not_written_when_false():
    cfg = parse_config({"workspaces": [ws(autostart=True), ws(id="b", port=3101)]})
    a, b = (config_to_dict(cfg)["workspaces"])
    assert a["autostart"] is True and "autostart" not in b


def test_display_host_needs_no_port_and_stream_does():
    cfg = parse_config({"workspaces": [
        {"id": "a", "name": "A", "image": "i", "display": "host"},
        {"id": "b", "name": "B", "image": "i", "port": 3100},
    ]})
    a, b = cfg.workspace("a"), cfg.workspace("b")
    assert a.native and a.url is None
    assert not b.native and b.url == "http://127.0.0.1:3100/"
    with pytest.raises(ConfigError, match="missing port"):
        parse_config({"workspaces": [{"id": "c", "name": "C", "image": "i"}]})
    with pytest.raises(ConfigError, match="display must be"):
        parse_config({"workspaces": [{"id": "c", "name": "C", "image": "i", "display": "vnc"}]})


def test_display_round_trips_and_stream_is_implicit():
    from wadd.config import workspace_to_dict
    cfg = parse_config({"workspaces": [
        {"id": "a", "name": "A", "image": "i", "display": "host"},
        {"id": "b", "name": "B", "image": "i", "port": 3100},
    ]})
    assert workspace_to_dict(cfg.workspace("a"))["display"] == "host"
    assert "display" not in workspace_to_dict(cfg.workspace("b"))


def test_the_image_decides_the_cloud_project(tmp_path):
    # A kiosk's workspaces.yaml, saved by an older wadd, still names the old
    # project; bootc keeps it on update. The image's cloud.yaml wins.
    stale = tmp_path / "workspaces.yaml"
    stale.write_text(yaml.safe_dump({"cloud": {"project_id": "wadcreator", "heartbeat_s": 60},
                                     "workspaces": [ws()]}))
    vendor = tmp_path / "cloud.yaml"
    vendor.write_text("project_id: wad-spaces\n")
    cfg = load_config(stale, vendor_cloud=vendor)
    assert cfg.cloud.project_id == "wad-spaces"
    assert cfg.cloud.heartbeat_s == 60
    assert "wad-spaces" in cfg.cloud.functions_url
    # No cloud section at all (or no vendor file) still works.
    stale.write_text(yaml.safe_dump({"workspaces": [ws()]}))
    assert load_config(stale, vendor_cloud=vendor).cloud.project_id == "wad-spaces"
    assert load_config(stale, vendor_cloud=tmp_path / "missing.yaml").cloud is None


def test_the_shipped_host_config_links_to_wad_spaces():
    root = FIXTURES.parents[1]
    cfg = load_config(root / "host/etc/wadspaces/workspaces.yaml",
                      vendor_cloud=root / "host/usr/lib/wadspaces/cloud.yaml")
    assert cfg.cloud.project_id == "wad-spaces"


def test_keys_an_older_wadd_saved_still_load(tmp_path):
    # The Surface's workspaces.yaml was saved with every field of its day;
    # bootc keeps it, so keys for removed features must not stop wadd.
    old = tmp_path / "workspaces.yaml"
    old.write_text(yaml.safe_dump({
        "daemon": {"port": 8080, "base_registry": "example.pkg.dev/p/wadspaces-public"},
        "cloud": {"project_id": "wad-spaces", "storage_bucket": "b", "storage_base": "",
                  "files_every_s": 600},
        "workspaces": [ws()],
    }))
    vendor = tmp_path / "cloud.yaml"  # an older image's cloud.yaml had one too
    vendor.write_text("project_id: wad-spaces\nstorage_bucket: b\n")
    cfg = load_config(old, vendor_cloud=vendor)
    assert cfg.cloud.project_id == "wad-spaces"
    # Saving writes them no more.
    save_config(cfg)
    saved = yaml.safe_load(old.read_text())
    assert "base_registry" not in saved["daemon"] and "storage_bucket" not in saved["cloud"]
    # Anything else unknown is still an error.
    with pytest.raises(ConfigError, match=r"daemon: unknown keys \['nope'\]"):
        parse_config({"daemon": {"nope": 1, "base_registry": "x"}})
    with pytest.raises(ConfigError, match=r"cloud: unknown keys \['nope'\]"):
        parse_config({"cloud": {"project_id": "p", "nope": 1, "files_every_s": 1}})


@pytest.mark.parametrize("projects, msg", [
    ([{"id": "bad id", "mount": "A"}], "project id"),
    ([{"id": "x" * 65, "mount": "A"}], "project id"),
    ([{"id": "p1", "mount": "a/b"}], "project mount"),
    ([{"id": "p1", "mount": ".."}], "project mount"),
    ([{"id": "p1", "mount": "A"}, {"id": "p2", "mount": "A"}], "mounted at Desktop/A"),
    ([{"id": "p1", "mount": "A"}, {"id": "p1", "mount": "B"}], "listed twice"),
    ([{"id": "p1"}], "each project is"),
    ("p1", "must be a list"),
])
def test_project_validation(projects, msg):
    with pytest.raises(ConfigError, match=msg):
        parse_config({"workspaces": [ws(projects=projects)]})


def test_projects_round_trip_and_new_daemon_keys_stay_out_of_the_file(tmp_path):
    p = tmp_path / "w.yaml"
    projects = [{"id": "Ab_c-1", "mount": "My.Notes"}]
    cfg = parse_config({"workspaces": [ws(projects=projects), ws(id="b", port=3101)]}, p)
    save_config(cfg)
    saved = yaml.safe_load(p.read_text())
    assert saved["workspaces"][0]["projects"] == projects
    assert "projects" not in saved["workspaces"][1]  # an older wadd can still read it
    assert "projects_dir" not in saved["daemon"] and "projects_uid" not in saved["daemon"]
    assert load_config(p, vendor_cloud=None).workspaces[0].projects == projects
    cfg.daemon.projects_dir = "/srv/projects"
    save_config(cfg)
    assert yaml.safe_load(p.read_text())["daemon"]["projects_dir"] == "/srv/projects"


def test_folder_roots_stay_out_of_the_file_at_their_default(tmp_path):
    from wadd.config import FOLDER_ROOTS
    p = tmp_path / "w.yaml"
    projects = [{"id": "f1", "mount": "Notes", "path": "/var/home/wad/Notes"}]
    cfg = parse_config({"workspaces": [ws(projects=projects)]}, p)
    assert cfg.daemon.folder_roots == FOLDER_ROOTS and cfg.daemon.folder_roots is not FOLDER_ROOTS
    save_config(cfg)
    assert "folder_roots" not in yaml.safe_load(p.read_text())["daemon"]
    assert load_config(p, vendor_cloud=None).workspaces[0].projects == projects
    cfg.daemon.folder_roots = ["/srv/shared"]
    save_config(cfg)
    assert load_config(p, vendor_cloud=None).daemon.folder_roots == ["/srv/shared"]

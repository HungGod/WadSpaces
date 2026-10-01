import yaml

from wadd.config import WorkspaceSpec, parse_config
from wadd.quadlet import gen_quadlets, render_container_unit
from conftest import FIXTURES


def writing():
    return WorkspaceSpec(**yaml.safe_load((FIXTURES / "writing.yaml").read_text()))


def test_matches_fixture():
    # Shared with WadCreator/src/templates/quadlet.test.ts: both renderers must agree.
    assert render_container_unit(writing()) == (FIXTURES / "wad-writing.container").read_text()


def test_host_display_matches_fixture():
    # A native workspace: no port, the kiosk's sway runtime dir mounted, no SELinux label.
    ws = WorkspaceSpec(**yaml.safe_load((FIXTURES / "writing-host.yaml").read_text()))
    assert render_container_unit(ws) == (FIXTURES / "wad-writing-host.container").read_text()


def test_gen_prunes_stale(tmp_path):
    (tmp_path / "wad-old.container").write_text("x")
    (tmp_path / "other.container").write_text("x")
    cfg = parse_config({"workspaces": [{"id": "a", "name": "A", "image": "i", "port": 3100}]})
    gen_quadlets(cfg, tmp_path)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["other.container", "wad-a.container"]


def test_units_from_an_older_wadd_are_noticed(tmp_path):
    from wadd.quadlet import quadlets_current
    cfg = parse_config({"daemon": {"state_dir": str(tmp_path / "state")},
                        "workspaces": [{"id": "a", "name": "A", "image": "i", "port": 3100}]})
    assert not quadlets_current(cfg, tmp_path / "units")  # none yet
    gen_quadlets(cfg, tmp_path / "units")
    assert quadlets_current(cfg, tmp_path / "units")
    # An older wadd's unit: it still mounts the cloud files folder.
    unit = tmp_path / "units" / "wad-a.container"
    unit.write_text(unit.read_text().replace(
        "Pull=missing", f"Volume={tmp_path}/state/files/a:/run/wadspaces-extra/files:ro,z\nPull=missing"))
    assert not quadlets_current(cfg, tmp_path / "units")
    gen_quadlets(cfg, tmp_path / "units")
    assert "wadspaces-extra" not in unit.read_text()


PROJECTS = [{"id": "wrtvault0000000000ab", "mount": "Writing"}, {"id": "notes000000000000000", "mount": "Notes"}]


def test_projects_match_fixture():
    # Shared with WadCreator's generator: each project's folder read-write on
    # the Desktop, then the directory holding projects.json.
    ws = WorkspaceSpec(**{**yaml.safe_load((FIXTURES / "writing-host.yaml").read_text()), "projects": PROJECTS})
    assert render_container_unit(ws) == (FIXTURES / "wad-writing-projects.container").read_text()


FOLDER_PROJECTS = [{"id": "wrtvault0000000000ab", "mount": "Writing"},
                   {"id": "notesfolder000000000", "mount": "Notes", "path": "/var/home/wad/Notes"}]


def test_folder_projects_match_fixture():
    # Shared with WadCreator's generator: a folder (or drive) project mounts
    # its own path, without :z, and the container then runs unlabelled.
    ws = WorkspaceSpec(**{**yaml.safe_load((FIXTURES / "writing.yaml").read_text()), "projects": FOLDER_PROJECTS})
    text = render_container_unit(ws)
    assert text == (FIXTURES / "wad-writing-folder.container").read_text()
    assert text.count("SecurityLabelDisable=true") == 1


def test_folder_project_paths_are_checked():
    import pytest
    from wadd.config import ConfigError
    spec = {"id": "a", "name": "A", "image": "i", "port": 3100}
    parse_config({"workspaces": [{**spec, "projects": FOLDER_PROJECTS}]})
    for bad in ("relative/x", "/a:b", "/a%h", 7):
        with pytest.raises(ConfigError, match="path"):
            parse_config({"workspaces": [{**spec, "projects": [{"id": "p", "mount": "P", "path": bad}]}]})
    with pytest.raises(ConfigError, match="id, mount, path"):
        parse_config({"workspaces": [{**spec, "projects": [{"id": "p", "mount": "P", "x": 1}]}]})


def test_no_projects_renders_as_before():
    # An empty list adds nothing: the older fixtures stay byte-identical.
    ws = WorkspaceSpec(**{**yaml.safe_load((FIXTURES / "writing-host.yaml").read_text()), "projects": []})
    assert render_container_unit(ws) == (FIXTURES / "wad-writing-host.container").read_text()


def test_project_paths_come_from_the_daemon_config(tmp_path):
    cfg = parse_config({"daemon": {"projects_dir": "/srv/p", "state_dir": "/srv/s"},
                        "workspaces": [{"id": "a", "name": "A", "image": "i", "port": 3100,
                                        "projects": PROJECTS[:1]}]})
    text = gen_quadlets(cfg, tmp_path)[0].read_text()
    assert "Volume=/srv/p/wrtvault0000000000ab:/config/Desktop/Writing:rw,z\n" in text
    assert "Volume=/srv/s/extra/a:/run/wadspaces-extra:ro,z\n" in text


def test_a_changed_project_set_makes_the_units_stale(tmp_path):
    from wadd.quadlet import quadlets_current
    spec = {"id": "a", "name": "A", "image": "i", "port": 3100, "projects": PROJECTS[:1]}
    cfg = parse_config({"workspaces": [spec]})
    gen_quadlets(cfg, tmp_path)
    assert quadlets_current(cfg, tmp_path)
    for projects in (PROJECTS, [], [{"id": PROJECTS[0]["id"], "mount": "Vault"}]):
        assert not quadlets_current(parse_config({"workspaces": [{**spec, "projects": projects}]}), tmp_path)


def test_rootless_wadd_maps_the_host_user_to_the_desktop_user(tmp_path):
    # Under the user's systemd, podman is rootless: without these maps abc
    # (uid 1000 inside) can't write the host user's project folders.
    spec = {"id": "a", "name": "A", "image": "i", "port": 3100, "projects": PROJECTS[:1]}
    rootless = parse_config({"daemon": {"systemd_scope": "user"}, "workspaces": [spec]})
    text = gen_quadlets(rootless, tmp_path)[0].read_text()
    for kind in ("UIDMap", "GIDMap"):
        assert f"{kind}=0:1:1000\n{kind}=1000:0:1\n{kind}=1001:1001:64535\n" in text
    rootful = parse_config({"workspaces": [spec]})
    assert "UIDMap" not in gen_quadlets(rootful, tmp_path / "s")[0].read_text()

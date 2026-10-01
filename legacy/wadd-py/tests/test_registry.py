import asyncio
import base64
import json

import httpx

from wadd.registry import (PullProgress, describe, fetch_layer_sizes, human_bytes, local_blob_digests,
                           parse_challenge, parse_ref, registry_credentials, rx_bytes)


def test_parse_ref():
    assert parse_ref("ghcr.io/hunggod/wadspaces-kale-b:latest") == ("ghcr.io", "hunggod/wadspaces-kale-b", "latest")
    assert parse_ref("busybox") == ("docker.io", "library/busybox", "latest")
    assert parse_ref("docker.io/library/python:3.12-slim") == ("docker.io", "library/python", "3.12-slim")
    assert parse_ref("localhost:5000/x/y@sha256:ab") == ("localhost:5000", "x/y", "sha256:ab")
    assert parse_ref("quay.io/fedora/fedora-bootc:43") == ("quay.io", "fedora/fedora-bootc", "43")


def test_parse_challenge():
    h = 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/n:pull"'
    assert parse_challenge(h) == {"realm": "https://ghcr.io/token", "service": "ghcr.io",
                                  "scope": "repository:o/n:pull"}


def test_registry_credentials(tmp_path):
    f = tmp_path / "auth.json"
    f.write_text(json.dumps({"auths": {"ghcr.io": {"auth": base64.b64encode(b"me:tok:en").decode()}}}))
    assert registry_credentials("ghcr.io", [str(f)]) == ("me", "tok:en")
    assert registry_credentials("quay.io", [str(f)]) is None
    assert registry_credentials("ghcr.io", [str(tmp_path / "missing.json")]) is None


def fake_registry(private=False):
    """ghcr-like: 401 + token dance, an index pointing at an amd64 manifest."""
    index = {"mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [
        {"digest": "sha256:arm", "platform": {"architecture": "arm64", "os": "linux"}},
        {"digest": "sha256:amd", "platform": {"architecture": "amd64", "os": "linux"}},
    ]}
    manifest = {"mediaType": "application/vnd.oci.image.manifest.v1+json",
                "layers": [{"digest": "sha256:l1", "size": 100}, {"digest": "sha256:l2", "size": 50}]}
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/token":
            seen["token_auth"] = req.headers.get("authorization")
            seen["scope"] = req.url.params.get("scope")
            if private and not req.headers.get("authorization"):
                return httpx.Response(401)
            return httpx.Response(200, json={"token": "T"})
        if req.headers.get("authorization") != "Bearer T":
            return httpx.Response(401, headers={"www-authenticate":
                'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/n:pull"'})
        if req.url.path == "/v2/o/n/manifests/latest":
            return httpx.Response(200, json=index)
        if req.url.path == "/v2/o/n/manifests/sha256:amd":
            return httpx.Response(200, json=manifest)
        return httpx.Response(404)
    return httpx.MockTransport(handler), seen


def test_fetch_layer_sizes_follows_token_and_index(monkeypatch):
    monkeypatch.setattr("wadd.registry.platform.machine", lambda: "x86_64")
    transport, seen = fake_registry()

    async def go():
        async with httpx.AsyncClient(transport=transport) as c:
            return await fetch_layer_sizes("ghcr.io/o/n:latest", client=c, auth_files=[])
    assert asyncio.run(go()) == {"sha256:l1": 100, "sha256:l2": 50}
    assert seen["scope"] == "repository:o/n:pull" and seen["token_auth"] is None


def test_fetch_layer_sizes_sends_saved_login_for_private_images(tmp_path, monkeypatch):
    monkeypatch.setattr("wadd.registry.platform.machine", lambda: "x86_64")
    f = tmp_path / "auth.json"
    f.write_text(json.dumps({"auths": {"ghcr.io": {"auth": base64.b64encode(b"u:p").decode()}}}))
    transport, seen = fake_registry(private=True)

    async def go():
        async with httpx.AsyncClient(transport=transport) as c:
            return await fetch_layer_sizes("ghcr.io/o/n:latest", client=c, auth_files=[str(f)])
    assert asyncio.run(go()) == {"sha256:l1": 100, "sha256:l2": 50}
    assert seen["token_auth"].startswith("Basic ")


def test_fetch_layer_sizes_failure_is_none():
    transport = httpx.MockTransport(lambda req: httpx.Response(500))

    async def go():
        async with httpx.AsyncClient(transport=transport) as c:
            return await fetch_layer_sizes("ghcr.io/o/n:latest", client=c, auth_files=[])
    assert asyncio.run(go()) is None


def test_local_blob_digests(tmp_path):
    (tmp_path / "overlay-layers").mkdir()
    (tmp_path / "overlay-layers" / "layers.json").write_text(json.dumps([
        {"id": "a", "compressed-diff-digest": "sha256:l1"}, {"id": "b"}]))
    assert local_blob_digests(str(tmp_path)) == {"sha256:l1"}
    assert local_blob_digests(str(tmp_path / "nowhere")) == set()


def test_rx_bytes_skips_virtual_interfaces(tmp_path):
    for name, n in (("lo", 999), ("wlp1s0", 100), ("enp0s1", 20), ("podman0", 500), ("veth12", 7)):
        d = tmp_path / name / "statistics"
        d.mkdir(parents=True)
        (d / "rx_bytes").write_text(f"{n}\n")
    assert rx_bytes(str(tmp_path)) == 120


def test_pull_progress_math():
    p = PullProgress(total_bytes=1000, layers=3, rx_start=5000, t_start=0)
    p.sample(5000, now=0)
    assert p.percent == 0 and p.eta_s is None
    p.sample(5010, now=1)
    assert p.percent == 1 and p.eta_s is None  # under 2%: no guess yet
    p.sample(5100, now=2)
    assert p.done_bytes == 100 and p.percent == 10
    assert p.eta_s is not None and p.eta_s > 0
    p.sample(9000, now=3)  # other traffic too: never past the cap before finish()
    assert p.percent == 99 and not p.unpacking
    p.sample(9000, now=5)
    assert not p.unpacking
    p.sample(9000, now=6.5)  # nothing new for 3.5 s near the end
    assert p.unpacking and p.eta_s is None and describe(p) == "downloaded 990 B, unpacking"
    p.finish()
    assert p.percent == 100


def test_pull_progress_without_sizes():
    p = PullProgress(total_bytes=None, layers=4, rx_start=0)
    p.sample(10**9, now=1)
    assert p.percent is None and p.eta_s is None and p.done_bytes == 10**9
    assert describe(p) == "downloading 4 layers"


def test_describe():
    p = PullProgress(total_bytes=5_300_000_000, rx_start=0, t_start=0)
    p.sample(1_888_000_000, now=0)
    p.sample(1_900_000_000, now=1)  # 12 MB in the last second
    assert describe(p) == "1.9 GB of 5.3 GB · 12.0 MB/s · about 4 min left"
    assert describe(PullProgress(total_bytes=0)) == "already downloaded, unpacking"
    early = PullProgress(total_bytes=1_000_000_000, rx_start=0)
    early.sample(0, now=0)
    early.sample(7000, now=1)
    assert describe(early) == "7 KB of 1.0 GB"  # no silly "1020 min left"
    assert human_bytes(512) == "512 B" and human_bytes(12_000_000) == "12.0 MB"

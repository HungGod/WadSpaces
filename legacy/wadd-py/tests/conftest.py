import sys
from pathlib import Path

WADD = Path(__file__).resolve().parents[1]   # legacy/wadd-py
REPO = WADD.parents[1]                        # the monorepo root
sys.path.insert(0, str(WADD))
# Unit files and their workspace specs, shared with wad-core and the UI.
FIXTURES = REPO / "fixtures" / "quadlet"
# lsblk output, shared with the Rust wadd's drive tests.
PY_FIXTURES = REPO / "fixtures" / "drives"


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def no_real_github(monkeypatch):
    """A GitHub client a test didn't give a fake transport goes nowhere (the
    discard port refuses at once) rather than to api.github.com."""
    from wadd import github
    monkeypatch.setattr(github, "API", "http://127.0.0.1:9")

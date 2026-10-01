import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
FIXTURES = Path(__file__).parent / "fixtures"


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def no_real_github(monkeypatch):
    """A GitHub client a test didn't give a fake transport goes nowhere (the
    discard port refuses at once) rather than to api.github.com."""
    from wadd import github
    monkeypatch.setattr(github, "API", "http://127.0.0.1:9")

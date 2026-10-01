"""Wad Creator's library on the machine: wadspaces designed in the Builder and
unbuilt drafts, as JSON documents under <state_dir>/library/<collection>/.

The offline app keeps them here rather than in its own storage, so they
survive reinstalling the app and other tools can read them. Documents are
opaque to wadd (the app owns their shape); ids are the same as workspace ids.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

COLLECTIONS = ("wadspaces", "drafts")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
MAX_DOC_BYTES = 24 * 1024 * 1024  # wallpapers ride along as data URLs


class LibraryError(ValueError):
    pass


class Library:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def _path(self, collection: str, doc_id: str | None = None) -> Path:
        if collection not in COLLECTIONS:
            raise LibraryError(f"no collection {collection!r}")
        if doc_id is None:
            return self.root / collection
        if not ID_RE.match(doc_id):
            raise LibraryError(f"bad id {doc_id!r}")
        return self.root / collection / f"{doc_id}.json"

    def list(self, collection: str) -> list[dict]:
        d = self._path(collection)
        out = []
        for f in sorted(d.glob("*.json")) if d.is_dir() else []:
            try:
                out.append(json.loads(f.read_text()))
            except (OSError, ValueError):
                continue  # a half-written or broken file shouldn't hide the rest
        return out

    def get(self, collection: str, doc_id: str) -> dict:
        try:
            return json.loads(self._path(collection, doc_id).read_text())
        except FileNotFoundError:
            raise KeyError(doc_id) from None

    def put(self, collection: str, doc_id: str, doc: dict) -> dict:
        if not isinstance(doc, dict):
            raise LibraryError("a document is a JSON object")
        data = json.dumps(doc)
        if len(data) > MAX_DOC_BYTES:
            raise LibraryError("document too big (24 MB max)")
        path = self._path(collection, doc_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(data)
        os.replace(tmp, path)
        return doc

    def delete(self, collection: str, doc_id: str) -> bool:
        try:
            self._path(collection, doc_id).unlink()
            return True
        except FileNotFoundError:
            return False

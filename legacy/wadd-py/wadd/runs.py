"""When each workspace ran: one JSON line per start and stop in <state_dir>/runs.jsonl.

Wad Creator shows this as the Manager's and each wadspace's history. A run
opens when a workspace's container starts and closes when it stops; a run
still open when wadd restarts is closed then.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

KEEP = 2000  # runs kept when the file is compacted


class RunLog:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.open: dict[str, dict] = {}  # ws_id -> the run in progress

    def _append(self, rec: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "a") as f:
            f.write(json.dumps(rec) + "\n")

    def start(self, ws_id: str, name: str, mode: str, user: str = "local",
              projects: list[str] | None = None) -> dict:
        """projects: the ids of the project folders the run mounts."""
        if ws_id in self.open:
            self.end(ws_id)
        run = {"id": uuid.uuid4().hex[:12], "wadspaceId": ws_id, "wadspaceName": name, "mode": mode,
               "user": user, "projects": list(projects or []), "startedAt": time.time(), "endedAt": None}
        self.open[ws_id] = run
        self._append({"event": "start", **run})
        return run

    def end(self, ws_id: str) -> None:
        run = self.open.pop(ws_id, None)
        if run:
            self._append({"event": "end", "id": run["id"], "endedAt": time.time()})

    def list(self, ws_id: str | None = None, limit: int = 200) -> list[dict]:
        """Newest first. Runs whose end was never written (wadd stopped) end at their last start."""
        runs: dict[str, dict] = {}
        try:
            lines = self.path.read_text().splitlines()
        except FileNotFoundError:
            lines = []
        for line in lines:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("event") == "start":
                runs[rec["id"]] = {k: v for k, v in rec.items() if k != "event"}
            elif rec.get("event") == "end" and rec.get("id") in runs:
                runs[rec["id"]]["endedAt"] = rec["endedAt"]
        open_ids = {r["id"] for r in self.open.values()}
        out = [r for r in runs.values() if (ws_id is None or r["wadspaceId"] == ws_id)]
        for r in out:
            if r["endedAt"] is None and r["id"] not in open_ids:
                r["endedAt"] = r["startedAt"]  # wadd went away mid-run
        out.sort(key=lambda r: r["startedAt"], reverse=True)
        if len(runs) > KEEP * 2:
            self._compact(runs)
        return out[:limit]

    def _compact(self, runs: dict[str, dict]) -> None:
        keep = sorted(runs.values(), key=lambda r: r["startedAt"])[-KEEP:]
        tmp = self.path.with_suffix(".tmp")
        with open(tmp, "w") as f:
            for r in keep:
                f.write(json.dumps({"event": "start", **{k: v for k, v in r.items() if k != "endedAt"}, "endedAt": None}) + "\n")
                if r["endedAt"] is not None:
                    f.write(json.dumps({"event": "end", "id": r["id"], "endedAt": r["endedAt"]}) + "\n")
        tmp.replace(self.path)

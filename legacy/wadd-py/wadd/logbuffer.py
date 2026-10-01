"""The daemon's recent log, kept in memory for Wad Creator's Diagnostics page.

journald has it too on the machine, but this works in dev and needs no
journal access. Everything that leaves through the API goes through redact():
logs get pasted into chats and issues, and must never carry a token.
"""
from __future__ import annotations

import collections
import logging
import re
import threading
import time

REDACTIONS = [
    re.compile(r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"(?i)(authorization[\"']?\s*[:=]\s*[\"']?)(bearer|basic|token)?\s*[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)(x-access-token:)[^@\s]+"),
    re.compile(r"(?i)([\"']?(?:password|psk|secret)[\"']?\s*[:=]\s*[\"']?)[^\"'\s,}]+"),
]


def redact(text: str) -> str:
    for rx in REDACTIONS:
        text = rx.sub(lambda m: (m.group(1) if m.groups() and m.group(1) else "") + "[redacted]", text)
    return text


class RingHandler(logging.Handler):
    def __init__(self, capacity: int = 500) -> None:
        super().__init__(logging.INFO)
        self.records: collections.deque[dict] = collections.deque(maxlen=capacity)
        self._lock_ = threading.Lock()
        self.setFormatter(logging.Formatter("%(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
        except Exception:  # noqa: BLE001 - logging must never raise
            msg = record.getMessage()
        with self._lock_:
            self.records.append({
                "time": record.created,
                "level": record.levelname,
                "logger": record.name,
                "message": redact(msg),
            })

    def tail(self, lines: int = 200, min_level: int = logging.NOTSET) -> list[dict]:
        with self._lock_:
            items = [r for r in self.records if logging.getLevelName(r["level"]) >= min_level]
        return items[-lines:] if lines > 0 else []


_handler: RingHandler | None = None


def install(capacity: int = 500) -> RingHandler:
    """Attach the buffer to the root logger (once)."""
    global _handler
    if _handler is None:
        _handler = RingHandler(capacity)
        logging.getLogger().addHandler(_handler)
    return _handler


def handler() -> RingHandler | None:
    return _handler


STARTED = time.time()

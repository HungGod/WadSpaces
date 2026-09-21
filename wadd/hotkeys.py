"""Global hotkeys read straight from /dev/input.

cage (the kiosk compositor) has no keybinding config, and the Selkies page
captures the keyboard for the remote desktop, so chords are detected below
both: wadd reads every keyboard's evdev node. Reads are non-exclusive (no
EVIOCGRAB), so the compositor, Chromium and the workspace still get every key.

Chords: Super+1..9 switch to the workspace with that hotkey, Super+0 and
Super+Space go back to the launcher (configurable).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Awaitable, Callable

log = logging.getLogger(__name__)

try:
    import evdev  # type: ignore
    from evdev import ecodes  # type: ignore
except ImportError:  # pragma: no cover - evdev is optional in dev
    evdev = None
    ecodes = None

# Linux input event codes (linux/input-event-codes.h), so the chord logic works
# and is testable without python-evdev installed.
KEYCODES = {
    **{f"KEY_{n}": n + 1 for n in range(1, 10)},  # KEY_1 = 2 ... KEY_9 = 10
    "KEY_0": 11,
    "KEY_SPACE": 57,
    "KEY_ESC": 1,
    "KEY_LEFTMETA": 125,
    "KEY_RIGHTMETA": 126,
}
META = {KEYCODES["KEY_LEFTMETA"], KEYCODES["KEY_RIGHTMETA"]}
EV_KEY = 1
KEY_UP, KEY_DOWN, KEY_REPEAT = 0, 1, 2

Action = Callable[[], Awaitable[None]]


def keycode(name: str) -> int:
    if name in KEYCODES:
        return KEYCODES[name]
    if ecodes is not None and name in ecodes.ecodes:
        return int(ecodes.ecodes[name])
    raise ValueError(f"unknown key name {name!r}")


class ChordTracker:
    """Pure chord logic: feed key events, get back the bound action name."""

    def __init__(self, bindings: dict[int, str], debounce_s: float = 0.3) -> None:
        self.bindings = bindings
        self.debounce_s = debounce_s
        self.meta_down: set[int] = set()
        self._last: dict[str, float] = {}

    def feed(self, code: int, value: int, now: float | None = None) -> str | None:
        if code in META:
            if value == KEY_UP:
                self.meta_down.discard(code)
            else:
                self.meta_down.add(code)
            return None
        if value != KEY_DOWN or not self.meta_down or code not in self.bindings:
            return None
        action = self.bindings[code]
        now = time.monotonic() if now is None else now
        if now - self._last.get(action, -1e9) < self.debounce_s:
            return None
        self._last[action] = now
        return action


class HotkeyListener:
    def __init__(self, bindings: dict[int, str], on_action: Callable[[str], Awaitable[None]],
                 rescan_s: float = 2.0) -> None:
        self.tracker = ChordTracker(bindings)
        self.on_action = on_action
        self.rescan_s = rescan_s
        self._tasks: dict[str, asyncio.Task] = {}
        self.devices: list[str] = []

    @staticmethod
    def supported() -> tuple[bool, str]:
        if evdev is None:
            return False, "python-evdev is not installed"
        paths = evdev.list_devices()
        if not paths and os.path.isdir("/dev/input"):
            return False, "no readable /dev/input/event* (need root or the input group)"
        return True, ""

    def _is_keyboard(self, dev) -> bool:
        keys = dev.capabilities().get(ecodes.EV_KEY, [])
        return ecodes.KEY_LEFTMETA in keys and ecodes.KEY_1 in keys

    async def _read(self, path: str, dev) -> None:
        log.info("hotkeys: listening on %s (%s)", path, dev.name)
        try:
            async for ev in dev.async_read_loop():
                if ev.type != EV_KEY:
                    continue
                action = self.tracker.feed(ev.code, ev.value)
                if action:
                    log.info("hotkey: %s", action)
                    asyncio.create_task(self.on_action(action))
        except OSError:
            log.info("hotkeys: %s went away", path)
        finally:
            try:
                dev.close()
            except Exception:
                pass
            self._tasks.pop(path, None)

    async def run(self) -> None:
        if evdev is None:
            log.warning("hotkeys disabled: python-evdev is not installed")
            return
        while True:
            for path in evdev.list_devices():
                if path in self._tasks:
                    continue
                try:
                    dev = evdev.InputDevice(path)
                except OSError:
                    continue
                if not self._is_keyboard(dev):
                    dev.close()
                    continue
                self._tasks[path] = asyncio.create_task(self._read(path, dev))
            self.devices = sorted(self._tasks)
            await asyncio.sleep(self.rescan_s)

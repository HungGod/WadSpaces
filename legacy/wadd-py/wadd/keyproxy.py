"""Keyboard proxy: wadd owns the keyboard, then passes keys on to the kiosk.

cage (the kiosk compositor) has no keybinding config, and inside a workspace the
Selkies page sends every key to the remote desktop, so nothing above wadd can
reserve a chord. wadd therefore grabs each physical keyboard exclusively
(EVIOCGRAB) and re-emits what it doesn't keep through a virtual uinput keyboard
named `wadspaces-kbd`, which cage reads like any other keyboard.

What wadd keeps (KeyRouter):
  Super              never forwarded, so it can't do anything inside a workspace
  Super+Tab          open the switcher / next; Super+Shift+Tab: previous
  release Super      switch to the selected item; Esc (while open) cancels
  Super+1..9         jump to the workspace with that hotkey
  Super+0, +Space    back to the launcher (daemon.keys.launcher)
  daemon.keys.block  chords that are dropped (default Alt+F4, Ctrl+Shift+Q,
                     Ctrl+Alt+Backspace). Modifiers must match exactly, so
                     Ctrl+Alt+F1..F12 still reach the console.

If the grab isn't possible (no /dev/uinput, not root: a dev machine), the proxy
falls back to reading keyboards without grabbing: chords still trigger actions
but nothing is filtered. If wadd dies, the kernel drops the grab and the
keyboard goes straight to cage again.
"""
from __future__ import annotations

import asyncio
import logging
import os
import select
import threading
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

log = logging.getLogger(__name__)

try:
    import evdev  # type: ignore
    from evdev import ecodes  # type: ignore
except ImportError:  # pragma: no cover - evdev is optional in dev
    evdev = None
    ecodes = None

# Linux input event codes (linux/input-event-codes.h), so the routing logic
# works and is testable without python-evdev installed.
KEYCODES = {
    **{f"KEY_{n}": n + 1 for n in range(1, 10)},  # KEY_1 = 2 ... KEY_9 = 10
    "KEY_0": 11,
    "KEY_ESC": 1,
    "KEY_BACKSPACE": 14,
    "KEY_TAB": 15,
    "KEY_Q": 16,
    "KEY_W": 17,
    "KEY_A": 30,
    "KEY_SPACE": 57,
    **{f"KEY_F{n}": 58 + n for n in range(1, 11)},  # KEY_F1 = 59 ... KEY_F10 = 68
    "KEY_F11": 87,
    "KEY_F12": 88,
    "KEY_LEFTCTRL": 29,
    "KEY_RIGHTCTRL": 97,
    "KEY_LEFTSHIFT": 42,
    "KEY_RIGHTSHIFT": 54,
    "KEY_LEFTALT": 56,
    "KEY_RIGHTALT": 100,
    "KEY_LEFTMETA": 125,
    "KEY_RIGHTMETA": 126,
}
MODIFIERS = {
    "ctrl": {KEYCODES["KEY_LEFTCTRL"], KEYCODES["KEY_RIGHTCTRL"]},
    "shift": {KEYCODES["KEY_LEFTSHIFT"], KEYCODES["KEY_RIGHTSHIFT"]},
    "alt": {KEYCODES["KEY_LEFTALT"], KEYCODES["KEY_RIGHTALT"]},
    "super": {KEYCODES["KEY_LEFTMETA"], KEYCODES["KEY_RIGHTMETA"]},
}
META = MODIFIERS["super"]
TAB, ESC = KEYCODES["KEY_TAB"], KEYCODES["KEY_ESC"]
EV_SYN, EV_KEY, EV_LED = 0, 1, 17
KEY_UP, KEY_DOWN, KEY_REPEAT = 0, 1, 2
VIRTUAL_NAME = "wadspaces-kbd"
DEFAULT_BLOCK = ["alt+f4", "ctrl+shift+q", "ctrl+alt+backspace"]


def keycode(name: str) -> int:
    if name in KEYCODES:
        return KEYCODES[name]
    if ecodes is not None and name in ecodes.ecodes:
        return int(ecodes.ecodes[name])
    raise ValueError(f"unknown key name {name!r}")


@dataclass(frozen=True)
class Chord:
    mods: frozenset[str]
    key: int

    @classmethod
    def parse(cls, text: str) -> "Chord":
        """'alt+f4' / 'ctrl+shift+q' / 'ctrl+alt+KEY_BACKSPACE'."""
        parts = [p.strip() for p in text.split("+") if p.strip()]
        if not parts:
            raise ValueError(f"empty chord {text!r}")
        mods = {p.lower() for p in parts[:-1]}
        bad = mods - set(MODIFIERS)
        if bad:
            raise ValueError(f"chord {text!r}: unknown modifiers {sorted(bad)}")
        key = parts[-1]
        name = key if key.upper().startswith("KEY_") else f"KEY_{key}"
        return cls(frozenset(mods), keycode(name.upper()))


Event = tuple[int, int]  # (code, value) of an EV_KEY event


class KeyRouter:
    """Pure routing: feed a key event, get back what to forward and an action.

    Actions: "carousel_next", "carousel_prev", "carousel_commit",
    "carousel_cancel", plus the values of `bindings` (Super+key)."""

    def __init__(self, bindings: dict[int, str], block: list[Chord] | None = None,
                 pass_super: bool = False) -> None:
        self.bindings = bindings
        self.block = list(block or [])
        self.pass_super = pass_super
        self.held: set[int] = set()       # physical keys down right now
        self.forwarded: set[int] = set()  # keys whose down went out: their up must too
        self.carousel = False

    def _mods_held(self) -> frozenset[str]:
        return frozenset(m for m, codes in MODIFIERS.items() if codes & self.held)

    def _blocked(self, code: int) -> bool:
        mods = self._mods_held()
        return any(c.key == code and c.mods == mods for c in self.block)

    def feed(self, code: int, value: int) -> tuple[list[Event], str | None]:
        if value == KEY_UP:
            self.held.discard(code)
        elif value == KEY_DOWN:
            self.held.add(code)

        # Ups and repeats follow whatever happened to their key's down.
        if value != KEY_DOWN:
            action = None
            if code in META and value == KEY_UP and not (META & self.held) and self.carousel:
                self.carousel = False
                action = "carousel_commit"
            if code in self.forwarded:
                if value == KEY_UP:
                    self.forwarded.discard(code)
                return [(code, value)], action
            return [], action

        # A new key down.
        super_held = bool(META & self.held)
        if code in META:
            return self._forward(code) if self.pass_super else ([], None)
        if super_held:
            if code == TAB:
                self.carousel = True
                shift = bool(MODIFIERS["shift"] & self.held)
                return [], "carousel_prev" if shift else "carousel_next"
            if code == ESC and self.carousel:
                self.carousel = False
                return [], "carousel_cancel"
            if code in self.bindings:
                return [], self.bindings[code]
            # Super is the host's: other Super chords never reach a workspace.
            return self._forward(code) if self.pass_super else ([], None)
        if self._blocked(code):
            log.info("blocked chord (key %d)", code)
            return [], None
        return self._forward(code)

    def _forward(self, code: int) -> tuple[list[Event], None]:
        self.forwarded.add(code)
        return [(code, KEY_DOWN)], None

    def release_all(self) -> list[Event]:
        """Key-ups for everything forwarded, so nothing stays stuck."""
        out = [(code, KEY_UP) for code in sorted(self.forwarded)]
        self.forwarded.clear()
        self.held.clear()
        self.carousel = False
        return out


def is_keyboard(dev) -> bool:
    if dev.name == VIRTUAL_NAME:
        return False
    keys = dev.capabilities().get(EV_KEY, [])
    return KEYCODES["KEY_A"] in keys and KEYCODES["KEY_1"] in keys


class GrabProxy:
    """Runs the router over every keyboard in its own thread, so a busy asyncio
    loop can never stall typing. Actions are handed to the loop."""

    def __init__(self, router: KeyRouter, on_action: Callable[[str], Awaitable[None]],
                 loop: asyncio.AbstractEventLoop, grab: bool = True, rescan_s: float = 2.0) -> None:
        self.router = router
        self.on_action = on_action
        self.loop = loop
        self.want_grab = grab
        self.rescan_s = rescan_s
        self.devices: dict[int, object] = {}  # fd -> InputDevice
        self.ui = None
        self.grabbing = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    @staticmethod
    def supported() -> tuple[bool, str]:
        if evdev is None:
            return False, "python-evdev is not installed"
        if not evdev.list_devices() and os.path.isdir("/dev/input"):
            return False, "no readable /dev/input/event* (need root or the input group)"
        return True, ""

    @property
    def device_names(self) -> list[str]:
        return sorted(getattr(d, "path", "?") for d in self.devices.values())

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        if self.want_grab:
            try:
                self.ui = evdev.UInput(
                    {EV_KEY: sorted(set(range(1, 256)) - {0}),
                     EV_LED: [ecodes.LED_NUML, ecodes.LED_CAPSL, ecodes.LED_SCROLLL]},
                    name=VIRTUAL_NAME)
                self.grabbing = True
            except Exception as e:  # noqa: BLE001 - fall back to listening only
                log.warning("keyboard grab unavailable (%s); hotkeys work but nothing is filtered", e)
        self._thread = threading.Thread(target=self._run, name="keyproxy", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    # ------------------------------------------------------------ plumbing
    def _scan(self) -> None:
        known = {getattr(d, "path", None) for d in self.devices.values()}
        for path in evdev.list_devices():
            if path in known:
                continue
            try:
                dev = evdev.InputDevice(path)
            except OSError:
                continue
            if not is_keyboard(dev):
                dev.close()
                continue
            if self.grabbing:
                if dev.active_keys():
                    dev.close()  # a key is down right now: grab it next scan
                    continue
                try:
                    dev.grab()
                except OSError as e:
                    log.warning("could not grab %s (%s): %s", path, dev.name, e)
                    dev.close()
                    continue
            self.devices[dev.fd] = dev
            log.info("keyboard %s: %s (%s)", "grabbed" if self.grabbing else "watching", path, dev.name)

    def _drop(self, fd: int) -> None:
        dev = self.devices.pop(fd, None)
        if dev is not None:
            log.info("keyboard %s went away", getattr(dev, "path", fd))
            try:
                dev.close()
            except Exception:  # noqa: BLE001
                pass

    def handle(self, ev) -> None:
        """One event from a physical keyboard."""
        if ev.type != EV_KEY:
            return  # SYN/MSC are re-generated for what we forward
        with self._lock:
            out, action = self.router.feed(ev.code, ev.value)
        if self.ui is not None and out:
            for code, value in out:
                self.ui.write(EV_KEY, code, value)
            self.ui.syn()
        if action:
            log.info("key action: %s", action)
            asyncio.run_coroutine_threadsafe(self.on_action(action), self.loop)

    def _mirror_leds(self) -> None:
        """Caps/Num Lock LEDs are set on the virtual keyboard; show them on the
        real ones."""
        for ev in self.ui.read():
            if ev.type == EV_LED:
                for dev in self.devices.values():
                    try:
                        dev.set_led(ev.code, ev.value)
                    except OSError:
                        pass

    def _run(self) -> None:
        next_scan = 0.0
        try:
            while not self._stop.is_set():
                now = time.monotonic()
                if now >= next_scan:
                    self._scan()
                    next_scan = now + self.rescan_s
                fds = list(self.devices)
                if self.ui is not None:
                    fds.append(self.ui.fd)
                try:
                    ready, _, _ = select.select(fds, [], [], 0.5)
                except (OSError, ValueError):
                    ready = []
                for fd in ready:
                    if self.ui is not None and fd == self.ui.fd:
                        try:
                            self._mirror_leds()
                        except (OSError, BlockingIOError):
                            pass
                        continue
                    dev = self.devices.get(fd)
                    if dev is None:
                        continue
                    try:
                        for ev in dev.read():
                            self.handle(ev)
                    except BlockingIOError:
                        continue
                    except OSError:
                        self._drop(fd)
        finally:
            self._shutdown()

    def _shutdown(self) -> None:
        with self._lock:
            ups = self.router.release_all()
        if self.ui is not None:
            for code, value in ups:
                self.ui.write(EV_KEY, code, value)
            if ups:
                self.ui.syn()
        for fd in list(self.devices):
            dev = self.devices.pop(fd)
            try:
                if self.grabbing:
                    dev.ungrab()
                dev.close()
            except OSError:
                pass
        if self.ui is not None:
            self.ui.close()

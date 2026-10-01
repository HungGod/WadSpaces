import pytest

from wadd.keyproxy import (KEY_DOWN, KEY_REPEAT, KEY_UP, KEYCODES, Chord, GrabProxy, KeyRouter,
                           VIRTUAL_NAME, is_keyboard)

K = KEYCODES
SUPER, TAB, ESC, SHIFT = K["KEY_LEFTMETA"], K["KEY_TAB"], K["KEY_ESC"], K["KEY_LEFTSHIFT"]
ALT, CTRL, F4, F2, A = K["KEY_LEFTALT"], K["KEY_LEFTCTRL"], K["KEY_F4"], K["KEY_F2"], K["KEY_A"]


def router(**kw):
    return KeyRouter({K["KEY_1"]: "switch:writing", K["KEY_0"]: "launcher"},
                     [Chord.parse(c) for c in ("alt+f4", "ctrl+shift+q", "ctrl+alt+backspace")], **kw)


def feed(r, *events):
    """Run (code, value) pairs; return everything forwarded and the actions."""
    out, actions = [], []
    for code, value in events:
        fwd, action = r.feed(code, value)
        out += fwd
        if action:
            actions.append(action)
    return out, actions


def test_plain_typing_passes_through_with_repeats():
    out, actions = feed(router(), (A, KEY_DOWN), (A, KEY_REPEAT), (A, KEY_UP))
    assert out == [(A, KEY_DOWN), (A, KEY_REPEAT), (A, KEY_UP)] and actions == []


def test_super_is_swallowed_and_super_chords_never_reach_the_workspace():
    out, actions = feed(router(), (SUPER, KEY_DOWN), (A, KEY_DOWN), (A, KEY_UP), (SUPER, KEY_UP))
    assert out == [] and actions == []


def test_super_number_jumps():
    out, actions = feed(router(), (SUPER, KEY_DOWN), (K["KEY_1"], KEY_DOWN), (K["KEY_1"], KEY_UP),
                        (SUPER, KEY_UP))
    assert out == [] and actions == ["switch:writing"]


def test_super_tab_cycles_then_commits_on_release():
    out, actions = feed(router(), (SUPER, KEY_DOWN),
                        (TAB, KEY_DOWN), (TAB, KEY_UP),
                        (TAB, KEY_DOWN), (TAB, KEY_UP),
                        (SHIFT, KEY_DOWN), (TAB, KEY_DOWN), (TAB, KEY_UP), (SHIFT, KEY_UP),
                        (SUPER, KEY_UP))
    assert out == []
    assert actions == ["carousel_next", "carousel_next", "carousel_prev", "carousel_commit"]


def test_esc_cancels_and_release_then_does_nothing():
    out, actions = feed(router(), (SUPER, KEY_DOWN), (TAB, KEY_DOWN), (TAB, KEY_UP),
                        (ESC, KEY_DOWN), (ESC, KEY_UP), (SUPER, KEY_UP))
    assert actions == ["carousel_next", "carousel_cancel"] and out == []


def test_esc_without_carousel_is_just_swallowed_with_super():
    _, actions = feed(router(), (SUPER, KEY_DOWN), (ESC, KEY_DOWN))
    assert actions == []


def test_alt_f4_is_blocked_but_alt_still_releases():
    out, actions = feed(router(), (ALT, KEY_DOWN), (F4, KEY_DOWN), (F4, KEY_REPEAT), (F4, KEY_UP),
                        (ALT, KEY_UP))
    assert out == [(ALT, KEY_DOWN), (ALT, KEY_UP)]  # the app sees a lone Alt, never F4
    assert actions == []


def test_blocking_needs_the_exact_modifiers():
    # Ctrl+Alt+F4 switches to a text console: must not be caught by alt+f4.
    out, _ = feed(router(), (CTRL, KEY_DOWN), (ALT, KEY_DOWN), (F4, KEY_DOWN), (F4, KEY_UP))
    assert (F4, KEY_DOWN) in out and (F4, KEY_UP) in out
    out, _ = feed(router(), (F4, KEY_DOWN), (F4, KEY_UP))  # plain F4 is fine
    assert out == [(F4, KEY_DOWN), (F4, KEY_UP)]


def test_console_switch_passes():
    out, _ = feed(router(), (CTRL, KEY_DOWN), (ALT, KEY_DOWN), (F2, KEY_DOWN))
    assert out[-1] == (F2, KEY_DOWN)


def test_key_held_before_super_still_releases():
    # Shift was forwarded before Super went down: its up must follow.
    out, actions = feed(router(), (SHIFT, KEY_DOWN), (SUPER, KEY_DOWN), (TAB, KEY_DOWN),
                        (SHIFT, KEY_UP), (SUPER, KEY_UP))
    assert out == [(SHIFT, KEY_DOWN), (SHIFT, KEY_UP)]
    assert actions == ["carousel_prev", "carousel_commit"]


def test_pass_super_forwards_other_super_chords():
    out, _ = feed(router(pass_super=True), (SUPER, KEY_DOWN), (A, KEY_DOWN), (A, KEY_UP), (SUPER, KEY_UP))
    assert out == [(SUPER, KEY_DOWN), (A, KEY_DOWN), (A, KEY_UP), (SUPER, KEY_UP)]


def test_release_all_lifts_forwarded_keys():
    r = router()
    feed(r, (CTRL, KEY_DOWN), (A, KEY_DOWN))
    assert r.release_all() == [(CTRL, KEY_UP), (A, KEY_UP)]  # CTRL=29 sorts before A=30
    assert r.forwarded == set() and r.release_all() == []


def test_chord_parse():
    assert Chord.parse("Ctrl+Alt+Backspace") == Chord(frozenset({"ctrl", "alt"}), K["KEY_BACKSPACE"])
    assert Chord.parse("alt+KEY_F4").key == F4
    with pytest.raises(ValueError):
        Chord.parse("hyper+f4")
    with pytest.raises(ValueError):
        Chord.parse("alt+nosuchkey")


class FakeDev:
    def __init__(self, name, keys):
        self.name = name
        self._keys = keys

    def capabilities(self):
        return {1: self._keys}


def test_is_keyboard():
    assert is_keyboard(FakeDev("Surface Keyboard", [A, K["KEY_1"], SUPER]))
    assert not is_keyboard(FakeDev("Surface Button", [114, 115, 116]))  # volume/power
    assert not is_keyboard(FakeDev(VIRTUAL_NAME, [A, K["KEY_1"]]))  # our own output


class Ev:
    def __init__(self, type_, code, value):
        self.type, self.code, self.value = type_, code, value


class FakeUInput:
    def __init__(self):
        self.written = []

    def write(self, type_, code, value):
        self.written.append((code, value))

    def syn(self):
        self.written.append("syn")


def test_proxy_handle_forwards_and_hands_actions_to_the_loop():
    import asyncio

    got = []

    async def on_action(a):
        got.append(a)

    async def go():
        proxy = GrabProxy(router(), on_action, asyncio.get_running_loop())
        proxy.ui = FakeUInput()
        for ev in [Ev(1, A, 1), Ev(4, 4, 30), Ev(1, A, 0),
                   Ev(1, SUPER, 1), Ev(1, K["KEY_0"], 1), Ev(1, SUPER, 0)]:
            await asyncio.to_thread(proxy.handle, ev)
        await asyncio.sleep(0.05)
        return proxy.ui.written

    written = asyncio.run(go())
    assert written == [(A, 1), "syn", (A, 0), "syn"]  # MSC dropped, Super swallowed
    assert got == ["launcher"]

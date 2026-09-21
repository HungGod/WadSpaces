from wadd.hotkeys import KEY_DOWN, KEY_REPEAT, KEY_UP, KEYCODES, ChordTracker

META = KEYCODES["KEY_LEFTMETA"]
K1, K0 = KEYCODES["KEY_1"], KEYCODES["KEY_0"]


def tracker():
    return ChordTracker({K1: "switch:writing", K0: "launcher"})


def test_chord():
    t = tracker()
    assert t.feed(META, KEY_DOWN, 0) is None
    assert t.feed(K1, KEY_DOWN, 0) == "switch:writing"


def test_no_meta_no_action():
    assert tracker().feed(K1, KEY_DOWN, 0) is None


def test_meta_released():
    t = tracker()
    t.feed(META, KEY_DOWN, 0)
    t.feed(META, KEY_UP, 0)
    assert t.feed(K0, KEY_DOWN, 0) is None


def test_repeat_and_debounce():
    t = tracker()
    t.feed(META, KEY_DOWN, 0)
    assert t.feed(K0, KEY_DOWN, 0) == "launcher"
    assert t.feed(K0, KEY_REPEAT, 0.05) is None
    assert t.feed(K0, KEY_DOWN, 0.1) is None
    assert t.feed(K0, KEY_DOWN, 1.0) == "launcher"


def test_unbound_key():
    t = tracker()
    t.feed(META, KEY_DOWN, 0)
    assert t.feed(KEYCODES["KEY_9"], KEY_DOWN, 0) is None

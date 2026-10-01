from wadd.network import key_mgmt, parse_wifi_list, split_terse


def test_split_terse_unescapes():
    assert split_terse(r"*:Cafe\: 2nd floor:66:WPA2") == ["*", "Cafe: 2nd floor", "66", "WPA2"]
    assert split_terse(r"a\\b:c") == ["a\\b", "c"]
    assert split_terse("::") == ["", "", ""]


def test_key_mgmt():
    assert key_mgmt("") == "" and key_mgmt("--") == ""
    assert key_mgmt("WPA2") == "wpa-psk"
    assert key_mgmt("WPA1 WPA2") == "wpa-psk"
    assert key_mgmt("WPA2 WPA3") == "wpa-psk"
    assert key_mgmt("WPA3") == "sae"
    assert key_mgmt("WPA2 802.1X") is None
    assert key_mgmt("WEP") is None


def test_parse_wifi_list_dedupes_and_sorts():
    out = "\n".join([
        ":Home:40:WPA2",
        "*:Home:70:WPA2",
        r":Cafe\: guest:90:",
        ":Home:55:WPA2",
        "::80:WPA2",  # hidden
        ":Uni:30:WPA2 802.1X",
    ])
    nets = parse_wifi_list(out, known={"Home"})
    assert [n["ssid"] for n in nets] == ["Home", "Cafe: guest", "Uni"]
    home, cafe, uni = nets
    assert home["active"] and home["signal"] == 70 and home["known"] and home["secure"]
    assert not cafe["secure"] and cafe["supported"] and not cafe["known"]
    assert not uni["supported"]

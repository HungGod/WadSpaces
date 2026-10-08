"""A stand-in wadd for checking the machine UI: offline, not linked, a few
Wi-Fi networks, nothing installed. python3 fake-wadd.py PORT"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SNAP = {"machine": "Surface (fake)", "version": "0.1.0", "view": "launcher", "pending": None, "kiosk_connected": False,
        "backend": "podman", "backend_connected": True, "enrolled": False, "cloud_enabled": True, "machine_id": None,
        "owner_uid": None, "hotkey_devices": 0, "session": None, "native_display": True, "workspaces": [],
        "network": {"available": True, "state": "disconnected", "connectivity": "none", "wifi_enabled": True,
                    "wifi_device": "wlp1s0", "ssid": None, "signal": None}}
WIFI = [{"ssid": "Home Network", "signal": 82, "security": "WPA2", "secure": True, "supported": True, "active": False, "known": False},
        {"ssid": "Cafe Guest", "signal": 54, "security": "", "secure": False, "supported": True, "active": False, "known": False},
        {"ssid": "Office 802.1X", "signal": 40, "security": "WPA2 802.1X", "secure": True, "supported": False, "active": False, "known": False}]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/events":
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            self.wfile.write(f"event: state\ndata: {json.dumps(SNAP)}\n\n".encode())
            self.wfile.flush()
            try:
                while True:
                    time.sleep(10)
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
            except OSError:
                return
        if p == "/api/network/wifi":
            return self.send(200, WIFI)
        if p == "/api/tailnet":
            return self.send(200, {"installed": False})
        if p == "/api/github":
            return self.send(200, {"token": False, "login": None})
        if p in ("/api/specs", "/api/builds", "/api/projects", "/api/runs", "/api/launches") or p.startswith("/api/library/"):
            return self.send(200, [])
        return self.send(404, {"detail": "Not Found"})

    def do_POST(self):
        if self.path == "/api/network/wifi/connect":
            return self.send(400, {"detail": "Secrets were required, but not provided"})
        return self.send(404, {"detail": "Not Found"})


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()

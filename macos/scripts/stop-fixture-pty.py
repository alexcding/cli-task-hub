#!/usr/bin/env python3
"""Stop only the PTY daemon and shells belonging to a test-browser-ui fixture."""
import json
import os
from pathlib import Path
import re
import signal
import socket
import sys
import time


def stop(socket_path: Path, fixture: Path):
    fixture = fixture.resolve()
    if not fixture.name.startswith("taskhub-browser-ui.") or not re.fullmatch(r"taskhub-bui-\d+\.sock", socket_path.name):
        raise ValueError("Expected an isolated browser UI fixture and socket")
    if socket_path.parent.resolve() != fixture.parent:
        raise ValueError("Fixture and socket must share their temporary parent")
    if not socket_path.exists():
        return
    expected = int((fixture / "ptyd-native-spike/ptyd.pid").read_text())
    if expected <= 1:
        raise ValueError("Invalid fixture daemon PID")
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(3)
        try:
            client.connect(str(socket_path))
        except (FileNotFoundError, ConnectionRefusedError):
            return  # A stopped daemon may leave its socket behind; never signal its old PID.
        reader = client.makefile("rb")
        sequence = 0

        def request(op):
            nonlocal sequence
            sequence += 1
            client.sendall((json.dumps({"id": sequence, "op": op}) + "\n").encode())
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                client.settimeout(max(0.001, deadline - time.monotonic()))
                line = reader.readline(1048576)
                if not line.endswith(b"\n"):
                    raise ValueError("Invalid or closed fixture daemon response")
                response = json.loads(line)
                if response.get("id") == sequence:
                    if "err" in response:
                        raise ValueError(response["err"])
                    return response["ok"]
            raise TimeoutError("Fixture daemon response timed out")

        def verify_owner():
            hello = request("hello")
            if hello.get("pid") != expected or hello.get("protocol") != 2:
                raise ValueError("Fixture daemon identity changed")

        verify_owner()
        terms = request("list")
        if any(not Path(term["cwd"]).resolve().is_relative_to(fixture) for term in terms):
            raise ValueError("A terminal is outside this test fixture; refusing cleanup")
        request("killAll")
        for _ in range(50):
            if not request("list"):
                verify_owner()
                os.kill(expected, signal.SIGTERM)
                print(f"Stopped fixture PTY daemon {expected}")
                return
            time.sleep(0.05)
        raise TimeoutError("Fixture terminals did not stop")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: stop-fixture-pty.py SOCKET FIXTURE_DIRECTORY")
    try:
        stop(Path(sys.argv[1]), Path(sys.argv[2]))
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(f"Fixture PTY cleanup failed: {error}")

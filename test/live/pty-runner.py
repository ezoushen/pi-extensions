"""Run Pi behind a real PTY; stdin accepts JSON commands, stdout is terminal bytes."""

import base64
import fcntl
import json
import os
import select
import signal
import struct
import sys
import termios


pid, master = os.forkpty()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 110, 0, 0))
pending = b""
try:
    while True:
        readable, _, _ = select.select([master, sys.stdin.buffer], [], [], 0.2)
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin.buffer in readable:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                command = json.loads(line)
                if command["type"] == "send":
                    os.write(master, base64.b64decode(command["data"]))
                elif command["type"] == "stop":
                    os.killpg(pid, signal.SIGTERM)
                    break
finally:
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
    os.close(master)

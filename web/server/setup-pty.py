#!/usr/bin/env python3
"""A bounded PTY for herdr's interactive setup, not a persistent session backend."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

child, master = pty.fork()
if child == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 100, 0, 0))
pending = b''

def stop(*_):
    try:
        os.killpg(child, signal.SIGTERM)
        time.sleep(0.2)
        os.killpg(child, signal.SIGKILL)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while True:
        readable, _, _ = select.select([master, sys.stdin.fileno()], [], [])
        if master in readable:
            try:
                data = os.read(master, 8192)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin.fileno() in readable:
            chunk = os.read(sys.stdin.fileno(), 8192)
            if not chunk:
                stop()
                break
            pending += chunk
            if len(pending) > 16384:
                raise ValueError('Setup input too large')
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                value = json.loads(line)
                text = value.get('input')
                if not isinstance(text, str) or len(text.encode()) > 4096:
                    raise ValueError('Invalid setup input')
                data = text.encode()
                while data:
                    count = os.write(master, data)
                    data = data[count:]
finally:
    stop()
    os.close(master)
_, status = os.waitpid(child, 0)
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 1)

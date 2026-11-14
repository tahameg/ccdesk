#!/usr/bin/env python3
"""A tiny pseudo-terminal bridge for the app's terminal panel (no native Node module needed).
usage: pty-helper.py <cwd> <program> [args…]
stdin → the terminal, the terminal → stdout; fd 3 takes resize lines: {"cols": 120, "rows": 30}"""
import fcntl, json, os, pty, select, signal, struct, sys, termios

cwd, argv = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(argv[0], argv)

CTRL = 3
fds = [0, CTRL, fd]
buf = b""


def resize(rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(f, data):
    while data:
        n = os.write(f, data)
        data = data[n:]


try:
    while True:
        r, _, _ = select.select(fds, [], [])
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            write_all(1, data)
        if 0 in r:
            data = os.read(0, 65536)
            if not data:  # the app closed the terminal
                break
            write_all(fd, data)
        if CTRL in r:
            data = os.read(CTRL, 4096)
            if not data:
                fds.remove(CTRL)
                continue
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    m = json.loads(line)
                    resize(int(m["rows"]), int(m["cols"]))
                except Exception:
                    pass
finally:
    try:
        os.kill(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    try:
        _, status = os.waitpid(pid, 0)
        sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)
    except ChildProcessError:
        pass

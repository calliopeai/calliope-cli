"""POSIX PTY bridge for the actual Ink client; private parent process group."""
import errno
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 160, 0, 0))
# Inherit the qualification parent's group so its timeout kills this bridge,
# the CLI and their ordinary children. Policy groups have their own bounded
# deadline in the CLI. No operator process is touched.
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
try:
    while child.poll() is None:
        readable, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.1)
        for fd in readable:
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if fd == master and error.errno == errno.EIO:
                    break
                raise
            if not data:
                if fd == sys.stdin.fileno():
                    raise RuntimeError("PTY input closed before the terminal exited")
                break
            if fd == master:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            else:
                os.write(master, data)
    sys.exit(child.wait())
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)

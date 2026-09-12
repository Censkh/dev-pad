#!/usr/bin/env python3
"""Real terminal smoke: bun run build && python3 test/ui.py [node|bun|deno].

Uses only Python's standard library; intended for Unix CI runtime matrices.
"""

import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time
import unicodedata


class Screen:
    """Read the cursor/erase sequences these renderers emit, including diffs."""

    def __init__(self, rows, columns):
        self.rows, self.columns = rows, columns
        self.cells = [[" "] * columns for _ in range(rows)]
        self.row = self.column = 0

    def feed(self, data):
        tokens = re.findall(
            r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|"
            r"\x1bP.*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b.|[^\x1b]",
            data.decode("utf-8", errors="replace"), re.S,
        )
        for token in tokens:
            if token.startswith("\x1b["):
                params, command = token[2:-1], token[-1]
                if params.startswith(("?", ">", "<", "=")):
                    continue
                numbers = [int(n or 0) for n in params.split(";") if n.isdigit() or not n]
                first = numbers[0] if numbers else 0
                if command in ("H", "f"):
                    self.row = (first or 1) - 1
                    self.column = ((numbers[1] if len(numbers) > 1 else 1) or 1) - 1
                elif command == "J":
                    if first == 2:
                        self.cells = [[" "] * self.columns for _ in range(self.rows)]
                    elif first == 0:
                        self.cells[self.row][self.column:] = [" "] * (self.columns - self.column)
                        for row in range(self.row + 1, self.rows):
                            self.cells[row] = [" "] * self.columns
                elif command == "K":
                    start = 0 if first == 2 else self.column
                    self.cells[self.row][start:] = [" "] * (self.columns - start)
            elif token.startswith("\x1b"):
                continue
            elif token == "\r":
                self.column = 0
            elif token == "\n":
                self.row += 1
            elif ord(token) >= 32 and not unicodedata.category(token).startswith("C"):
                if unicodedata.combining(token):
                    continue
                width = 2 if unicodedata.east_asian_width(token) in ("W", "F") else 1
                assert 0 <= self.row < self.rows, f"Write beyond {self.rows} rows"
                assert self.column + width <= self.columns, f"Write beyond {self.columns} columns"
                self.cells[self.row][self.column] = token
                self.column += width

    def text(self):
        return "\n".join("".join(row) for row in self.cells)


def read(fd, seconds=0.4):
    output = b""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([fd], [], [], max(0, deadline - time.monotonic()))[0]:
            try:
                output += os.read(fd, 65536)
            except OSError:
                break
    return output


def smoke(runtime):
    module = (Path(__file__).resolve().parents[1] / "dist/ui.js").as_uri()
    source = "import {mountUI} from " + json.dumps(module) + ";\n" + """
import process from 'node:process';
const logs = Array.from({length:600}, (_,id) => ({id,source:'service',message:`line-${id}`}));
const snapshot = {
  title:'PTY Dashboard with a very long title that must stay inside the terminal header',
  services:[{id:'service',name:'Example',status:'ready',url:'http://localhost',
    items:[{label:'Jobs',value:'2',tone:'success'}]}],
  items:[{label:'Env',value:'test'}], logs,
  actions:[{key:'n',label:'append'}], actionLabel:'Idle'
};
const keys = [];
const raw = Boolean(process.stdin.isRaw);
const dispose = await mountUI(() => snapshot, key => {
  keys.push(key);
  if (key === 'n') {
    logs.push({id:600,source:'service',message:'line-600'});
    snapshot.services[0].items[0].value = '3';
    snapshot.actionLabel = 'Custom action completed';
  }
  if (key === 'c') logs.length = 0;
  if (key === '1') snapshot.selectedId = 'service';
  if (key === 'escape') snapshot.selectedId = undefined;
  if (key === 'ctrl+c') {
    dispose(); dispose();
    console.log('CLEAN:'+JSON.stringify({keys,rawRestored:Boolean(process.stdin.isRaw)===raw}));
  }
});
"""
    command = [runtime, "eval", source] if runtime == "deno" else (
        [runtime, "--input-type=module", "--eval", source] if runtime == "node"
        else [runtime, "--eval", source]
    )
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 90, 0, 0))
    before = termios.tcgetattr(slave)
    child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                             env={**os.environ, "TERM": "xterm-256color"})
    screen = Screen(24, 90)
    transcript = b""

    def receive(seconds=0.4):
        nonlocal transcript
        data = read(master, seconds)
        transcript += data
        screen.feed(data)
        return screen.text()

    def key(value):
        os.write(master, value)
        return receive()

    try:
        initial = receive(2)
        assert "PTY Dashboard" in initial, initial
        assert "Jobs: 2" in initial and "Env: test" in initial, initial
        assert "n append" in initial and "c clear" in initial, initial
        assert "line-599" in initial and "line-99" not in initial, initial
        up = key(b"\x1b[A")
        assert "line-598" in up and "line-599" not in up, up
        appended = key(b"n")
        assert "Jobs: 3" in appended and "Custom action completed" in appended, appended
        assert "line-600" not in appended, appended
        down = key(b"\x1b[B\x1b[B")
        assert "line-600" in down, down
        for rows, columns in [(12, 40), (24, 90)]:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            screen = Screen(rows, columns)
            child.send_signal(signal.SIGWINCH)
            resized = receive(0.6)
            assert "PTY Dashboard" in resized and "c clear" in resized, resized
            assert "line-600" in resized, resized
        selected = key(b"1")
        assert "n append" in selected, selected
        assert "Esc back" in selected and "1–9 select" in selected, selected
        assert "Ctrl+C" not in selected and "c clear" not in selected and "↑↓" not in selected, selected
        key(b"\x1b")
        receive(0.6)
        cleared = key(b"c")
        assert "Waiting for service output" in cleared and "line-600" not in cleared, cleared
        key(b"\x1b")
        receive(0.6)  # Let readline distinguish standalone Escape from an Alt chord.
        os.write(master, b"r1q\x03")
        transcript += read(master, 1)
        child.wait(timeout=5)
        assert child.returncode == 0, transcript[-4000:]
        assert b'"keys":["n","1","escape","c","escape","r","1","q","ctrl+c"]' in transcript, transcript[-4000:]
        assert b'"rawRestored":true' in transcript, transcript[-4000:]
        assert b"\x1b[?25h" in transcript and b"\x1b[?1049l" in transcript
        # Deno normalizes some input flags; canonical input, echo and signals must return.
        flags = termios.ICANON | termios.ECHO | termios.ISIG
        assert termios.tcgetattr(slave)[3] & flags == before[3] & flags
        print(f"{runtime}: status, custom action, scroll/anchor, 40x12, clear, quit and cleanup passed")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime", nargs="?", choices=["node", "bun", "deno"])
    args = parser.parse_args()
    for runtime in [args.runtime] if args.runtime else ["node", "bun", "deno"]:
        smoke(runtime)

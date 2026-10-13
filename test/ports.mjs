import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDashboard, killPortListeners, listeningPids, portListening, servicePorts } from "../dist/index.js";

const self = fileURLToPath(import.meta.url);
const runtime = [process.execPath, ...("Deno" in globalThis ? ["run", "-A"] : [])];

if (process.argv[2] === "listen" || process.argv[2] === "stubborn") {
  if (process.argv[2] === "stubborn") process.on("SIGTERM", () => {});
  // Bound fixture lifetime even if the test runner is interrupted.
  setTimeout(() => process.exit(2), 20000);
  const server = createServer((_req, res) => res.end("orphan"));
  server.listen(0, "127.0.0.1", () => console.log(server.address().port));
} else {
  let hasLsof = process.platform !== "win32";
  try {
    if (hasLsof) execFileSync("lsof", ["-v"], { stdio: "ignore" });
  } catch (error) {
    // `lsof -v` exits non-zero on some systems but still exists.
    hasLsof = error.code !== "ENOENT";
  }
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + 8000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, `Timed out: ${description}`);
      await delay(20);
    }
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** A throwaway server outside dev-pad's control, like an orphan from an earlier session. */
  const orphan = async (mode = "listen") => {
    const child = spawn(runtime[0], [...runtime.slice(1), self, mode], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.setEncoding("utf8").once("data", (line) => resolve(Number(line.trim())));
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    return { pid: child.pid, port, exited, cleanup: () => alive(child.pid) && process.kill(child.pid, "SIGKILL") };
  };
  const service = (id, extra = {}) => ({ id, name: `Service ${id}`, start: async () => {}, ...extra });

  test("ports are required, de-duplicated, and accept an explicit none", () => {
    assert.deepEqual(servicePorts(service("api", { ports: [6110, 6120, 6110] })), [6110, 6120]);
    assert.deepEqual(servicePorts(service("api", { port: 6110, ports: [6110, 6120] })), [6110, 6120]);
    assert.deepEqual(servicePorts(service("watcher", { ports: false })), []);
    for (const [extra, pattern] of [
      [{}, /Service api \(api\) must declare the ports/],
      [{ port: 6110 }, /Service api \(api\) must declare the ports/],
      [{ ports: [] }, /Service api \(api\): `ports` must be a non-empty array/],
      [{ ports: 6110 }, /non-empty array/],
      [{ ports: [0] }, /invalid port 0/],
      [{ ports: [65536] }, /invalid port 65536/],
      [{ ports: ["6110"] }, /invalid port 6110/],
      [{ ports: [6110.5] }, /invalid port 6110.5/],
      [{ port: 6100, ports: [6110] }, /`port` 6100 is not listed/],
      [{ port: 6100, ports: false }, /`port` is set but `ports` is false/],
    ])
      assert.throws(() => servicePorts(service("api", extra)), pattern);
  });

  test("a service without ports refuses to start, naming the service", async () => {
    let started = false;
    const start = async () => {
      started = true;
    };
    assert.throws(
      () =>
        createDashboard({
          title: "missing",
          services: [service("ok", { ports: false, start }), service("api", { name: "API + Jobs", start })],
        }),
      /API \+ Jobs \(api\) must declare the ports/,
    );
    assert.throws(
      () => createDashboard({ title: "empty", services: [service("api", { name: "API", ports: [], start })] }),
      /API \(api\): `ports` must be a non-empty array/,
    );
    assert.equal(started, false);
  });

  test("listener lookup asks only for LISTEN sockets and parses lsof and netstat", async () => {
    const calls = [];
    const pids = await listeningPids(6110, {
      platform: "darwin",
      run: async (command, args) => {
        calls.push([command, ...args]);
        return "p4242\ncnode\nf20\nn*:6110\nf21\nn[::1]:6110\np4243\ncbun\nf9\nn127.0.0.1:6110\n";
      },
    });
    assert.deepEqual(pids, [4242, 4243]);
    assert.deepEqual(calls, [["lsof", "-nP", "-iTCP:6110", "-sTCP:LISTEN", "-Fpcn"]]);
    const netstat = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:6110           0.0.0.0:0              LISTENING       100",
      "  TCP    127.0.0.1:52000        127.0.0.1:6110         ESTABLISHED     200",
      "  TCP    0.0.0.0:16110          0.0.0.0:0              LISTENING       300",
      "  TCP    127.0.0.1:6110         127.0.0.1:52000        ESTABLISHED     100",
      "  TCP    [::]:6110              [::]:0                 LISTENING       400",
      "  UDP    0.0.0.0:6110           *:*                                    500",
    ].join("\r\n");
    const windowsCalls = [];
    assert.deepEqual(
      await listeningPids(6110, {
        platform: "win32",
        run: async (command, args) => {
          windowsCalls.push([command, ...args]);
          return netstat;
        },
      }),
      [100, 400],
    );
    assert.deepEqual(windowsCalls, [["netstat", "-ano"]]);
  });

  /** Fake lsof/ps output: `listeners` maps ports to PIDs; `table` rows are [pid, ppid, command]. */
  const fakeSystem = (listeners, table) => {
    const killed = new Set();
    const signals = [];
    return {
      signals,
      options: {
        platform: "darwin",
        self: 10,
        graceMs: 0,
        run: async (command, args) => {
          if (command === "ps") return table.map(([pid, ppid, cmd]) => `${pid} ${ppid} ${cmd}`).join("\n");
          const ports = args
            .find((arg) => arg.startsWith("-iTCP:"))
            .slice(6)
            .split(",")
            .map(Number);
          return ports
            .flatMap((port) =>
              (listeners[port] ?? []).filter((pid) => !killed.has(pid)).map((pid) => `p${pid}\nn127.0.0.1:${port}`),
            )
            .join("\n");
        },
        signal: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === "SIGTERM" && pid !== 666) killed.add(pid);
          if (signal === "SIGKILL") killed.add(pid);
        },
        alive: (pid) => !killed.has(pid),
      },
    };
  };
  const table = [
    [1, 0, "/sbin/launchd"],
    [5, 1, "/bin/zsh"],
    [10, 5, "node dist/cli.js"],
    [20, 1, "node /project/node_modules/wrangler/bin/wrangler.js dev --port 6110 --inspector-port 19240"],
    [21, 20, "/project/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve --binary"],
    [30, 1, "bun run --filter app dev"],
    [31, 30, "node /project/node_modules/.bin/vite"],
    [40, 1, "/Applications/Docker.app/Contents/MacOS/com.docker.backend"],
    [50, 1, "bun run scripts/dev.ts"],
    [51, 50, "bun --hot src/server.ts --port 6120"],
    [666, 1, "node stubborn.js"],
  ];

  test("kills an orphaned workerd and its wrangler parent, but not an unrelated runner", async () => {
    const system = fakeSystem({ 6110: [21], 6100: [31], 6130: [] }, table);
    const result = await killPortListeners([6110, 6100, 6130], system.options);
    assert.deepEqual(
      result.killed.map(({ pid, port, reason }) => [pid, port, reason]),
      [
        [20, 6110, "parent"],
        [21, 6110, "listener"],
        [31, 6100, "listener"],
      ],
    );
    // The wrangler parent stops first so it cannot respawn workerd; `bun run` is left alone.
    assert.deepEqual(system.signals, [
      [20, "SIGTERM"],
      [21, "SIGTERM"],
      [31, "SIGTERM"],
    ]);
    assert.deepEqual(result.idle, [6130]);
    assert.deepEqual(result.stillListening, []);
  });

  test("a runtime parent is killed only when it was started for that port", async () => {
    const system = fakeSystem({ 6120: [51], 6121: [51] }, table);
    const forPort = await killPortListeners([6120], system.options);
    assert.deepEqual(
      forPort.killed.map(({ pid }) => pid),
      [51],
    );
    assert.equal(
      system.signals.some(([pid]) => pid === 50),
      false,
    );
  });

  test("never signals dev-pad, its ancestors, or container runtimes", async () => {
    const system = fakeSystem({ 6100: [10], 6110: [5], 5174: [40] }, table);
    const result = await killPortListeners([6100, 6110, 5174], system.options);
    assert.deepEqual(system.signals, []);
    assert.deepEqual(result.killed, []);
    assert.deepEqual(
      result.skipped.map(({ pid, port }) => [pid, port]),
      [
        [10, 6100],
        [5, 6110],
        [40, 5174],
      ],
    );
    assert.deepEqual(result.stillListening, [6100, 6110, 5174]);
  });

  test("escalates to SIGKILL when a listener survives SIGTERM", async () => {
    const system = fakeSystem({ 7000: [666] }, table);
    const result = await killPortListeners([7000], system.options);
    assert.deepEqual(system.signals, [
      [666, "SIGTERM"],
      [666, "SIGKILL"],
    ]);
    assert.deepEqual(result.stillListening, []);
  });

  test("nothing listening reports idle ports without reading the process table", async () => {
    const commands = [];
    const result = await killPortListeners([6110, 6120], {
      platform: "darwin",
      run: async (command) => {
        commands.push(command);
        return "";
      },
      signal: () => assert.fail("nothing should be signalled"),
    });
    assert.deepEqual(result.idle, [6110, 6120]);
    assert.deepEqual(commands, ["lsof"]);
  });

  test("real orphaned listeners are killed, escalating past SIGTERM", { skip: !hasLsof }, async () => {
    for (const mode of ["listen", "stubborn"]) {
      const fixture = await orphan(mode);
      try {
        assert.equal(await portListening(fixture.port), true);
        const result = await killPortListeners([fixture.port], { graceMs: 300 });
        assert.deepEqual(
          result.killed.map(({ pid }) => pid),
          [fixture.pid],
        );
        await fixture.exited;
        assert.equal(await portListening(fixture.port), false);
        assert.deepEqual(result.stillListening, []);
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("the dev-pad process is never killed for listening on a port", { skip: !hasLsof }, async () => {
    const server = createServer((_req, res) => res.end("dev-pad"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const result = await killPortListeners([port], { graceMs: 100 });
      assert.deepEqual(result.killed, []);
      assert.deepEqual(
        result.skipped.map(({ pid }) => pid),
        [process.pid],
      );
      assert.deepEqual(result.stillListening, [port]);
      assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "dev-pad");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("k stops a running service and kills orphans on all its ports", { skip: !hasLsof }, async () => {
    const stray = await orphan();
    const owned = createServer();
    await new Promise((resolve) => owned.listen(0, "127.0.0.1", resolve));
    const ownedPort = owned.address().port;
    let stops = 0;
    const dashboard = createDashboard({
      title: "kill ports",
      services: [
        service("api", {
          // Started by dev-pad (owned), plus an orphan on the second port.
          ports: [ownedPort, stray.port],
          allowOccupiedPort: true,
          stop: async () => {
            stops++;
            await new Promise((resolve) => owned.close(resolve));
          },
        }),
        service("watcher", { ports: false, autostart: false }),
      ],
    });
    try {
      await dashboard.start();
      assert.equal(dashboard.snapshot().services[0].status, "starting");
      await dashboard.key("1");
      assert.ok(dashboard.snapshot().actions.some((action) => action.key === "k"));
      await dashboard.key("k");
      assert.equal(stops, 1);
      assert.equal(dashboard.snapshot().services[0].status, "stopped");
      await stray.exited;
      await waitFor(async () => !(await portListening(stray.port)), "orphan port released");
      assert.equal(await portListening(ownedPort), false);
      // A service that declares no ports has nothing to kill and keeps running.
      await dashboard.key("2");
      await dashboard.key("r");
      await dashboard.key("k");
      assert.equal(dashboard.snapshot().services[1].status, "ready");
      assert.equal(alive(process.pid), true);
    } finally {
      stray.cleanup();
      if (owned.listening) owned.close();
      await dashboard.shutdown();
    }
  });

  /** A fake lsof that reports `holders` (port → [pid, command]) and records each call's arguments. */
  const fakeLsof = (holders) => {
    const calls = [];
    return {
      calls,
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (command !== "lsof") return "";
        const wanted = args
          .find((arg) => arg.startsWith("-iTCP:"))
          .slice(6)
          .split(",")
          .map(Number);
        return wanted
          .filter((port) => holders.has(port))
          .map((port) => `p${holders.get(port)[0]}\nc${holders.get(port)[1]}\nf15\nn127.0.0.1:${port}\n`)
          .join("");
      },
    };
  };
  const busyPolling = process.platform === "win32" ? "netstat polling is covered by the parser test" : false;

  test("a held port makes a stopped service busy, and freeing it clears busy", { skip: busyPolling }, async () => {
    const holders = new Map();
    const lsof = fakeLsof(holders);
    const dashboard = createDashboard(
      { title: "busy", services: [service("api", { ports: [6110, 6120], autostart: false })] },
      { run: lsof.run },
    );
    const row = () => dashboard.snapshot().services[0];
    try {
      await dashboard.checkPorts();
      assert.equal(row().status, "not started");
      assert.equal(row().detail, undefined);
      holders.set(6120, [4242, "workerd"]);
      await dashboard.checkPorts();
      assert.equal(row().status, "busy");
      assert.match(row().detail, /:6120 .*4242 .*workerd/);
      await dashboard.key("1");
      assert.deepEqual(
        dashboard
          .snapshot()
          .actions.filter((action) => action.highlight)
          .map((action) => action.key),
        ["k"],
      );
      holders.clear();
      await dashboard.checkPorts();
      assert.equal(row().status, "not started");
      assert.equal(
        dashboard.snapshot().actions.some((action) => action.highlight),
        false,
      );
    } finally {
      await dashboard.shutdown();
    }
  });

  test("polling checks every stopped service's ports with one lsof call per tick", { skip: busyPolling }, async () => {
    const lsof = fakeLsof(new Map([[6130, [99, "node"]]]));
    const dashboard = createDashboard(
      {
        title: "poll",
        services: [
          service("api", { ports: [6110, 6120], autostart: false }),
          service("cdn", { ports: [6130, 19230], autostart: false }),
          service("running", { ports: [6140] }),
          service("watcher", { ports: false, autostart: false }),
          service("docker", { ports: [5174], allowOccupiedPort: true, autostart: false }),
        ],
      },
      { run: lsof.run },
    );
    try {
      await dashboard.start();
      await dashboard.health();
      assert.deepEqual(lsof.calls, [["lsof", "-nP", "-iTCP:6110,6120,6130,19230", "-sTCP:LISTEN", "-Fpcn"]]);
      assert.deepEqual(
        dashboard.snapshot().services.map((row) => row.status),
        ["not started", "busy", "starting", "not started", "not started"],
      );
      // The health loop runs every 1.5 s; ports are polled at most every few seconds.
      await dashboard.health();
      assert.equal(lsof.calls.length, 1);
    } finally {
      await dashboard.shutdown();
    }
  });

  test("a start blocked by a foreign listener is busy, not failed", async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    let started = false;
    const dashboard = createDashboard(
      {
        title: "blocked",
        services: [
          service("api", {
            ports: [port],
            start: async () => {
              started = true;
            },
          }),
        ],
      },
      { run: fakeLsof(new Map([[port, [4242, "wrangler"]]])).run },
    );
    try {
      await dashboard.start();
      assert.equal(started, false);
      const row = dashboard.snapshot().services[0];
      assert.equal(row.status, "busy");
      assert.match(row.detail, new RegExp(`:${port} .*4242 .*wrangler`));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await dashboard.shutdown();
    }
  });

  test("k frees a busy service's port and starts it if it was meant to autostart", { skip: !hasLsof }, async () => {
    for (const autostart of [true, false]) {
      const stray = await orphan();
      let starts = 0;
      const dashboard = createDashboard({
        title: "recover",
        // Outside this repository, so startup's same-project reclaim leaves the orphan alone.
        cwd: tmpdir(),
        services: [
          service("api", {
            ports: [stray.port],
            autostart,
            start: async () => {
              starts++;
            },
          }),
        ],
      });
      const status = () => dashboard.snapshot().services[0].status;
      try {
        if (autostart) await dashboard.start();
        else await dashboard.key("1").then(() => dashboard.key("r"));
        assert.equal(status(), "busy");
        assert.equal(starts, 0);
        await dashboard.key("1");
        if (!autostart) await dashboard.key("1");
        assert.equal(dashboard.snapshot().selectedId, "api");
        await dashboard.key("k");
        await stray.exited;
        assert.equal(await portListening(stray.port), false);
        assert.equal(starts, autostart ? 1 : 0);
        assert.equal(status(), autostart ? "starting" : "not started");
      } finally {
        stray.cleanup();
        await dashboard.shutdown();
      }
    }
  });
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDashboard, portListening } from "../dist/index.js";

const self = fileURLToPath(import.meta.url);
const runtime = [process.execPath, ...("Deno" in globalThis ? ["run", "-A"] : [])];
const command = (mode) => [...runtime, self, mode];

// The same executable supplies real child/grandchild fixtures on all three runtimes.
if (process.argv[2] === "grandchild") {
  const server = createServer((_req, res) => res.end("alive"));
  server.listen(0, "127.0.0.1", () => {
    console.log(JSON.stringify({ pid: process.pid, port: server.address().port }));
  });
} else if (process.argv[2] === "service") {
  process.stdout.write("frag");
  await delay(40);
  process.stdout.write("ment\n\x1b[32mgreen\x1b[0m\n⠋ compiling\r");
  await delay(40);
  process.stdout.write("⠙ compiling\r⠹ compiling\rdone\r\n");
  process.stderr.write("err");
  await delay(40);
  process.stderr.write("or\n");
  const child = spawn(runtime[0], command("grandchild").slice(1), {
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.pipe(process.stdout);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (input) => {
    console.log(`input:${input.trim()}`);
  });
} else if (process.argv[2] === "utility") {
  process.stdout.write("utility fragment");
} else if (process.argv[2] === "failure") {
  process.stderr.write("intentional failure");
  process.exitCode = 7;
} else {
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + 8000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, `Timed out: ${description}`);
      await delay(20);
    }
  };
  const test = async (name, run) => {
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`not ok - ${name}\n`, error);
    }
  };
  const service = (id, extra = {}) => ({ id, name: id, start: async () => {}, ...extra });

  await test("real subprocess logs, stdin, restart and process-group shutdown", async () => {
    const dashboard = createDashboard({
      title: "processes",
      services: [{ id: "svc", name: "Service", command: command("service") }],
    });
    const descendants = [];
    const messages = () =>
      dashboard
        .snapshot()
        .logs.filter((log) => log.source === "svc")
        .map((log) => log.message);
    const descendant = async () => {
      await waitFor(() => messages().some((message) => message.startsWith('{"pid":')), "grandchild ready");
      const info = JSON.parse(messages().find((message) => message.startsWith('{"pid":')));
      descendants.push(info);
      return info;
    };
    try {
      assert.equal(dashboard.snapshot().services[0].status, "not started");
      await dashboard.start();
      const first = await descendant();
      await waitFor(() => messages().includes("error"), "both log streams flushed");
      assert.equal(dashboard.snapshot().services[0].status, "ready");
      assert.ok(messages().includes("fragment"));
      assert.ok(messages().includes("green"));
      assert.deepEqual(
        messages().filter((message) => message.includes("compiling")),
        ["⠋ compiling"],
      );
      assert.equal(messages().filter((message) => message === "done").length, 1);
      assert.equal(dashboard.ctx.write("svc", "hello\n"), true);
      await waitFor(() => messages().includes("input:hello"), "stdin delivered");
      assert.equal(await portListening(first.port), true);
      await dashboard.key("c");
      await dashboard.ctx.restart("svc");
      await waitFor(async () => !(await portListening(first.port)), "restart kills old grandchild");
      const second = await descendant();
      assert.notEqual(second.pid, first.pid);
      assert.equal(await portListening(second.port), true);
      assert.equal(await dashboard.shutdown(), 0);
      await waitFor(async () => !(await portListening(second.port)), "shutdown kills new grandchild");
      assert.equal(dashboard.snapshot().services[0].status, "stopped");
      assert.equal(dashboard.ctx.write("svc", "ignored"), false);
      assert.equal(await dashboard.shutdown(), 0);
    } finally {
      await dashboard.shutdown();
      // Clean up even when a process-group regression fails an assertion.
      for (const { pid } of descendants) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
    }
  });

  await test("utility exit fragments and failed exit propagation", async () => {
    const dashboard = createDashboard({ title: "utilities", services: [service("idle")] });
    try {
      assert.equal(await dashboard.ctx.run(command("utility"), { source: "task" }), "utility fragment");
      assert.ok(dashboard.snapshot().logs.some((log) => log.source === "task" && log.message === "utility fragment"));
      await assert.rejects(dashboard.ctx.run(command("failure")), /exited with code 7/);
    } finally {
      await dashboard.shutdown();
    }
    const failed = createDashboard({
      title: "failure",
      services: [{ id: "bad", name: "bad", command: command("failure") }],
    });
    try {
      await failed.start();
      await waitFor(() => failed.snapshot().services[0].status === "failed", "failed child status");
      assert.equal(await failed.shutdown(), 1);
    } finally {
      await failed.shutdown();
    }
  });

  await test("shutdown during a start-hook utility cleans its process group", async () => {
    let stopped = false;
    let descendant;
    const dashboard = createDashboard({
      title: "cancel startup",
      services: [
        service("startup", {
          start: async (ctx) => {
            await ctx.run(command("service"), { source: "startup" });
          },
          stop: async (ctx) => {
            assert.equal(await ctx.run(command("utility")), "utility fragment");
            stopped = true;
          },
        }),
      ],
    });
    const starting = dashboard.start();
    try {
      await waitFor(() => {
        const line = dashboard
          .snapshot()
          .logs.find((log) => log.source === "startup" && log.message.startsWith('{"pid":'));
        if (line) descendant = JSON.parse(line.message);
        return Boolean(descendant);
      }, "start-hook utility ready");
      assert.equal(dashboard.snapshot().actionLabel, "Starting services");
      assert.equal(await portListening(descendant.port), true);
      let finished = false;
      const shuttingDown = dashboard.shutdown().then(() => {
        finished = true;
      });
      await waitFor(() => finished, "shutdown interrupts pending start utility");
      await shuttingDown;
      await starting;
      await waitFor(async () => !(await portListening(descendant.port)), "startup utility descendant terminated");
      assert.equal(stopped, true);
      assert.equal(dashboard.snapshot().services[0].status, "stopped");
      await assert.rejects(dashboard.ctx.run(command("utility")), /stopping/);
    } finally {
      // A failed cleanup assertion must not leave the utility tree running.
      if (descendant) {
        try {
          process.kill(descendant.pid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
      await dashboard.shutdown();
      await starting;
    }
  });

  await test("HTTP health transitions and custom probes", async () => {
    let code = 200;
    let healthy = false;
    const server = createServer((_req, res) => {
      res.writeHead(code);
      res.end("health");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const dashboard = createDashboard({
      title: "health",
      services: [service("http", { url: () => url, probe: "http" }), service("custom", { probe: async () => healthy })],
    });
    const statuses = () => dashboard.snapshot().services.map((row) => row.status);
    try {
      await dashboard.start();
      assert.deepEqual(statuses(), ["starting", "starting"]);
      await dashboard.health();
      assert.deepEqual(statuses(), ["ready", "starting"]);
      code = 503;
      healthy = true;
      await dashboard.health();
      assert.deepEqual(statuses(), ["failed", "ready"]);
      code = 200;
      healthy = false;
      await dashboard.health();
      assert.deepEqual(statuses(), ["ready", "failed"]);
      assert.equal(dashboard.snapshot().services[0].url, url);
    } finally {
      await dashboard.shutdown();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test("custom lifecycle, actions, live header/row status and dependency shutdown", async () => {
    const events = [];
    let value = "before";
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const dashboard = createDashboard({
      title: "custom",
      status: () => [{ label: "Header", value }],
      tick: async (ctx) => ctx.log("tick", "polled"),
      actions: [
        {
          key: "x",
          label: "Wait",
          run: async () => {
            await gate;
            value = "after";
          },
        },
      ],
      services: [
        service("web", {
          dependsOn: ["db"],
          start: async () => {
            events.push("start web");
          },
          stop: async () => {
            events.push("stop web");
          },
          status: () => [{ label: "Row", value }],
          actions: [{ key: "z", label: "Log", run: (ctx) => ctx.log("web", "action") }],
        }),
        service("db", {
          autostart: false,
          start: async () => {
            events.push("start db");
          },
          stop: async () => {
            events.push("stop db");
          },
        }),
        service("manual", { autostart: false }),
      ],
    });
    try {
      await dashboard.start();
      assert.deepEqual(events, ["start db", "start web"]);
      assert.equal(dashboard.snapshot().services[2].status, "not started");
      await dashboard.ctx.stop("manual");
      assert.equal(dashboard.snapshot().services[2].status, "not started");
      await dashboard.ctx.start("manual");
      await dashboard.ctx.stop("manual");
      assert.equal(dashboard.snapshot().services[2].status, "stopped");
      const action = dashboard.key("x");
      assert.equal(dashboard.snapshot().actionLabel, "Wait");
      assert.deepEqual(dashboard.snapshot().items, [{ label: "Header", value: "before" }]);
      release();
      await action;
      assert.equal(dashboard.snapshot().actionLabel, "");
      assert.deepEqual(dashboard.snapshot().services[0].items, [{ label: "Row", value: "after" }]);
      assert.deepEqual(dashboard.snapshot().items, [{ label: "Header", value: "after" }]);
      await dashboard.key("1");
      assert.ok(dashboard.snapshot().actions.some(({ key, label }) => key === "z" && label === "Log"));
      await dashboard.key("z");
      await dashboard.health();
      assert.ok(dashboard.snapshot().logs.some((log) => log.message === "action"));
      assert.ok(dashboard.snapshot().logs.some((log) => log.message === "polled"));
      await dashboard.shutdown();
      assert.deepEqual(events, ["start db", "start web", "stop web", "stop db"]);
    } finally {
      release();
      await dashboard.shutdown();
    }
  });

  await test("restart-all stops dependents before dependencies", async () => {
    const events = [];
    const lifecycle = (id, extra) =>
      service(id, {
        ...extra,
        start: async () => {
          events.push(`start ${id}`);
        },
        stop: async () => {
          events.push(`stop ${id}`);
        },
      });
    const dashboard = createDashboard({
      title: "order",
      services: [lifecycle("web", { dependsOn: ["db"] }), lifecycle("db")],
    });
    try {
      await dashboard.start();
      events.length = 0;
      await dashboard.key("r");
      assert.deepEqual(events, ["stop web", "stop db", "start db", "start web"]);
    } finally {
      await dashboard.shutdown();
    }
  });

  await test("numbers select without running; actions target only the selected service", async () => {
    const events = [];
    const dashboard = createDashboard({
      title: "selection",
      actions: [{ key: "t", label: "global", run: () => events.push("global") }],
      services: ["one", "two"].map((id) =>
        service(id, {
          autostart: false,
          start: async () => {
            events.push(`start ${id}`);
          },
          stop: async () => {
            events.push(`stop ${id}`);
          },
          actions: [{ key: "t", label: `custom ${id}`, run: () => events.push(id) }],
        }),
      ),
    });
    try {
      await dashboard.start();
      await dashboard.key("1");
      assert.deepEqual(events, []);
      assert.equal(dashboard.snapshot().selectedId, "one");
      assert.equal(dashboard.snapshot().services[0].status, "not started");
      await dashboard.key("r");
      await dashboard.key("2");
      assert.deepEqual(events, ["start one"]);
      assert.ok(dashboard.snapshot().actions.some((action) => action.label === "custom two"));
      await dashboard.key("t");
      await dashboard.key("r");
      await dashboard.key("q");
      assert.deepEqual(events, ["start one", "two", "start two", "stop two"]);
      assert.equal(dashboard.snapshot().services[0].status, "ready");
      await dashboard.key("escape");
      assert.equal(dashboard.snapshot().selectedId, undefined);
      await dashboard.key("t");
      assert.equal(events.at(-1), "global");
      await dashboard.key("q");
      assert.equal(dashboard.snapshot().services[0].status, "ready");
      assert.equal(events.at(-1), "global");
    } finally {
      await dashboard.shutdown();
    }
  });

  await test("open is available only for a selected service with a URL", async () => {
    const dashboard = createDashboard({
      title: "open",
      services: [
        service("web", { url: "http://localhost:3000", autostart: false }),
        service("worker", { autostart: false }),
      ],
    });
    const hasOpen = () => dashboard.snapshot().actions.some((action) => action.key === "o");
    try {
      assert.equal(hasOpen(), false);
      await dashboard.key("1");
      assert.equal(hasOpen(), true);
      await dashboard.key("2");
      assert.equal(hasOpen(), false);
      await dashboard.key("escape");
      assert.equal(hasOpen(), false);
    } finally {
      await dashboard.shutdown();
    }
  });

  await test("global service actions apply only at the top level and to their owning service", async () => {
    let launches = 0;
    const dashboard = createDashboard({
      title: "global actions",
      services: [
        service("web", { autostart: false }),
        service("mobile", {
          autostart: false,
          actions: [
            {
              key: "i",
              label: "iOS",
              global: true,
              run: () => {
                launches++;
              },
            },
          ],
        }),
      ],
    });
    try {
      for (const selection of ["escape", "1", "2", "1", "escape"]) {
        await dashboard.key(selection);
        const applies = selection !== "1";
        assert.equal(dashboard.snapshot().actions.filter((action) => action.key === "i").length, applies ? 1 : 0);
        const before = launches;
        await dashboard.key("i");
        assert.equal(launches, before + (applies ? 1 : 0));
      }
      assert.equal(launches, 3);
      assert.equal(dashboard.snapshot().services[0].status, "not started");
    } finally {
      await dashboard.shutdown();
    }
  });

  await test("invalid configuration rejects before startup", async () => {
    let started = false;
    const valid = service("a", {
      start: async () => {
        started = true;
      },
    });
    for (const [config, pattern] of [
      [null, /title/],
      [{ title: "empty", services: [] }, /at least one service/],
      [{ services: [valid] }, /title/],
      [{ title: "bad", services: [valid, valid] }, /Duplicate/],
      [{ title: "bad", services: [service("")] }, /empty service id/],
      [{ title: "bad", services: [{ id: "a", name: "a" }] }, /command or start/],
      [{ title: "bad", services: [service("a", { command: ["bad\0command"] })] }, /Invalid command/],
      [{ title: "bad", services: [service("a", { dependsOn: ["missing"] })] }, /Unknown service dependency/],
      [
        {
          title: "bad",
          services: [service("a", { dependsOn: ["b"] }), service("b", { dependsOn: ["a"] })],
        },
        /Circular/,
      ],
      ...["q", "c", "XX"].map((key) => [
        { title: "bad", services: [valid], actions: [{ key, label: "bad", run() {} }] },
        /action key/,
      ]),
      [
        {
          title: "bad",
          services: [service("a", { actions: [{ key: "x", label: "row", run() {} }] })],
          actions: [
            { key: "x", label: "header", run() {} },
            { key: "x", label: "duplicate", run() {} },
          ],
        },
        /duplicate action key/,
      ],
    ])
      assert.throws(() => createDashboard(config), pattern);
    assert.equal(started, false);
  });
  await test("CLI --check loads a plain TypeScript .mts config without starting services", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dev-pad-cli-"));
    const config = join(directory, "config.mts");
    const started = join(directory, "started");
    const secret = "DEVPAD_TEST_ONLY_SECRET_DO_NOT_EMIT";
    const dashboard = createDashboard({ title: "CLI", services: [service("idle")] });
    try {
      await writeFile(
        config,
        `
        import { writeFileSync } from "node:fs";
        const title: string = "TypeScript CLI";
        export default {
          title,
          services: [{ id: "checked", name: "Checked", env: { SECRET: "${secret}" }, start: async () => {
            writeFileSync(${JSON.stringify(started)}, "started");
            throw new Error("--check must not start services");
          } }],
        };
      `,
      );
      const output = await dashboard.ctx.run([
        ...runtime,
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "--config",
        config,
        "--check",
      ]);
      assert.equal(output, "TypeScript CLI: checked");
      await assert.rejects(access(started), { code: "ENOENT" });
      // Validation failures must not dump the config source or its environment values.
      await writeFile(config, `export default { title: "Invalid CLI", services: [], secret: "${secret}" };`);
      await assert.rejects(
        dashboard.ctx.run([
          ...runtime,
          fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
          "--config",
          config,
          "--check",
        ]),
        /exited with code 1/,
      );
      const diagnostics = dashboard
        .snapshot()
        .logs.map((log) => log.message)
        .join("\n");
      assert.match(diagnostics, /at least one service/);
      assert.equal(diagnostics.includes(secret), false, "CLI leaked a config secret");
      assert.equal(diagnostics.includes("export default"), false, "CLI dumped config source");
      await assert.rejects(access(started), { code: "ENOENT" });
    } finally {
      await dashboard.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  await test("missing executable can be retried and recovered", async () => {
    const dashboard = createDashboard({
      title: "retry",
      services: [
        {
          id: "retry",
          name: "retry",
          command: [`${self}.nonexistent-executable`],
        },
      ],
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(dashboard.ctx.start("retry"), /ENOENT|not found/i);
        assert.equal(dashboard.snapshot().services[0].status, "failed");
      }
      dashboard.ctx.service("retry").command = command("utility");
      await dashboard.ctx.start("retry");
      await waitFor(
        () => dashboard.snapshot().logs.some((log) => log.source === "retry" && log.message === "utility fragment"),
        "successful retry launches child",
      );
      await waitFor(() => dashboard.snapshot().services[0].status === "stopped", "retry child exits cleanly");
    } finally {
      await dashboard.shutdown();
    }
  });
}

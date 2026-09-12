import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDashboard, portListening } from "../dist/index.js";

const self = fileURLToPath(import.meta.url);
const runtime = [process.execPath, ...("Deno" in globalThis ? ["run", "-A"] : [])];
const command = (...args) => [...runtime, self, ...args];
// A shell parent avoids runtime-specific child cleanup when the parent exits.
const parentCommand = (record, mode) => [
  "/bin/sh",
  "-c",
  `
    record=$1
    mode=$2
    shift 2
    "$@" </dev/null >/dev/null 2>&1 &
    child=$!
    while [ ! -f "$record" ]; do
      kill -0 "$child" 2>/dev/null || exit 1
      sleep 0.02
    done
    cat "$record"
    printf '\\n'
    if [ "$mode" = live ]; then wait "$child"; fi
  `,
  "runui-parent",
  record,
  mode,
  ...command("descendant", record),
];
const waitFor = async (predicate, description) => {
  const deadline = Date.now() + 8000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(20);
  }
};
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
};
const close = (server) => (server.listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve());

if (process.argv[2] === "descendant") {
  process.on("SIGTERM", () => {});
  // Bound fixture lifetime even if the test runner is interrupted.
  setTimeout(() => process.exit(2), 20000);
  const server = createServer((_req, res) => res.end("alive"));
  const port = await listen(server);
  await writeFile(`${process.argv[3]}.tmp`, JSON.stringify({ pid: process.pid, port }));
  await rename(`${process.argv[3]}.tmp`, process.argv[3]);
} else if (process.argv[2] === "exit") {
  process.exitCode = Number(process.argv[3]);
} else {
  const test = async (name, run) => {
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`not ok - ${name}\n`, error);
    }
  };

  await test("stop during a pending start waits and cleans the resource exactly once", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const server = createServer();
    const events = [];
    let port;
    const dashboard = createDashboard({
      title: "start/stop race",
      services: [
        {
          id: "service",
          name: "service",
          start: async () => {
            await gate;
            port = await listen(server);
            events.push("started");
          },
          stop: async () => {
            events.push("stopped");
            await close(server);
          },
        },
      ],
    });
    const starting = dashboard.ctx.start("service");
    const stopping = dashboard.ctx.stop("service");
    try {
      release();
      await Promise.all([starting, stopping]);
      assert.deepEqual(events, ["started", "stopped"]);
      assert.equal(await portListening(port), false);
      assert.equal(dashboard.snapshot().services[0].status, "stopped");
      await dashboard.shutdown();
      assert.deepEqual(events, ["started", "stopped"]);
    } finally {
      release();
      await Promise.allSettled([starting, stopping]);
      await close(server);
      await dashboard.shutdown();
    }
  });

  await test("child exit preserves hook cleanup for restart and shutdown", async () => {
    for (const code of [0, 7]) {
      let server = createServer();
      let port;
      let stops = 0;
      const dashboard = createDashboard({
        title: "exit cleanup",
        services: [
          {
            id: "service",
            name: "service",
            command: command("exit", String(code)),
            start: async () => {
              server = createServer();
              port = await listen(server);
            },
            stop: async () => {
              stops++;
              await close(server);
            },
          },
        ],
      });
      try {
        await dashboard.ctx.start("service");
        const status = code === 0 ? "stopped" : "failed";
        await waitFor(() => dashboard.snapshot().services[0].status === status, "first child exit");
        assert.equal(await portListening(port), true);
        await dashboard.ctx.restart("service");
        assert.equal(stops, 1);
        await waitFor(() => dashboard.snapshot().services[0].status === status, "second child exit");
        assert.equal(await dashboard.shutdown(), code === 0 ? 0 : 1);
        assert.equal(stops, 2);
        assert.equal(await portListening(port), false);
        await dashboard.shutdown();
        assert.equal(stops, 2);
      } finally {
        await close(server);
        await dashboard.shutdown();
      }
    }
  });

  if (process.platform === "win32") {
    console.log("skip - POSIX process-group cleanup (Windows supports direct children only)");
  } else
    await test("restart and shutdown kill SIGTERM-resistant descendants after parent exit", async () => {
      const directory = await mkdtemp(join(tmpdir(), "runui-lifecycle-"));
      const records = [join(directory, "first.json"), join(directory, "second.json")];
      const dashboard = createDashboard({
        title: "process groups",
        services: [{ id: "service", name: "service", command: parentCommand(records[0], "live") }],
      });
      const ready = async (record) => {
        await waitFor(
          () => dashboard.snapshot().logs.some((log) => log.message.startsWith('{"pid":')),
          "parent reported descendant",
        );
        const info = JSON.parse(await readFile(record, "utf8"));
        assert.equal(await portListening(info.port), true);
        return info;
      };
      try {
        await dashboard.ctx.start("service");
        const first = await ready(records[0]);
        dashboard.ctx.service("service").command = parentCommand(records[1], "exit");
        await dashboard.key("c");
        await dashboard.ctx.restart("service");
        await waitFor(async () => !(await portListening(first.port)), "restart kills old descendant");
        const second = await ready(records[1]);
        await waitFor(() => dashboard.snapshot().services[0].status === "stopped", "parent exited naturally");
        assert.equal(await portListening(second.port), true);
        await dashboard.shutdown();
        await waitFor(async () => !(await portListening(second.port)), "shutdown kills orphan descendant");
      } finally {
        // Read fixture PIDs even if readiness assertions failed, then force cleanup.
        for (const record of records) {
          try {
            const { pid } = JSON.parse(await readFile(record, "utf8"));
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already gone or never started. */
          }
        }
        await dashboard.shutdown();
        await rm(directory, { recursive: true, force: true });
      }
    });
}

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expo, reverseAndroidPorts } from "../dist/expo.js";
import { createDashboard } from "../dist/index.js";

const self = fileURLToPath(import.meta.url);
const runtime = [process.execPath, ...("Deno" in globalThis ? ["run", "-A"] : [])];
const command = (...args) => [...runtime, self, ...args];

if (process.argv[2] === "metro") {
  console.log(`metro ${process.argv.slice(3).join(" ")}`.trim());
  setInterval(() => {}, 1000);
} else {
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + 8000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, `Timed out: ${description}`);
      await delay(20);
    }
  };
  const freePort = () =>
    new Promise((resolve) => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });

  test("reverses ports for each ready device, skipping existing mappings", async () => {
    const commands = [];
    const messages = [];
    await reverseAndroidPorts(
      async (args) => {
        commands.push(args);
        if (args[0] === "devices")
          return "List of devices attached\nemulator-5554 device\nphone device\nlocked unauthorized\noffline offline\n";
        if (args.at(-1) === "--list") return "device tcp:8081 tcp:8081\n";
        return "";
      },
      [8081, 5101, 5101],
      (message) => messages.push(message),
    );
    assert.deepEqual(
      commands.filter((args) => args.at(-1) !== "--list" && args[0] !== "devices"),
      [
        ["-s", "emulator-5554", "reverse", "tcp:5101", "tcp:5101"],
        ["-s", "phone", "reverse", "tcp:5101", "tcp:5101"],
      ],
    );
    assert.equal(messages.length, 2);
  });

  test("defaults and merges caller actions and status", () => {
    const service = expo({
      cwd: "packages/app",
      autostart: false,
      actions: [{ key: "x", label: "extra", run: () => {} }],
      status: () => [{ label: "Extra", value: "yes" }],
    });
    assert.equal(service.id, "mobile");
    assert.equal(service.name, "Expo");
    assert.deepEqual(service.command, ["bun", "run", "dev"]);
    assert.deepEqual(service.ports, [8081]);
    assert.equal(service.port, undefined);
    assert.equal(service.url, "http://localhost:8081");
    assert.equal(service.terminal, true);
    assert.equal(service.autostart, false);
    assert.deepEqual(
      service.actions.map((action) => [action.key, Boolean(action.global)]),
      [
        ["i", true],
        ["a", true],
        ["x", false],
      ],
    );
    assert.deepEqual(service.status(), [{ label: "Extra", value: "yes" }]);
  });

  test("Metro's port comes from port or the first of ports and is always declared", () => {
    assert.deepEqual(expo({ port: 7110, ports: [7111] }).ports, [7110, 7111]);
    const fromPorts = expo({ ports: [7110, 7111] });
    assert.deepEqual(fromPorts.ports, [7110, 7111]);
    assert.equal(fromPorts.url, "http://localhost:7110");
  });

  test("default launch builds each platform using the configured Metro port", async () => {
    for (const port of [8081, 7110]) {
      for (const platform of ["ios", "android"]) {
        const service = expo({ port });
        const restarted = [];
        await service.actions
          .find((action) => action.key === (platform === "ios" ? "i" : "a"))
          .run({
            write: () => false,
            service: () => service,
            restart: async (id) => restarted.push(id),
          });
        assert.deepEqual(service.command, ["bun", "run", "expo", `run:${platform}`, "--port", String(port)]);
        assert.deepEqual(restarted, ["mobile"]);
      }
    }
  });

  test("launching without Metro restarts with the platform command", async () => {
    const port = await freePort();
    const dashboard = createDashboard({
      title: "expo",
      services: [
        expo({
          command: command("metro"),
          launch: (platform) => command("metro", `run:${platform}`),
          port,
          autostart: false,
          adb: join(tmpdir(), "dev-pad-missing-adb"),
        }),
      ],
    });
    const logs = () => dashboard.snapshot().logs.map((log) => log.message);
    try {
      await dashboard.key("i");
      await waitFor(() => logs().includes("metro run:ios"), "iOS launch command");
      assert.equal(dashboard.snapshot().services[0].name, "Expo iOS");
      assert.deepEqual(dashboard.snapshot().services[0].items, []);
    } finally {
      await dashboard.shutdown();
    }
  });

  if (process.platform === "win32") {
    console.log("skip - Android forwarding uses a POSIX adb fixture");
  } else
    test("Android launch forwards Metro and extra ports on each tick", async () => {
      const directory = await mkdtemp(join(tmpdir(), "dev-pad-expo-"));
      const record = join(directory, "adb.log");
      const adb = join(directory, "adb");
      const port = await freePort();
      await writeFile(
        adb,
        [
          "#!/bin/sh",
          `echo "$*" >> "${record}"`,
          'case "$*" in',
          '  devices) printf "List of devices attached\\nemulator-5554 device\\n" ;;',
          `  *--list) echo "emulator-5554 tcp:${port} tcp:${port}" ;;`,
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(adb, 0o755);
      const service = expo({
        command: command("metro"),
        launch: (platform) => command("metro", `run:${platform}`),
        port,
        androidPorts: [5101],
        autostart: false,
        adb,
      });
      const dashboard = createDashboard({ title: "expo", services: [service] });
      const items = () => dashboard.snapshot().services[0].items;
      try {
        await dashboard.health();
        await assert.rejects(readFile(record, "utf8"), { code: "ENOENT" });
        await dashboard.key("a");
        await waitFor(() => dashboard.snapshot().logs.some((log) => log.message === "metro run:android"), "Android");
        assert.equal(dashboard.snapshot().services[0].name, "Expo Android");
        await dashboard.health();
        assert.deepEqual((await readFile(record, "utf8")).trim().split("\n"), [
          "devices",
          "-s emulator-5554 reverse --list",
          "-s emulator-5554 reverse tcp:5101 tcp:5101",
        ]);
        assert.deepEqual(items(), [{ label: "Android forwarding", value: `${port}, 5101`, tone: "success" }]);

        await rm(adb);
        await dashboard.health();
        await dashboard.health();
        assert.equal(items()[0].tone, "warning");
        assert.equal(
          dashboard.snapshot().logs.filter((log) => log.message.startsWith("Android port forwarding:")).length,
          1,
        );
      } finally {
        await dashboard.shutdown();
        await rm(directory, { recursive: true, force: true });
      }
    });
}

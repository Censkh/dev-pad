import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDashboard } from "../dist/index.js";

const self = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const runtime = [process.execPath, ...("Deno" in globalThis ? ["run", "-A"] : [])];
const command = (...args) => [...runtime, self, ...args];
const line = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[([^\]]+)\] (.*)$/;
const parse = async (path) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((text) => {
      const match = text.match(line);
      assert.ok(match, `Unexpected log line: ${text}`);
      return { source: match[1], message: match[2] };
    });
const waitFor = async (predicate, description) => {
  const deadline = Date.now() + 8000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(20);
  }
};
const withProject = async (run) => {
  const directory = await mkdtemp(join(tmpdir(), "dev-pad-logfiles-"));
  try {
    await run(directory, join(directory, ".dev-pad", "logs"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
const exitedWith = (dashboard, id) => () =>
  dashboard.snapshot().logs.some((log) => log.source === id && log.message.startsWith("Process exited with code"));

if (process.argv[2] === "print") {
  for (const message of process.argv.slice(3)) console.log(`\x1b[32m${message}\x1b[0m`);
} else {
  test("each source is mirrored to its own timestamped file and to all.log, without ANSI", async () => {
    await withProject(async (cwd, dir) => {
      const dashboard = createDashboard(
        {
          title: "Mirror",
          cwd,
          services: [
            {
              id: "web",
              name: "Web",
              ports: false,
              command: command("print", "first", "second"),
            },
          ],
        },
        { logFiles: true },
      );
      try {
        assert.equal(dashboard.logDir, dir);
        await dashboard.ctx.start("web");
        await waitFor(exitedWith(dashboard, "web"), "web to exit");
        dashboard.ctx.log("job/a b", "one\ntwo");
        await dashboard.shutdown();
        const web = await parse(join(dir, "web.log"));
        assert.deepEqual(
          web.filter((entry) => entry.source === "web").map((entry) => entry.message),
          ["──── Web starting ────", "first", "second", "Process exited with code 0"],
        );
        const utility = await parse(join(dir, "job_a_b.log"));
        assert.deepEqual(
          utility.map((entry) => [entry.source, entry.message]),
          [
            ["job/a b", "one"],
            ["job/a b", "two"],
          ],
        );
        const all = await parse(join(dir, "all.log"));
        for (const [source, message] of [
          ["web", "first"],
          ["supervisor", "Started Web"],
          ["job/a b", "two"],
        ])
          assert.ok(
            all.some((entry) => entry.source === source && entry.message === message),
            `all.log lacks ${source}: ${message}`,
          );
        assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "*\n");
      } finally {
        await dashboard.shutdown();
      }
    });
  });

  test("README.md lists each service's status, URL, ports and file, and says when dev-pad stopped", async () => {
    await withProject(async (cwd, dir) => {
      const dashboard = createDashboard(
        {
          title: "Index",
          cwd,
          services: [
            { id: "api", name: "API", ports: false, url: "http://localhost:6554/health", start: async () => {} },
            { id: "docs", name: "Docs", ports: [6555, 6556], autostart: false, start: async () => {} },
          ],
        },
        { logFiles: true },
      );
      try {
        const row = async (id) =>
          (await readFile(join(dir, "README.md"), "utf8"))
            .split("\n")
            .find((text) => text.includes(`\`${id}\``))
            ?.split("|")
            .slice(2, 6)
            .map((cell) => cell.trim());
        assert.deepEqual(await row("api"), ["not started", "http://localhost:6554/health", "–", "api.log"]);
        assert.equal(
          await readFile(join(dir, "docs.log"), "utf8"),
          "",
          "a service that has not logged has an empty file",
        );
        await dashboard.start();
        assert.deepEqual(await row("api"), ["ready", "http://localhost:6554/health", "–", "api.log"]);
        assert.deepEqual(await row("docs"), ["not started", "–", "6555, 6556", "docs.log"]);
        assert.match(await readFile(join(dir, "README.md"), "utf8"), new RegExp(`PID ${process.pid}\\b`));
        await dashboard.shutdown();
        assert.deepEqual(await row("api"), ["not running", "http://localhost:6554/health", "–", "api.log"]);
        assert.doesNotMatch(await readFile(join(dir, "README.md"), "utf8"), /PID/);
      } finally {
        await dashboard.shutdown();
      }
    });
  });

  test("a restart starts the service's file again and keeps the earlier run in .previous.log", async () => {
    await withProject(async (cwd, dir) => {
      let run = 0;
      const dashboard = createDashboard(
        {
          title: "Restart",
          cwd,
          services: [{ id: "svc", name: "Svc", ports: false, start: async (ctx) => ctx.log("svc", `run ${++run}`) }],
        },
        { logFiles: true },
      );
      try {
        await dashboard.ctx.start("svc");
        await dashboard.ctx.restart("svc");
        await dashboard.shutdown();
        const messages = async (name) => (await parse(join(dir, name))).map((entry) => entry.message);
        assert.deepEqual(await messages("svc.log"), ["──── Svc starting ────", "run 2"]);
        assert.deepEqual(await messages("svc.previous.log"), ["──── Svc starting ────", "run 1"]);
        const all = await messages("all.log");
        assert.ok(all.includes("run 1") && all.includes("run 2"), "all.log keeps both runs");
      } finally {
        await dashboard.shutdown();
      }
    });
  });

  test("files rotate once they reach maxBytes, keeping the newest lines", async () => {
    await withProject(async (cwd, dir) => {
      const dashboard = createDashboard(
        {
          title: "Cap",
          cwd,
          logFiles: { maxBytes: 2048 },
          services: [{ id: "svc", name: "Svc", ports: false, start: async () => {} }],
        },
        { logFiles: true },
      );
      try {
        for (let index = 0; index < 400; index++) {
          dashboard.ctx.log("svc", `line ${index}`);
          // Flushes happen in batches; give several of them a chance to run.
          if (index % 50 === 0) await delay(120);
        }
        await dashboard.shutdown();
        for (const name of ["svc.log", "svc.previous.log", "all.log", "all.previous.log"])
          assert.ok((await stat(join(dir, name))).size <= 2048 + 2048, `${name} exceeds the cap`);
        const current = await parse(join(dir, "svc.log"));
        assert.equal(current.at(-1).message, "line 399");
        const previous = await parse(join(dir, "svc.previous.log"));
        assert.ok(
          Number(previous.at(-1).message.split(" ")[1]) < Number(current[0].message.split(" ")[1]),
          "previous file holds the older lines",
        );
      } finally {
        await dashboard.shutdown();
      }
    });
  });

  test("a new session moves the last session's files to .previous.log", async () => {
    await withProject(async (cwd, dir) => {
      const config = {
        title: "Sessions",
        cwd,
        services: [{ id: "svc", name: "Svc", ports: false, start: async () => {} }],
      };
      const first = createDashboard(config, { logFiles: true });
      first.ctx.log("svc", "from the first session");
      await first.shutdown();
      const second = createDashboard(config, { logFiles: true });
      try {
        second.ctx.log("svc", "from the second session");
        await second.shutdown();
        assert.deepEqual(
          (await parse(join(dir, "svc.log"))).map((entry) => entry.message),
          ["from the second session"],
        );
        assert.deepEqual(
          (await parse(join(dir, "svc.previous.log"))).map((entry) => entry.message),
          ["from the first session"],
        );
      } finally {
        await second.shutdown();
      }
    });
  });

  test("logFiles: false, or a direct createDashboard call, writes no files; dir moves them", async () => {
    await withProject(async (cwd, dir) => {
      const services = [{ id: "svc", name: "Svc", ports: false, start: async () => {} }];
      for (const [config, options] of [
        [{ title: "Off", cwd, services, logFiles: false }, { logFiles: true }],
        [{ title: "Direct", cwd, services }, {}],
      ]) {
        const dashboard = createDashboard(config, options);
        assert.equal(dashboard.logDir, undefined);
        dashboard.ctx.log("svc", "kept in memory only");
        await dashboard.shutdown();
        await assert.rejects(access(dir), { code: "ENOENT" });
      }
      const moved = createDashboard(
        { title: "Moved", cwd, services, logFiles: { dir: "tmp/logs" } },
        { logFiles: true },
      );
      moved.ctx.log("svc", "moved");
      await moved.shutdown();
      assert.deepEqual(
        (await parse(join(cwd, "tmp", "logs", "svc.log"))).map((entry) => entry.message),
        ["moved"],
      );
    });
  });

  test("dev-pad logs prints the index and a source's last lines, and fails for an unknown source", async () => {
    await withProject(async (cwd) => {
      const config = join(cwd, "dev-pad.config.mjs");
      await writeFile(
        config,
        `export default { title: "CLI logs", services: [{ id: "svc", name: "Svc", ports: false, start: async () => {} }] };`,
      );
      const dashboard = createDashboard(
        { title: "CLI logs", cwd, services: [{ id: "svc", name: "Svc", ports: false, start: async () => {} }] },
        { logFiles: true },
      );
      for (const message of ["a", "b", "c"]) dashboard.ctx.log("svc", message);
      await dashboard.shutdown();
      const runner = createDashboard({
        title: "runner",
        services: [{ id: "x", name: "x", ports: false, start: async () => {} }],
      });
      try {
        const logs = (...args) =>
          runner.ctx.run([...runtime, cli, "logs", ...args, "--config", config], { quiet: true });
        const tail = (await logs("svc", "--lines", "2")).split("\n").map((text) => text.match(line)?.[2]);
        assert.deepEqual(tail, ["b", "c"]);
        assert.match(await logs(), /\| svc\.log \|/);
        await assert.rejects(logs("missing"), /exited with code 1/);
      } finally {
        await runner.shutdown();
      }
    });
  });
}

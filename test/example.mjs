import assert from "node:assert/strict";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createDashboard, portListening } from "../dist/index.js";

// Reserve both example ports before releasing them to the real services.
const reserved = [];
let port;
for (let attempt = 0; attempt < 20; attempt++) {
  port = 20000 + Math.floor(Math.random() * 30000);
  try {
    for (const number of [port, port + 1]) {
      const server = createServer();
      reserved.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(number, "127.0.0.1", resolve);
      });
    }
    break;
  } catch (error) {
    await Promise.all(reserved.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    if (attempt === 19) throw error;
  }
}
await Promise.all(reserved.map((server) => new Promise((resolve) => server.close(resolve))));
process.env.DEVPAD_EXAMPLE_PORT = String(port);
const configURL = new URL("../example/dev-pad.config.ts", import.meta.url).href;
const { default: config } =
  "Bun" in globalThis || "Deno" in globalThis
    ? await import(configURL)
    : await (await import("tsx/esm/api")).tsImport(configURL, import.meta.url);
const dashboard = createDashboard(config);
const website = `http://127.0.0.1:${port}`;
const waitFor = async (predicate) => {
  const deadline = Date.now() + 8000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "Example did not become ready");
    await delay(50);
  }
};
try {
  await dashboard.start();
  await waitFor(async () => {
    await dashboard.health();
    return dashboard
      .snapshot()
      .services.slice(0, 2)
      .every((service) => service.status === "ready");
  });
  assert.match(await (await fetch(website)).text(), /Ocean site/);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port + 1}/health`)).json(), {
    ok: true,
    service: "example-api",
  });
  assert.equal(dashboard.snapshot().services[2].status, "not started");
  await dashboard.key("1");
  await dashboard.key("s");
  await waitFor(async () => {
    try {
      return (await (await fetch(website)).text()).includes("City site");
    } catch {
      return false;
    }
  });
  await dashboard.health();
  assert.equal(dashboard.snapshot().items[0].value, "City");
  await dashboard.key("2");
  assert.equal(
    dashboard.snapshot().actions.some((action) => action.key === "s"),
    false,
  );
  await dashboard.key("3");
  await dashboard.key("r");
  await waitFor(() =>
    dashboard.snapshot().logs.some((log) => log.source === "worker" && log.message === "Worker started"),
  );
  await dashboard.key("q");
  assert.equal(dashboard.snapshot().services[2].status, "stopped");
  assert.equal(dashboard.snapshot().services[0].status, "ready");
} finally {
  assert.equal(await dashboard.shutdown(), 0);
}
assert.equal(await portListening(port), false);
assert.equal(await portListening(port + 1), false);
console.log("ok - example website, API, site switching, worker and shutdown");

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPortFree, PortReservations } from "../ports";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});
// A port something listens on, as another run's server would.
const occupied = async () => {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  return (server.address() as { port: number }).port;
};

test("skips ports something listens on", async () => {
  const port = await occupied();
  expect(await isPortFree(port)).toBe(false);
  const [found] = await new PortReservations().open("job-1", 1, port);
  expect(found).toBeGreaterThan(port);
  expect(await isPortFree(found!)).toBe(true);
});

test("never gives the same port to two combinations asking at once", async () => {
  const from = (await occupied()) + 1;
  const reservations = new PortReservations();
  const [first, second] = await Promise.all([reservations.open("job-1", 3, from), reservations.open("job-2", 3, from)]);
  expect(first).toHaveLength(3);
  expect(second).toHaveLength(3);
  expect(first!.filter((port) => second!.includes(port))).toEqual([]);
  expect(Math.min(...first!, ...second!)).toBeGreaterThanOrEqual(from);
});

test("a combination's ports are offered again once it releases them", async () => {
  const from = (await occupied()) + 1;
  const reservations = new PortReservations();
  const held = await reservations.open("job-1", 2, from);
  const meanwhile = await reservations.open("job-2", 2, from);
  expect(meanwhile.filter((port) => held.includes(port))).toEqual([]);
  reservations.release("job-1");
  expect(await reservations.open("job-3", 2, from)).toEqual(held);
});

test("rejects a count or starting port out of range", async () => {
  const reservations = new PortReservations();
  await expect(reservations.open("job-1", 0, 5000)).rejects.toThrow("isn't a positive integer");
  await expect(reservations.open("job-1", 1, 70_000)).rejects.toThrow("out of range");
});

test("never gives another runner's reserved ports to a combination", async () => {
  const from = (await occupied()) + 1;
  const directory = mkdtempSync(join(tmpdir(), "dev-pad-ports-"));
  const module = resolve(import.meta.dir, "../ports.ts");
  const other = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { PortReservations } = await import(${JSON.stringify(module)});
       const ports = await new PortReservations(${JSON.stringify(directory)}).open("job-1", 2, ${from});
       console.log(JSON.stringify(ports));
       await Bun.sleep(60_000);`,
    ],
    { stdout: "pipe" },
  );
  try {
    const reader = other.stdout.getReader();
    const theirs = JSON.parse(new TextDecoder().decode((await reader.read()).value)) as number[];
    const reservations = new PortReservations(directory);
    const ours = await reservations.open("job-1", 2, from);
    expect(theirs).toHaveLength(2);
    expect(ours.filter((port) => theirs.includes(port))).toEqual([]);
    reservations.release("job-1");
  } finally {
    other.kill("SIGKILL");
    await other.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

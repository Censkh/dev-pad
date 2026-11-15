// Free ports for steps that start servers, such as a test suite's app and backend: found from a
// starting port upwards and reserved for the job combination that asked until it ends, so
// combinations running side by side never get the same ports. A port is free when nothing listens
// on it on the loopback or wildcard address, IPv4 or IPv6; something outside the run can still take
// it before the step's server binds it.
import { createServer } from "node:net";

const HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"];

const listenable = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) =>
      // An address family this machine lacks can't be in use.
      resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"),
    );
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });

export async function isPortFree(port: number) {
  for (const host of HOSTS) if (!(await listenable(port, host))) return false;
  return true;
}

export class PortReservations {
  private readonly owners = new Map<number, string>();

  /** `count` free ports at or above `from`, in order, reserved for `owner` until release(owner). */
  async open(owner: string, count: number, from: number): Promise<number[]> {
    if (!Number.isInteger(count) || count < 1) throw new Error(`Port count ${count} isn't a positive integer`);
    if (!Number.isInteger(from) || from < 1 || from > 65_535) throw new Error(`Port ${from} is out of range`);
    const ports: number[] = [];
    for (let port = from; port <= 65_535 && ports.length < count; port++) {
      if (this.owners.has(port)) continue;
      // Held while it's checked, so a concurrent request skips it.
      this.owners.set(port, owner);
      if (await isPortFree(port)) ports.push(port);
      else this.owners.delete(port);
    }
    if (ports.length < count) {
      for (const port of ports) this.owners.delete(port);
      throw new Error(`Only ${ports.length} of ${count} free ports at or above ${from}`);
    }
    return ports;
  }

  release(owner: string) {
    for (const [port, holder] of this.owners) if (holder === owner) this.owners.delete(port);
  }
}

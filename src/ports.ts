import { execFile } from "node:child_process";

/** Runs a utility and resolves its stdout, or an empty string if it fails or is missing. */
export type CommandRunner = (command: string, args: string[]) => Promise<string>;

export type PortProcess = { pid: number; ppid: number; command: string };
export type KilledProcess = PortProcess & { port: number; reason: "listener" | "parent" };
export type SkippedProcess = PortProcess & { port: number; reason: string };
export type KillPortsResult = {
  killed: KilledProcess[];
  skipped: SkippedProcess[];
  /** Ports that had no listener when the command ran. */
  idle: number[];
  /** Ports still listening after SIGKILL, e.g. held by a skipped or protected process. */
  stillListening: number[];
};
export type KillPortsOptions = {
  run?: CommandRunner;
  platform?: NodeJS.Platform;
  /** Defaults to `process.pid`; this process and its ancestors are never signalled. */
  self?: number;
  signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  alive?: (pid: number) => boolean;
  /** Time to wait after SIGTERM before sending SIGKILL. */
  graceMs?: number;
};

/** Ports explicitly declared by a service, or an empty list for `ports: false`. Throws if missing or invalid. */
export function servicePorts(service: { id: string; name?: string; ports?: unknown; port?: unknown }): number[] {
  const label = service.name && service.name !== service.id ? `${service.name} (${service.id})` : service.id;
  const { ports, port } = service;
  if (ports === false) {
    if (port !== undefined) throw new Error(`${label}: \`port\` is set but \`ports\` is false`);
    return [];
  }
  if (ports === undefined)
    throw new Error(
      `${label} must declare the ports it listens on with \`ports: [...]\`, or \`ports: false\` if it listens on none`,
    );
  if (!Array.isArray(ports) || !ports.length)
    throw new Error(`${label}: \`ports\` must be a non-empty array of port numbers, or false`);
  for (const value of ports)
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label}: invalid port ${value}`);
  if (port !== undefined && !ports.includes(port))
    throw new Error(`${label}: deprecated \`port\` ${port} is not listed in \`ports\``);
  return [...new Set(ports as number[])];
}

const execOutput: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 3000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) =>
      resolve(error && !stdout ? "" : String(stdout)),
    );
  });

const defaultAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export type PortListener = { pid: number; command: string };

/**
 * Processes with a TCP socket in the LISTEN state on each of `ports`, from a single lsof (or netstat) call.
 * Connected clients are ignored. `command` is the short process name where the platform reports one.
 */
export async function portListeners(
  ports: readonly number[],
  options: Pick<KillPortsOptions, "run" | "platform"> = {},
): Promise<Map<number, PortListener[]>> {
  const run = options.run ?? execOutput;
  const wanted = new Set(ports);
  const result = new Map<number, PortListener[]>([...wanted].map((port) => [port, []]));
  if (!wanted.size) return result;
  const add = (port: number, pid: number, command: string) => {
    const list = result.get(port);
    if (list && Number.isInteger(pid) && pid > 0 && !list.some((item) => item.pid === pid)) list.push({ pid, command });
  };
  if ((options.platform ?? process.platform) === "win32") {
    for (const line of (await run("netstat", ["-ano"])).split(/\r?\n/)) {
      const [protocol, local, , state, pid] = line.trim().split(/\s+/);
      if (protocol === "TCP" && state === "LISTENING")
        add(Number(local?.slice(local.lastIndexOf(":") + 1)), Number(pid), "");
    }
    return result;
  }
  // -F emits one field per line: p<pid>, c<command>, then n<address> for each listening socket.
  let pid = 0;
  let command = "";
  for (const line of (await run("lsof", ["-nP", `-iTCP:${[...wanted].join(",")}`, "-sTCP:LISTEN", "-Fpcn"])).split(
    "\n",
  )) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      command = "";
    } else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n")) add(Number(line.slice(line.lastIndexOf(":") + 1)), pid, command);
  }
  return result;
}

/** PIDs with a TCP socket in the LISTEN state on `port`. Connected clients are ignored. */
export async function listeningPids(port: number, options: Pick<KillPortsOptions, "run" | "platform"> = {}) {
  return ((await portListeners([port], options)).get(port) ?? []).map((listener) => listener.pid);
}

/** Every process's PID, parent PID and command line. */
export async function processTable(options: Pick<KillPortsOptions, "run" | "platform"> = {}) {
  const run = options.run ?? execOutput;
  const table = new Map<number, PortProcess>();
  if ((options.platform ?? process.platform) === "win32") {
    const csv = await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,Name | ConvertTo-Csv -NoTypeInformation",
    ]);
    for (const line of csv.split(/\r?\n/).slice(1)) {
      const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replaceAll('""', '"'));
      const [pid, ppid, commandLine, name] = fields;
      if (pid) table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), command: commandLine || name || "" });
    }
    return table;
  }
  for (const line of (await run("ps", ["-A", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "command="])).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return table;
}

// Container runtimes and tunnels forward ports for other things; killing them takes down far more than a dev server.
const sharedListener =
  /com\.docker|docker-proxy|vpnkit|\bdockerd?\b|OrbStack|\borbstack\b|limactl|colima|podman|gvproxy|qemu-system|\bsshd?\b/i;
// Dev servers that respawn or keep a worker holding the port, so their direct parent is stopped too.
const devParent = /\b(wrangler|vite|workerd|miniflare)\b/i;
const runtimeParent = /\b(bun|bunx|node|deno|npx|tsx)\b/i;

/** Whether `parent` is a dev process that owns the listener on `port` rather than an unrelated supervisor. */
export function isDevParent(parent: Pick<PortProcess, "command">, port: number) {
  if (sharedListener.test(parent.command)) return false;
  if (devParent.test(parent.command)) return true;
  return runtimeParent.test(parent.command) && new RegExp(`(^|[^\\d])${port}([^\\d]|$)`).test(parent.command);
}

/**
 * Terminates whatever listens on `ports`, even when dev-pad did not start it: SIGTERM, then SIGKILL after a grace
 * period. A listener's direct parent is also stopped when it is a wrangler/vite dev process (or a runtime started for
 * that port), so an orphaned `wrangler dev` cannot respawn its workerd. This process, its ancestors, container
 * runtimes and SSH tunnels are never signalled.
 */
export async function killPortListeners(ports: number[], options: KillPortsOptions = {}): Promise<KillPortsResult> {
  const self = options.self ?? process.pid;
  const signal = options.signal ?? ((pid, value) => process.kill(pid, value));
  const alive = options.alive ?? defaultAlive;
  const result: KillPortsResult = { killed: [], skipped: [], idle: [], stillListening: [] };
  const listeners = await portListeners(ports, options);
  const found = [...listeners].map(([port, list]) => [port, list.map((listener) => listener.pid)] as const);
  if (found.every(([, pids]) => !pids.length)) {
    result.idle = found.map(([port]) => port);
    return result;
  }
  const table = await processTable(options);
  const info = (pid: number): PortProcess => table.get(pid) ?? { pid, ppid: 0, command: "" };
  const protectedPids = new Set<number>([0, 1]);
  for (let pid = self; pid > 1 && !protectedPids.has(pid); pid = info(pid).ppid) protectedPids.add(pid);
  if (self === process.pid) protectedPids.add(process.ppid);
  const targets = new Map<number, KilledProcess>();
  const skip = (process: PortProcess, port: number, reason: string) => {
    if (!result.skipped.some((item) => item.pid === process.pid)) result.skipped.push({ ...process, port, reason });
  };
  for (const [port, pids] of found) {
    if (!pids.length) result.idle.push(port);
    for (const pid of pids) {
      const listener = info(pid);
      if (protectedPids.has(pid)) skip(listener, port, "dev-pad itself");
      else if (sharedListener.test(listener.command)) skip(listener, port, "container runtime or tunnel");
      else {
        if (!targets.has(pid)) targets.set(pid, { ...listener, port, reason: "listener" });
        const parent = table.get(listener.ppid);
        if (parent && !protectedPids.has(parent.pid) && !targets.has(parent.pid) && isDevParent(parent, port))
          targets.set(parent.pid, { ...parent, port, reason: "parent" });
      }
    }
  }
  // Parents first, so a supervisor cannot respawn a listener after it exits.
  const ordered = [...targets.values()].sort((a, b) => (a.reason === b.reason ? 0 : a.reason === "parent" ? -1 : 1));
  for (const target of ordered) {
    try {
      signal(target.pid, "SIGTERM");
      result.killed.push(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") skip(target, target.port, String(error));
    }
  }
  const deadline = Date.now() + (options.graceMs ?? 2000);
  while (Date.now() < deadline && result.killed.some((target) => alive(target.pid)))
    await new Promise((resolve) => setTimeout(resolve, 50));
  for (const target of result.killed)
    if (alive(target.pid))
      try {
        signal(target.pid, "SIGKILL");
      } catch {
        /* Exited in between. */
      }
  if (result.killed.length) await new Promise((resolve) => setTimeout(resolve, 100));
  const after = await portListeners(
    found.filter(([, pids]) => pids.length).map(([port]) => port),
    options,
  );
  for (const [port, list] of after) if (list.length) result.stillListening.push(port);
  return result;
}

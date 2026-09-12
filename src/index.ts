import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { resolve, sep } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import type { LogEntry } from "./logs.js";
import { launch, type RunningProcess, terminate } from "./process.js";

export type StatusItem = {
  label: string;
  value: string;
  tone?: "muted" | "info" | "success" | "warning" | "danger";
};
export type Action = {
  global?: boolean;
  key: string;
  label: string;
  run: (ctx: ServiceContext) => unknown | Promise<unknown>;
};
export type Service = {
  id: string;
  name: string;
  command?: string[];
  cwd?: string;
  port?: number;
  url?: string | (() => string);
  env?: Record<string, string> | (() => Record<string, string>);
  autostart?: boolean;
  terminal?: boolean;
  allowOccupiedPort?: boolean;
  dependsOn?: string[];
  probe?: "http" | (() => Promise<boolean>);
  actions?: Action[];
  start?: (ctx: ServiceContext) => Promise<void>;
  stop?: (ctx: ServiceContext) => Promise<void>;
  status?: () => StatusItem[];
};
export type Config = {
  title: string;
  cwd?: string;
  services: Service[];
  actions?: Action[];
  status?: () => StatusItem[];
  theme?: Record<string, string>;
  tick?: (ctx: ServiceContext) => Promise<void>;
};
export type ServiceContext = {
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  restartAll(): Promise<void>;
  open(url: string): Promise<void>;
  run(
    command: string[],
    options?: { source?: string; env?: Record<string, string>; cwd?: string; quiet?: boolean },
  ): Promise<string>;
  log(source: string, message: string): void;
  write(id: string, input: string): boolean;
  service(id: string): Service;
};
export function defineConfig(config: Config): Config {
  return config;
}

export function validateConfig(config: Config) {
  if (!config || typeof config.title !== "string" || !Array.isArray(config.services) || !config.services.length)
    throw new Error("dev-pad config needs a title and at least one service");
  const ids = new Set<string>();
  for (const service of config.services) {
    if (!service.id || ids.has(service.id)) throw new Error(`Duplicate or empty service id: ${service.id}`);
    ids.add(service.id);
    if (!service.command?.length && !service.start) throw new Error(`${service.id} needs a command or start hook`);
    if (service.command?.some((arg) => typeof arg !== "string" || arg.includes("\0")))
      throw new Error(`Invalid command for ${service.id}`);
  }
  const visited = new Set<string>();
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id)) throw new Error(`Circular service dependency: ${id}`);
    if (visited.has(id)) return;
    const service = config.services.find((service) => service.id === id);
    if (!service) throw new Error(`Unknown service dependency: ${id}`);
    for (const dep of service.dependsOn ?? []) visit(dep, new Set([...path, id]));
    visited.add(id);
  };
  for (const id of ids) visit(id, new Set());
  for (const actions of [
    [
      ...(config.actions ?? []),
      ...config.services.flatMap((service) => (service.actions ?? []).filter((action) => action.global)),
    ],
    ...config.services.map((service) => service.actions ?? []),
  ]) {
    const keys = new Set<string>();
    for (const action of actions) {
      if (!/^[a-z]$/.test(action.key) || ["q", "c"].includes(action.key) || keys.has(action.key))
        throw new Error(`Invalid, reserved or duplicate action key: ${action.key}`);
      keys.add(action.key);
    }
  }
}

export const portListening = (port: number, host = "127.0.0.1") =>
  new Promise<boolean>((done) => {
    const socket = createConnection({ host, port });
    const finish = (value: boolean) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(350, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

const execOutput = promisify(execFile);
async function reclaimPort(port: number, cwd: string, log: (message: string) => void) {
  if (process.platform === "win32") return false;
  const output = async (cmd: string, args: string[]) => {
    try {
      return (await execOutput(cmd, args, { timeout: 1500 })).stdout.trim();
    } catch {
      return "";
    }
  };
  const pids = (await output("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]))
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  let reclaimed = false;
  for (const pid of new Set(pids)) {
    const processCwd = (await output("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]))
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    // Only reclaim listeners whose actual working directory belongs to this project.
    if (!processCwd || !(processCwd === cwd || processCwd.startsWith(cwd + sep))) continue;
    try {
      process.kill(pid, "SIGTERM");
      reclaimed = true;
      log(`Stopping stale listener on :${port} (PID ${pid})`);
    } catch {}
  }
  if (!reclaimed) return false;
  const deadline = Date.now() + 3000;
  do {
    if (!(await Promise.all([portListening(port), portListening(port, "::1")])).some(Boolean)) return true;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  return false;
}

export function createDashboard(config: Config, options: { plain?: boolean } = {}) {
  validateConfig(config);
  const cwd = resolve(config.cwd ?? process.cwd());
  const services = config.services.map((service) => ({ ...service }));
  type State = {
    status: string;
    child?: RunningProcess;
    active: boolean;
    hasStarted?: boolean;
    cleanupNeeded?: boolean;
    starting?: Promise<void>;
    stopping?: Promise<void>;
    generation: number;
  };
  const states = new Map(
    services.map((service) => [service.id, { status: "stopped", active: false, generation: 0 } as State]),
  );
  const logs: LogEntry[] = [];
  const utilities = new Set<RunningProcess>();
  let logId = 0;
  let closing = false;
  let actionLabel = "";
  let actionTask: Promise<void> | undefined;
  let healthTask: Promise<void> | undefined;
  let shutdownTask: Promise<number> | undefined;
  let exitCode = 0;
  let runningStopHook = false;
  const serviceById = (id: string) => {
    const service = services.find((service) => service.id === id);
    if (!service) throw new Error(`Unknown service: ${id}`);
    return service;
  };
  const state = (id: string) => {
    serviceById(id);
    return states.get(id) as State;
  };
  const url = (service: Service) => (typeof service.url === "function" ? service.url() : (service.url ?? ""));
  const log = (source: string, message: string) => {
    const clean = stripVTControlCharacters(message);
    logs.push({ id: ++logId, source, message: clean });
    if (logs.length > 500) logs.shift();
    if (options.plain) process.stdout.write(`[${source}] ${clean}\n`);
  };
  const ctx: ServiceContext = {
    service: serviceById,
    log,
    async run(command, opts = {}) {
      if (closing && !runningStopHook) throw new Error("Dashboard is stopping");
      const output: string[] = [];
      const child = await launch(command, {
        cwd: resolve(cwd, opts.cwd ?? "."),
        env: opts.env,
        log: (message) => {
          output.push(message);
          if (!opts.quiet) log(opts.source ?? "supervisor", message);
        },
      });
      utilities.add(child);
      if (closing && !runningStopHook) await terminate(child);
      try {
        const code = await child.exited;
        if (code !== 0) throw new Error(`${command.join(" ")} exited with code ${code}`);
        return output.join("\n");
      } finally {
        utilities.delete(child);
        child.close();
      }
    },
    async open(value) {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP(S) URLs can be opened");
      await ctx.run(
        process.platform === "darwin"
          ? ["open", value]
          : process.platform === "win32"
            ? ["rundll32", "url.dll,FileProtocolHandler", value]
            : ["xdg-open", value],
      );
    },
    write(id, input) {
      const child = state(id).child;
      if (!child || !state(id).active) return false;
      child.write(input);
      return true;
    },
    async start(id) {
      if (closing) return;
      const service = serviceById(id);
      const s = state(id);
      if (s.stopping) await s.stopping;
      if (closing) return;
      if (s.starting) return s.starting;
      if (s.active && s.status !== "failed") return;
      if (s.active || s.child || s.cleanupNeeded) await ctx.stop(id);
      s.starting = (async () => {
        try {
          for (const dep of service.dependsOn ?? []) await ctx.start(dep);
          if (closing) return;
          if (
            service.port &&
            !service.allowOccupiedPort &&
            (await Promise.all([portListening(service.port), portListening(service.port, "::1")])).some(Boolean) &&
            !(await reclaimPort(service.port, cwd, (message) => log("supervisor", message)))
          )
            throw new Error(`${service.name}: port ${service.port} is already in use`);
          s.status = "starting";
          s.active = true;
          s.cleanupNeeded = Boolean(service.stop);
          if (service.start) s.hasStarted = true;
          await service.start?.(ctx);
          if (closing) return;
          if (service.command) {
            const generation = ++s.generation;
            const child = await launch(service.command, {
              cwd: resolve(cwd, service.cwd ?? "."),
              env: typeof service.env === "function" ? service.env() : service.env,
              terminal: service.terminal && Boolean(process.stdin.isTTY),
              log: (message) => log(id, message),
            });
            s.child = child;
            s.hasStarted = true;
            if (closing) return;
            void child.exited.then((code) => {
              child.close();
              if (generation !== s.generation) return;
              // Retain the process group until stop, even if its leader exited.
              s.active = false;
              s.status = code === 0 ? "stopped" : "failed";
              if (code !== 0) exitCode = 1;
              log(id, `Process exited with code ${code}`);
            });
          }
          s.status = service.port || service.probe ? "starting" : "ready";
          log("supervisor", `Started ${service.name}`);
        } catch (error) {
          s.status = "failed";
          exitCode = 1;
          throw error;
        }
      })();
      try {
        await s.starting;
      } finally {
        s.starting = undefined;
      }
    },
    async stop(id) {
      const service = serviceById(id);
      const s = state(id);
      if (s.stopping) return s.stopping;
      s.stopping = (async () => {
        try {
          await s.starting;
        } catch {
          /* Failed starts still need cleanup. */
        }
        if (!s.active && !s.child && !s.cleanupNeeded) {
          s.status = "stopped";
          return;
        }
        s.status = "stopping";
        ++s.generation;
        if (s.child) {
          await terminate(s.child);
          s.child = undefined;
        }
        try {
          runningStopHook = true;
          await service.stop?.(ctx);
        } finally {
          runningStopHook = false;
          s.cleanupNeeded = false;
          s.active = false;
          s.status = "stopped";
        }
      })();
      try {
        await s.stopping;
      } finally {
        s.stopping = undefined;
      }
    },
    async restart(id) {
      await ctx.stop(id);
      await ctx.start(id);
    },
    async restartAll() {
      const active = services.filter((service) => state(service.id).active).map((service) => service.id);
      for (const id of stopOrder().filter((id) => active.includes(id))) await ctx.stop(id);
      for (const id of active) await ctx.start(id);
    },
  };
  let selectedId: string | undefined;
  const globalActions = services.flatMap((service) => (service.actions ?? []).filter((action) => action.global));
  const actions: Action[] = [...(config.actions ?? []), ...globalActions];
  if (!actions.some((action) => action.key === "r"))
    actions.push({ key: "r", label: "restart active", run: (ctx) => ctx.restartAll() });
  const availableActions = (): Action[] => {
    if (!selectedId) return actions;
    const service = serviceById(selectedId);
    const custom = service.actions ?? [];
    const defaults: Action[] = [
      {
        key: "r",
        label: state(service.id).active ? "restart" : "start",
        run: () => ctx.restart(service.id),
      },
      { key: "q", label: "stop", run: () => ctx.stop(service.id) },
      ...(url(service) ? [{ key: "o", label: "open", run: () => ctx.open(url(service)) }] : []),
    ];
    return [...defaults.filter((action) => !custom.some((item) => item.key === action.key)), ...custom];
  };
  const perform = (label: string, run: () => Promise<unknown> | unknown) => {
    if (closing || actionTask) return actionTask ?? Promise.resolve();
    actionLabel = label;
    actionTask = (async () => {
      try {
        await run();
      } catch (error) {
        exitCode = 1;
        log("supervisor", String(error));
      }
    })().finally(() => {
      actionTask = undefined;
      actionLabel = "";
    });
    return actionTask;
  };
  const stopOrder = () => {
    const ordered: string[] = [];
    const visit = (service: Service) => {
      if (ordered.includes(service.id)) return;
      for (const dep of service.dependsOn ?? []) visit(serviceById(dep));
      ordered.push(service.id);
    };
    for (const service of services) visit(service);
    return ordered.reverse();
  };
  return {
    ctx,
    snapshot: () => ({
      title: config.title,
      selectedId,
      services: services.map((service) => ({
        id: service.id,
        name: service.name,
        status:
          state(service.id).status === "stopped" && !state(service.id).hasStarted
            ? "not started"
            : state(service.id).status,
        url: url(service),
        items: service.status?.() ?? [],
      })),
      logs: [...logs],
      items: config.status?.() ?? [],
      actions: availableActions().map(({ key, label }) => ({ key, label })),
      actionLabel,
    }),
    start: () =>
      perform("Starting services", async () => {
        const results = await Promise.allSettled(
          services.filter((service) => service.autostart !== false).map((service) => ctx.start(service.id)),
        );
        for (const result of results) if (result.status === "rejected") log("supervisor", String(result.reason));
      }),
    async key(key: string) {
      if (key === "c") {
        logs.length = 0;
        return;
      }
      if (key === "escape") {
        selectedId = undefined;
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const service = services[Number(key) - 1];
        if (service) selectedId = service.id;
        return;
      }
      const action = availableActions().find((action) => action.key === key);
      if (action) await perform(action.label, () => action.run(ctx));
    },
    health() {
      if (closing || actionTask || healthTask) return healthTask ?? Promise.resolve();
      healthTask = (async () => {
        await config.tick?.(ctx);
        await Promise.all(
          services.map(async (service) => {
            const s = state(service.id);
            if (!s.active || s.stopping) return;
            const generation = s.generation;
            let healthy = true;
            try {
              if (typeof service.probe === "function") healthy = await service.probe();
              else if (service.probe === "http") {
                const response = await fetch(url(service), { signal: AbortSignal.timeout(900) });
                healthy = response.status < 500;
                await response.body?.cancel();
              } else if (service.port)
                healthy = (await Promise.all([portListening(service.port), portListening(service.port, "::1")])).some(
                  Boolean,
                );
            } catch {
              healthy = false;
            }
            if (!closing && !s.stopping && s.active && generation === s.generation)
              s.status = healthy ? "ready" : s.status === "starting" ? "starting" : "failed";
          }),
        );
      })()
        .catch((error) => log("supervisor", String(error)))
        .finally(() => {
          healthTask = undefined;
        });
      return healthTask;
    },
    shutdown() {
      if (shutdownTask) return shutdownTask;
      closing = true;
      shutdownTask = (async () => {
        await Promise.all([...utilities].map(terminate));
        await actionTask;
        await healthTask;
        await Promise.allSettled([...states.values()].flatMap((s) => (s.starting ? [s.starting] : [])));
        for (const id of stopOrder()) {
          try {
            await ctx.stop(id);
          } catch (error) {
            exitCode = 1;
            log("supervisor", String(error));
          }
        }
        return exitCode;
      })();
      return shutdownTask;
    },
  };
}

export async function runDashboard(config: Config, options: { plain?: boolean } = {}) {
  const interactive = !options.plain && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const dashboard = createDashboard(config, { plain: !interactive });
  let unmount: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    try {
      process.exitCode = await dashboard.shutdown();
    } finally {
      unmount?.();
      resolveDone();
    }
  };
  const onSignal = () => {
    void shutdown();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  if (process.platform === "win32") process.on("SIGBREAK", onSignal);
  try {
    if (interactive) {
      const { mountUI } = await import("./ui.js");
      unmount = await mountUI(
        dashboard.snapshot,
        (key) => {
          if (key === "ctrl+c") void shutdown();
          else void dashboard.key(key);
        },
        config.theme,
      );
    }
    timer = setInterval(() => void dashboard.health(), 1500);
    await dashboard.start();
    if (
      !interactive &&
      dashboard.snapshot().services.every((service) => ["failed", "stopped", "not started"].includes(service.status))
    )
      await shutdown();
    await done;
  } finally {
    clearInterval(timer);
    await dashboard.shutdown();
    unmount?.();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (process.platform === "win32") process.off("SIGBREAK", onSignal);
  }
}

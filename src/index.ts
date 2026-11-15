import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { parseDocument } from "yaml";
import {
  type GitHubRun,
  type GitHubWorkflow,
  githubActions,
  githubError,
  githubJobDependencies,
  githubStatus,
} from "./github-actions.js";
import { createLogFiles, defaultLogDir, type LogFileOptions, type LogFiles } from "./logfiles.js";
import type { LogEntry } from "./logs.js";
import { type CommandRunner, killPortListeners, listeningPids, portListeners, servicePorts } from "./ports.js";
import { launch, type RunningProcess, terminate } from "./process.js";
import type { Snapshot, WorkflowJob } from "./ui.js";
import { localWorkflowRuns, localWorkflowRunsStamp, readWorkflowLog } from "./workflow-history.js";

export { defaultLogDir, type LogFileOptions, logFileName } from "./logfiles.js";
export {
  type CommandRunner,
  type KillPortsResult,
  killPortListeners,
  listeningPids,
  type PortListener,
  portListeners,
  servicePorts,
} from "./ports.js";

export type LaunchTarget = { service: string; id: string; label: string };
export type TargetStatus = { id: string; label: string; status: "starting" | "started" | "failed" | "cancelled" };

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
  /** Label for the primary process when launch targets are shown, e.g. Web or Metro. */
  processLabel?: string;
  cwd?: string;
  /**
   * Every TCP port the service listens on, including secondary servers it starts (e.g. a second Worker or an
   * inspector). The first is used for the default health check. Use `false` for a service that listens on nothing.
   */
  ports: readonly number[] | false;
  /** @deprecated Use `ports`. Accepted only when it is also listed in `ports`, for configs shared with dev-pad 0.4. */
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
  tick?: (ctx: ServiceContext) => Promise<void>;
};
export type LocalWorkflow = {
  id: string;
  /** GitHub workflow YAML, relative to the project directory. */
  file: string;
  /** Project-specific step handlers, relative to the project directory. */
  processors?: string;
  /** Run only these jobs and their dependencies. */
  jobs?: string[];
  /** Adds an explicit deploy action for the complete workflow. */
  deployment?: { keychainService?: string };
};

export const workflowRunner = fileURLToPath(new URL("../workflows/run.ts", import.meta.url));

export type Config = {
  title: string;
  cwd?: string;
  services: Service[];
  workflows?: LocalWorkflow[];
  /** Discover hosted Actions through gh. Set false to disable discovery. */
  githubActions?: boolean;
  actions?: Action[];
  status?: () => StatusItem[];
  theme?: Record<string, string>;
  tick?: (ctx: ServiceContext) => Promise<void>;
  /** Log lines kept for each source (service, supervisor or utility), so a noisy one never evicts another's history. */
  logLimit?: number;
  /**
   * Mirror every log source to a plain-text file under the project directory (`.dev-pad/logs` by default) while the
   * dashboard runs, so agents and other tools can read service output. Set `false` to turn this off.
   */
  logFiles?: false | LogFileOptions;
};
export type ServiceContext = {
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  restartAll(): Promise<void>;
  open(url: string): Promise<void>;
  run(
    command: string[],
    options?: {
      source?: string;
      env?: Record<string, string>;
      cwd?: string;
      quiet?: boolean;
      /** Track a finite build-and-launch command independently of the service process. */
      target?: LaunchTarget;
    },
  ): Promise<string>;
  log(source: string, message: string): void;
  write(id: string, input: string): boolean;
  service(id: string): Service;
};
export function defineConfig(config: Config): Config {
  return config;
}

type RunDetails = { state: string; jobs: WorkflowJob[]; stages: string[] };
type SavedWorkflow = Awaited<ReturnType<typeof localWorkflowRuns>>[number];
type WorkflowRun = { id: string; startedAt: number; status: string; label: string } & (
  | { source: "live" }
  | { source: "local"; saved: SavedWorkflow }
  | { source: "github"; remote: GitHubRun }
);

type DashboardService = Service & {
  workflow?: true;
  deployCommand?: string[];
  local?: LocalWorkflow;
  github?: GitHubWorkflow;
};

function dashboardServices(config: Config): DashboardService[] {
  return [
    ...config.services.map((service) => ({ ...service })),
    ...(config.workflows ?? []).map((workflow): DashboardService => {
      if (!workflow.file || workflow.file.startsWith("-")) throw new Error(`Invalid workflow path for ${workflow.id}`);
      const command = [
        "bun",
        workflowRunner,
        workflow.file,
        ...(workflow.processors === undefined ? [] : ["--processors", workflow.processors]),
      ];
      const keychain = workflow.deployment?.keychainService;
      return {
        id: workflow.id,
        name: basename(workflow.file),
        workflow: true,
        local: workflow,
        ports: false,
        autostart: false,
        command: [...command, "--stream", "--status-events", ...(workflow.jobs ?? []).flatMap((job) => ["--job", job])],
        deployCommand: workflow.deployment
          ? [...command, "--deploy", "--status-events", ...(keychain ? ["--keychain-service", keychain] : [])]
          : undefined,
      };
    }),
  ];
}

export function validateConfig(config: Config) {
  if (
    !config ||
    typeof config.title !== "string" ||
    !Array.isArray(config.services) ||
    (config.workflows !== undefined && !Array.isArray(config.workflows))
  )
    throw new Error("dev-pad config needs a title and a services array");
  const services = dashboardServices(config);
  if (!services.length && !config.githubActions)
    throw new Error("dev-pad config needs at least one service or workflow, or githubActions enabled");
  const ids = new Set<string>();
  for (const service of services) {
    if (!service.id || ids.has(service.id)) throw new Error(`Duplicate or empty service id: ${service.id}`);
    ids.add(service.id);
    if (!service.command?.length && !service.start) throw new Error(`${service.id} needs a command or start hook`);
    if (service.command?.some((arg) => typeof arg !== "string" || arg.includes("\0")))
      throw new Error(`Invalid command for ${service.id}`);
    servicePorts(service);
  }
  const visited = new Set<string>();
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id)) throw new Error(`Circular service dependency: ${id}`);
    if (visited.has(id)) return;
    const service = services.find((service) => service.id === id);
    if (!service) throw new Error(`Unknown service dependency: ${id}`);
    for (const dep of service.dependsOn ?? []) visit(dep, new Set([...path, id]));
    visited.add(id);
  };
  for (const id of ids) visit(id, new Set());
  for (const actions of [
    [
      ...(config.actions ?? []),
      ...services.flatMap((service) => (service.actions ?? []).filter((action) => action.global)),
    ],
    ...services.map((service) => service.actions ?? []),
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
  const pids = (await listeningPids(port)).filter((pid) => pid > 1 && pid !== process.pid);
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

const portInUse = async (port: number) =>
  (await Promise.all([portListening(port), portListening(port, "::1")])).some(Boolean);

/** A declared port held by a process dev-pad does not run for this service. */
type PortHolder = { port: number; pid?: number; command?: string };
const describeHolder = ({ port, pid, command }: PortHolder) =>
  `:${port} held by ${pid ? `PID ${pid}${command ? ` (${command})` : ""}` : "another process"}`;
class PortBusyError extends Error {
  constructor(
    readonly service: Service,
    readonly holder: PortHolder,
  ) {
    super(`${service.name}: ${describeHolder(holder)}; press k to free it`);
  }
}
/** How often stopped services' ports are checked for other listeners. */
const portPollInterval = 3000;

export type DashboardOptions = {
  plain?: boolean;
  /** Runs the read-only `lsof`/`netstat` lookups for busy ports. Defaults to spawning the real utility. */
  run?: CommandRunner;
  /** Write the config's log files. `runDashboard` and the CLI enable it; direct `createDashboard` calls default to off. */
  logFiles?: boolean;
};

export function createDashboard(config: Config, options: DashboardOptions = {}) {
  validateConfig(config);
  const cwd = resolve(config.cwd ?? process.cwd());
  const services = dashboardServices(config);
  for (const service of services) {
    if (!service.local) continue;
    try {
      const document = parseDocument(readFileSync(resolve(cwd, service.local.file), "utf8"));
      const name = document.get("name");
      if (!document.errors.length && typeof name === "string" && name.trim()) service.name = name;
    } catch {
      // Use the filename until the workflow is available. The runner reports read errors.
    }
  }
  type State = {
    status: string;
    targets: Map<string, TargetStatus>;
    child?: RunningProcess;
    active: boolean;
    hasStarted?: boolean;
    cleanupNeeded?: boolean;
    starting?: Promise<void>;
    stopping?: Promise<void>;
    generation: number;
    workflowRun?: RunDetails & { id?: string; startedAt?: string };
    localStartedAt?: string;
    localRunOrder?: number;
    localRuns?: SavedWorkflow[];
    /** The newest saved run directories when the runs were last read (localWorkflowRunsStamp). */
    localRunsStamp?: string;
    selectedRunId?: string;
    savedLogs?: { id: string; logs: LogEntry[] };
    githubRuns?: GitHubRun[];
    githubDetail?: { id: string; details: RunDetails };
    githubLogKey?: string;
    githubLogs?: LogEntry[];
    githubNotice?: string;
    githubRequest?: Promise<void>;
    /** Set while the service is not running and another process listens on one of its ports. */
    busy?: PortHolder;
    /** The last start was refused because a port was busy. */
    blockedStart?: boolean;
  };
  const states = new Map(
    services.map((service) => [
      service.id,
      { status: "stopped", active: false, generation: 0, targets: new Map() } as State,
    ]),
  );
  const logLimit = Math.max(1, config.logLimit ?? 5000);
  const logsBySource = new Map<string, LogEntry[]>();
  // Views are rebuilt only after new output, not on every 100 ms UI refresh.
  let logVersion = 0;
  let logView: { version: number; selectedId?: string; job?: WorkflowJob; logs: LogEntry[] } | undefined;
  const visibleLogs = () => {
    const s = selectedId ? state(selectedId) : undefined;
    const run = s && workflowView ? selectedWorkflowRun(s) : undefined;
    const job = s && run ? runDetails(s, run)?.jobs.find((item) => item.id === selectedJob) : undefined;
    if (logView?.version === logVersion && logView.selectedId === selectedId && logView.job === job)
      return logView.logs;
    const logs = selectedId
      ? (run?.source === "github"
          ? (s?.githubLogs ?? [])
          : run?.source === "local"
            ? (s?.savedLogs?.logs ?? [])
            : (logsBySource.get(selectedId) ?? [])
        ).filter((entry) => !job || job.logKeys.some((key) => entry.message.startsWith(`[${key}] `)))
      : [...logsBySource.values()].flat().sort((a, b) => a.id - b.id);
    logView = { version: logVersion, selectedId, job, logs };
    return logs;
  };
  let files: LogFiles | undefined;
  const utilities = new Set<RunningProcess>();
  let logId = 0;
  let closing = false;
  let actionLabel = "";
  let actionTask: Promise<void> | undefined;
  let healthTask: Promise<void> | undefined;
  let shutdownTask: Promise<number> | undefined;
  let exitCode = 0;
  let workflowRunOrder = 0;
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
    let logs = logsBySource.get(source);
    if (!logs) logsBySource.set(source, (logs = []));
    logs.push({ id: ++logId, source, message: clean });
    if (logs.length > logLimit) logs.shift();
    logVersion++;
    files?.write(source, clean);
    if (options.plain) process.stdout.write(`[${source}] ${clean}\n`);
  };
  const startService = async (id: string, commandOverride?: string[]) => {
    if (closing) return;
    const service = serviceById(id);
    const s = state(id);
    if (s.stopping) await s.stopping;
    if (closing) return;
    if (s.starting) return s.starting;
    if (s.active && s.status !== "failed") return;
    if (s.active || s.child || s.cleanupNeeded) await ctx.stop(id);
    const command = commandOverride ?? service.command;
    s.starting = (async () => {
      try {
        for (const dep of service.dependsOn ?? []) await ctx.start(dep);
        if (closing) return;
        if (!service.allowOccupiedPort)
          for (const port of servicePorts(service))
            if ((await portInUse(port)) && !(await reclaimPort(port, cwd, (message) => log("supervisor", message)))) {
              const holder = (await portListeners([port], { run: options.run })).get(port)?.[0];
              throw new PortBusyError(service, { port, ...holder });
            }
        s.busy = undefined;
        s.blockedStart = false;
        s.status = "starting";
        s.active = true;
        s.cleanupNeeded = Boolean(service.stop);
        files?.started(id, service.name);
        if (service.start) s.hasStarted = true;
        await service.start?.(ctx);
        if (closing) return;
        if (command) {
          const runOrder = service.workflow ? ++workflowRunOrder : undefined;
          if (runOrder !== undefined) {
            if (service.local && s.localRunOrder !== undefined)
              s.localRuns = await localWorkflowRuns(cwd, service.local, config.workflows);
            s.workflowRun = undefined;
            s.localRunOrder = runOrder;
            s.localStartedAt = new Date().toISOString();
            s.selectedRunId = undefined;
            logsBySource.delete(id);
            if (selectedId === id) syncSelectedRun(service);
            logVersion++;
          }
          const generation = ++s.generation;
          const child = await launch(command, {
            cwd: resolve(cwd, service.cwd ?? "."),
            env: typeof service.env === "function" ? service.env() : service.env,
            terminal: service.terminal && Boolean(process.stdin.isTTY),
            log: (message) => {
              if (service.workflow && message.startsWith("::dev-pad-status::")) {
                try {
                  if (runOrder !== s.localRunOrder) return;
                  s.workflowRun = JSON.parse(message.slice("::dev-pad-status::".length));
                  return;
                } catch {
                  // Keep invalid output in the log as ordinary text.
                }
              }
              log(id, message);
            },
          });
          s.child = child;
          s.hasStarted = true;
          if (closing) return;
          void child.exited.then((code) => {
            child.close();
            if (generation !== s.generation) return;
            // Retain the process group until stop, even if its leader exited.
            s.active = false;
            s.status = code === 0 ? (service.workflow ? "passed" : "stopped") : "failed";
            if (service.workflow && code === 130) s.status = "cancelled";
            if (code !== 0 && s.status !== "cancelled") exitCode = 1;
            log(id, service.workflow ? `Workflow ${s.status}` : `Process exited with code ${code}`);
            writeIndex();
          });
        }
        s.status = service.workflow ? "running" : servicePorts(service).length || service.probe ? "starting" : "ready";
        log("supervisor", `Started ${service.name}`);
      } catch (error) {
        exitCode = 1;
        if (error instanceof PortBusyError && error.service === service) {
          // Nothing was launched: the service stays stopped, flagged busy until the port is freed.
          s.status = "stopped";
          s.busy = error.holder;
          s.blockedStart = true;
          log(id, error.message);
        } else s.status = "failed";
        throw error;
      }
    })();
    try {
      await s.starting;
    } finally {
      s.starting = undefined;
    }
  };
  const ctx: ServiceContext = {
    service: serviceById,
    log,
    async run(command, opts = {}) {
      if (closing && !runningStopHook) throw new Error("Dashboard is stopping");
      const targets = opts.target ? state(opts.target.service).targets : undefined;
      if (opts.target && (!opts.target.id || !opts.target.label))
        throw new Error("Launch targets need an id and label");
      if (opts.target && targets?.get(opts.target.id)?.status === "starting")
        throw Object.assign(new Error(`Target ${opts.target.id} is already starting`), { code: "TARGET_STARTING" });
      const target: TargetStatus | undefined = opts.target
        ? { id: opts.target.id, label: opts.target.label, status: "starting" }
        : undefined;
      if (target) targets?.set(target.id, target);
      const output: string[] = [];
      let child: RunningProcess | undefined;
      const source = opts.source ?? opts.target?.service ?? "supervisor";
      try {
        writeIndex();
        child = await launch(command, {
          cwd: resolve(cwd, opts.cwd ?? "."),
          env: opts.env,
          log: (message) => {
            output.push(message);
            if (!opts.quiet) log(source, message);
          },
        });
        utilities.add(child);
        if (closing && !runningStopHook) await terminate(child);
        const code = await child.exited;
        if (code !== 0)
          throw Object.assign(new Error(`${command.join(" ")} exited with code ${code}`), {
            code: "COMMAND_FAILED",
            exitCode: code,
          });
        if (target) target.status = closing ? "cancelled" : "started";
        return output.join("\n");
      } catch (error) {
        if (target) target.status = closing ? "cancelled" : "failed";
        throw error;
      } finally {
        if (child) {
          utilities.delete(child);
          child.close();
        }
        if (target) log(source, `${target.label}: ${target.status}`);
        writeIndex();
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
    start: startService,
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
        const wasActive = s.active;
        if (!s.active && !s.child && !s.cleanupNeeded) {
          if (!service.workflow) s.status = "stopped";
          return;
        }
        const previousStatus = s.status;
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
          s.status = service.workflow ? (wasActive ? "cancelled" : previousStatus) : "stopped";
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
      const active = services
        .filter((service) => !service.workflow && state(service.id).active)
        .map((service) => service.id);
      for (const id of stopOrder().filter((id) => active.includes(id))) await ctx.stop(id);
      for (const id of active) await ctx.start(id);
    },
  };
  let selectedId: string | undefined;
  let workflowView = false;
  let selectedJob: string | undefined;
  const workflows = services.filter((service) => service.workflow);
  let github: Awaited<ReturnType<typeof githubActions>>;
  let githubMessage = "";
  let discovery: Promise<void> | undefined;
  let lastGithubPoll = 0;
  let lastLocalPoll = 0;
  let displayedRunId: string | undefined;

  /** A saved run's ID (`2026-11-15T16-08-37-887Z-<commit>`) as its start time and commit. */
  const waitingLabel = (id: string) => {
    const match = /^\d{4}-\d{2}-\d{2}T(\d{2})-(\d{2})-[\d-]+Z-(.+)$/.exec(id);
    return match ? `${match[1]}:${match[2]} (${match[3]})` : id;
  };
  const workflowRuns = (s: State): WorkflowRun[] => {
    const runs: WorkflowRun[] = [];
    const liveStartedAt = s.workflowRun?.startedAt ?? s.localStartedAt;
    if (s.localRunOrder !== undefined && liveStartedAt) {
      runs.push({
        id: `live:${s.localRunOrder}`,
        startedAt: Date.parse(liveStartedAt) || 0,
        status: s.status === "running" ? (s.workflowRun?.state ?? "running") : s.status,
        label: `Local · ${liveStartedAt.slice(0, 16).replace("T", " ")}`,
        source: "live",
      });
    }
    for (const saved of s.localRuns ?? []) {
      // DevPad's own run is shown from its live output, before and after its status file lists it.
      if (saved.id === s.workflowRun?.id || (saved.pid !== undefined && saved.pid === s.child?.pid)) continue;
      runs.push({
        id: `local:${saved.id}`,
        startedAt: Date.parse(saved.startedAt) || 0,
        status: saved.state,
        label: `Local · ${saved.startedAt.slice(0, 16).replace("T", " ")}${saved.partial ? ` · ${saved.partial.join(", ")}` : ""}${saved.waitingFor ? ` · waiting for ${waitingLabel(saved.waitingFor)}` : ""}`,
        source: "local",
        saved,
      });
    }
    for (const remote of s.githubRuns ?? []) {
      runs.push({
        id: `github:${remote.databaseId}:${remote.attempt}`,
        startedAt: Date.parse(remote.startedAt || remote.createdAt) || 0,
        status: githubStatus(remote),
        label: `GitHub · #${remote.number} ${remote.headBranch}`,
        source: "github",
        remote,
      });
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  };

  const selectedWorkflowRun = (s: State, runs = workflowRuns(s)) =>
    runs.find((run) => run.id === s.selectedRunId) ?? runs[0];

  const runDetails = (s: State, run: WorkflowRun) => {
    if (run.source === "live") return s.workflowRun;
    if (run.source === "local") return run.saved;
    return s.githubDetail?.id === run.id ? s.githubDetail.details : undefined;
  };

  const loadGitHubLogs = async (service: DashboardService, run: Extract<WorkflowRun, { source: "github" }>) => {
    if (!github || run.remote.status !== "completed" || selectedId !== service.id || closing) return;
    const s = state(service.id);
    const job = selectedJob;
    const key = `${run.id}/${job ?? ""}`;
    if (key === s.githubLogKey) return;
    s.githubLogKey = key;
    s.githubLogs = [];
    logVersion++;
    const output = await github.logs(run.remote, job).catch(githubError);
    if (s.githubLogKey !== key || closing) return;
    s.githubLogs = output
      .trimEnd()
      .split(/\r?\n/)
      .slice(-logLimit)
      .filter(Boolean)
      .map((line) => {
        const message = stripVTControlCharacters(line).replaceAll("\t", "  ");
        return { id: ++logId, source: service.id, message: job ? `[${job}] ${message}` : message };
      });
    logVersion++;
  };

  const syncSelectedRun = (service: DashboardService) => {
    const s = state(service.id);
    const run = selectedWorkflowRun(s);
    if (displayedRunId !== run?.id) {
      displayedRunId = run?.id;
      selectedJob = undefined;
      s.githubLogKey = undefined;
      s.githubLogs = [];
      logVersion++;
    }
    if (run?.source !== "local") return run;
    // A running run's logs grow, so they are read again each refresh until it finishes.
    const logsId = run.status === "running" ? "" : run.id;
    if (logsId && s.savedLogs?.id === logsId) return run;
    const logs: LogEntry[] = [];
    for (const { key, log } of run.saved.logs) {
      readWorkflowLog(run.saved.directory, log, (message) => {
        logs.push({ id: ++logId, source: service.id, message: `[${key}] ${message}` });
      });
      if (logs.length > logLimit) logs.splice(0, logs.length - logLimit);
    }
    s.savedLogs = { id: logsId, logs };
    logVersion++;
    return run;
  };

  const refreshGitHubWorkflow = (service: DashboardService) => {
    const s = state(service.id);
    if (!github || !service.github || closing) return Promise.resolve();
    if (s.githubRequest) return s.githubRequest;
    const client = github;
    const workflow = service.github;
    s.githubRequest = (async () => {
      try {
        s.githubRuns = await client.runs(workflow.id);
        const viewing = selectedId === service.id;
        const run = viewing
          ? syncSelectedRun(service)
          : workflowRuns(s).find((run) => run.source === "github" && ["running", "queued"].includes(run.status));
        if (run?.source !== "github" || closing) return;
        if (
          run.remote.status !== "completed" ||
          s.githubDetail?.id !== run.id ||
          s.githubDetail.details.state !== run.status
        ) {
          const [jobs, definitions] = await Promise.all([
            client.jobs(run.remote),
            client.definition(workflow.path, run.remote.headSha),
          ]);
          if (closing) return;
          const needs = githubJobDependencies(jobs ?? [], definitions);
          s.githubDetail = {
            id: run.id,
            details: {
              state: run.status,
              jobs: (jobs ?? []).map((job) => ({
                id: String(job.databaseId),
                name: job.name,
                state: githubStatus(job),
                needs: needs.get(String(job.databaseId)) ?? [],
                logKeys: [String(job.databaseId)],
              })),
              stages: (jobs ?? [])
                .filter((job) => job.status === "in_progress")
                .map((job) => job.steps?.find((step) => step.status === "in_progress")?.name ?? job.name),
            },
          };
        }
        if (selectedId === service.id && selectedWorkflowRun(s)?.id === run.id) await loadGitHubLogs(service, run);
      } catch (error) {
        s.githubNotice = githubError(error);
      }
    })().finally(() => {
      s.githubRequest = undefined;
    });
    return s.githubRequest;
  };

  const discoverGitHubWorkflows = () => {
    if (config.githubActions === false || options.plain || closing) return Promise.resolve();
    discovery ??= (async () => {
      const client = (github ??= await githubActions(cwd));
      if (!client || closing) return;
      try {
        const [listed, projectPath] = await Promise.all([client.workflows(), realpath(cwd).catch(() => cwd)]);
        if (closing) return;
        githubMessage = "";
        for (const workflow of listed) {
          if (workflows.some((service) => service.github?.id === workflow.id)) continue;
          const local = workflows.find(
            (service) =>
              service.local &&
              relative(client.root, resolve(projectPath, service.local.file)).split(sep).join("/") === workflow.path,
          );
          if (local) {
            local.github = workflow;
            continue;
          }
          let id = `github:${workflow.id}`;
          while (states.has(id)) id = `github:${id}`;
          const service: DashboardService = {
            id,
            name: workflow.name,
            workflow: true,
            github: workflow,
            ports: false,
            autostart: false,
          };
          services.push(service);
          workflows.push(service);
          states.set(id, { status: "idle", active: false, generation: 0, targets: new Map() });
        }
        if (workflowView && !selectedId && workflows[0]) selectEntry(workflows[0].id);
        const runs = await client.runs();
        if (closing) return;
        for (const service of workflows) {
          if (service.github) {
            const s = state(service.id);
            s.githubRuns ??= runs.filter((run) => run.workflowDatabaseId === service.github?.id);
          }
        }
        if (selectedId) openWorkflow(serviceById(selectedId));
      } catch (error) {
        githubMessage = githubError(error);
      }
    })().finally(() => {
      discovery = undefined;
    });
    return discovery;
  };

  const refreshLocalWorkflows = async (service: DashboardService) => {
    if (!service.local) return;
    const [stamp, runs] = await Promise.all([
      localWorkflowRunsStamp(cwd, service.local),
      localWorkflowRuns(cwd, service.local, config.workflows),
    ]);
    if (closing) return;
    state(service.id).localRunsStamp = stamp;
    state(service.id).localRuns = runs;
    if (selectedId === service.id) syncSelectedRun(service);
  };
  const openWorkflow = (service: DashboardService) => {
    if (!service.workflow) return;
    syncSelectedRun(service);
    void refreshLocalWorkflows(service);
    if (service.github) void refreshGitHubWorkflow(service);
  };
  const selectEntry = (id: string) => {
    const service = serviceById(id);
    const changed = id !== selectedId || !workflowView;
    if (changed) {
      selectedJob = undefined;
      displayedRunId = undefined;
      state(id).selectedRunId = undefined;
    }
    workflowView = Boolean(service.workflow);
    selectedId = selectedId === id && !workflowView ? undefined : id;
    if (workflowView) openWorkflow(service);
  };
  const toggleWorkflows = () => {
    if (workflowView) {
      workflowView = false;
      selectedId = undefined;
      selectedJob = undefined;
      displayedRunId = undefined;
      return;
    }
    if (workflows[0]) selectEntry(workflows[0].id);
    else workflowView = true;
    if (!workflows.some((service) => service.github)) void discoverGitHubWorkflows();
  };
  const globalActions = services.flatMap((service) => (service.actions ?? []).filter((action) => action.global));
  const actions: Action[] = [...(config.actions ?? []), ...globalActions];
  if (!actions.some((action) => action.key === "r"))
    actions.push({ key: "r", label: "restart active", run: (ctx) => ctx.restartAll() });
  const availableActions = (): Action[] => {
    if (!selectedId) return workflowView ? [{ key: "f", label: "Refresh", run: discoverGitHubWorkflows }] : actions;
    const service = serviceById(selectedId);
    if (service.workflow) {
      const s = state(service.id);
      const run = selectedWorkflowRun(s);
      const actions: Action[] = [];
      if (service.local && !s.active) {
        actions.push({
          key: "r",
          label: service.github
            ? service.deployCommand
              ? "Local checks"
              : "Run locally"
            : service.deployCommand
              ? "Run checks"
              : "Run workflow",
          run: () => ctx.start(service.id),
        });
        if (service.deployCommand)
          actions.push({
            key: "d",
            label: service.github ? "Local deploy" : "Deploy",
            run: () => startService(service.id, service.deployCommand),
          });
      }
      const client = github;
      const hosted = service.github;
      if (run?.source === "live" && s.active)
        actions.unshift({
          key: "q",
          label: "Cancel run",
          run: () => ctx.stop(service.id),
        });
      // A run started from the command line is cancelled as Ctrl-C there would.
      const runner = run?.source === "local" && ["running", "queued"].includes(run.status) ? run.saved.pid : undefined;
      if (runner)
        actions.unshift({
          key: "q",
          label: "Cancel run",
          async run() {
            try {
              process.kill(runner, "SIGINT");
            } catch {
              // It finished meanwhile.
            }
            await refreshLocalWorkflows(service);
          },
        });
      if (run?.source === "github" && client) {
        if (["running", "queued"].includes(run.status))
          actions.unshift({
            key: "q",
            label: "Cancel run",
            async run() {
              try {
                await client.cancel(run.remote);
                await s.githubRequest;
                await refreshGitHubWorkflow(service);
              } catch (error) {
                s.githubNotice = githubError(error);
              }
            },
          });
        actions.push({ key: "o", label: "Open", run: () => ctx.open(run.remote.url) });
      }
      if (hosted || service.local)
        actions.push({
          key: "f",
          label: "Refresh",
          async run() {
            s.githubNotice = "";
            s.githubLogKey = undefined;
            await Promise.all([refreshLocalWorkflows(service), refreshGitHubWorkflow(service)]);
          },
        });
      return actions;
    }
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
    const busy = isBusy(service.id);
    const kill: Action & { highlight?: boolean } = {
      key: "k",
      label: busy ? `free :${busy.port} (busy)` : "kill ports",
      highlight: Boolean(busy),
      run: () => killPorts(service.id),
    };
    // A busy service leads with the action that frees it.
    defaults.splice(busy ? 0 : 2, 0, kill);
    return [...defaults.filter((action) => !custom.some((item) => item.key === action.key)), ...custom];
  };
  const idle = (s: State) => !s.active && !s.child && !s.starting && !s.stopping;
  const isBusy = (id: string) => {
    const s = state(id);
    return idle(s) ? s.busy : undefined;
  };
  const setBusy = (service: Service, holder: PortHolder | undefined) => {
    const s = state(service.id);
    const before = s.busy;
    s.busy = holder;
    if (holder && (!before || before.port !== holder.port || before.pid !== holder.pid))
      log(service.id, `${service.name} is busy: ${describeHolder(holder)}; press k to free it`);
    else if (!holder && before) {
      log(service.id, `:${before.port} is free again`);
      if (s.blockedStart && !s.starting) log(service.id, `Press r to start ${service.name}`);
    }
  };
  let lastPortPoll = 0;
  /** One lsof/netstat call covers every declared port of the services that are not running. */
  const pollPorts = async (ids?: string[]) => {
    lastPortPoll = Date.now();
    const candidates = services.filter(
      (service) =>
        (!ids || ids.includes(service.id)) &&
        !service.allowOccupiedPort &&
        servicePorts(service).length &&
        idle(state(service.id)),
    );
    if (!candidates.length) return;
    const listeners = await portListeners(candidates.flatMap(servicePorts), { run: options.run });
    for (const service of candidates) {
      if (!idle(state(service.id))) continue;
      const port = servicePorts(service).find((port) => listeners.get(port)?.length);
      setBusy(service, port === undefined ? undefined : { port, ...listeners.get(port)?.[0] });
    }
  };
  const killPorts = async (id: string) => {
    const service = serviceById(id);
    const ports = servicePorts(service);
    if (!ports.length) {
      log(id, `${service.name} declares \`ports: false\`, so there is nothing to kill`);
      return;
    }
    const list = ports.map((port) => `:${port}`).join(", ");
    const s = state(id);
    if (s.active || s.child || s.cleanupNeeded || s.starting) {
      log(id, `Stopping ${service.name} before killing ${list}`);
      await ctx.stop(id);
    }
    const result = await killPortListeners(ports);
    const describe = (item: { pid: number; command: string }) =>
      `PID ${item.pid} (${item.command.length > 80 ? `${item.command.slice(0, 79)}…` : item.command || "unknown"})`;
    for (const item of result.killed)
      log(id, `Killed ${describe(item)}${item.reason === "parent" ? ", parent of the listener" : ""} on :${item.port}`);
    for (const item of result.skipped) log(id, `Left ${describe(item)} on :${item.port}: ${item.reason}`);
    if (result.idle.length) log(id, `Nothing listening on ${result.idle.map((port) => `:${port}`).join(", ")}`);
    if (result.stillListening.length)
      log(id, `Still listening on ${result.stillListening.map((port) => `:${port}`).join(", ")}`);
    await pollPorts([id]);
    if (s.blockedStart && !s.busy) {
      s.blockedStart = false;
      // A start refused for a busy port resumes if the service is meant to run.
      if (service.autostart !== false) {
        log(id, `Starting ${service.name} now its ports are free`);
        await ctx.start(id);
      } else log(id, `Ports are free; press r to start ${service.name}`);
    }
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
  const serviceSnapshots = () =>
    services.map((service, index) => {
      const s = state(service.id);
      const busy = isBusy(service.id);
      const processStatus = busy
        ? "busy"
        : s.status === "stopped" && !s.hasStarted
          ? service.workflow
            ? "idle"
            : "not started"
          : s.status;
      const targets = [...s.targets.values()].map((target) => ({ ...target }));
      const latestRun = service.workflow ? workflowRuns(s)[0] : undefined;
      let status = latestRun?.status ?? processStatus;
      if (targets.length) {
        const started = processStatus === "ready" || targets.some((target) => target.status === "started");
        const failed =
          ["failed", "busy"].includes(processStatus) || targets.some((target) => target.status === "failed");
        if (started && failed) status = "partial";
        else if (processStatus === "starting" || targets.some((target) => target.status === "starting"))
          status = "starting";
        else if (started) status = processStatus === "ready" ? "ready" : "started";
        else if (failed) status = "failed";
      }
      const detail = [
        ...(targets.length
          ? [
              `${service.processLabel ?? "Process"} ${processStatus}`,
              ...targets.map((target) => `${target.label} ${target.status}`),
            ]
          : []),
        ...(busy ? [describeHolder(busy)] : []),
      ].join(" · ");
      return {
        id: service.id,
        name: service.name,
        workflow: service.workflow,
        workflowSource: latestRun ? (latestRun.source === "github" ? "GitHub" : "Local") : undefined,
        shortcut: String(index + 1),
        status,
        processStatus,
        targets,
        url: url(service),
        ...(detail ? { detail } : {}),
        items: service.status?.() ?? [],
      };
    });
  const writeIndex = (running = true) =>
    files?.index(
      serviceSnapshots().map((service) => ({ ...service, ports: servicePorts(serviceById(service.id)) })),
      running,
    );
  if (options.logFiles && config.logFiles !== false) {
    files = createLogFiles(resolve(cwd, config.logFiles?.dir ?? defaultLogDir), {
      maxBytes: config.logFiles?.maxBytes,
      title: config.title,
      cwd,
      sources: services.map((service) => service.id),
      onError: (message) => {
        files = undefined;
        log("supervisor", message);
      },
    });
    writeIndex();
  }
  const workflowSummary = (): Snapshot["workflowSummary"] => {
    const active = workflows
      .flatMap(({ id }) => {
        const s = state(id);
        return workflowRuns(s)
          .filter((run) => ["running", "queued", "starting", "stopping"].includes(run.status))
          .map((run) => ({ run, s }));
      })
      .sort((a, b) => b.run.startedAt - a.run.startedAt);
    const current = workflowView && selectedId ? state(selectedId) : undefined;
    const shown = current && selectedWorkflowRun(current);
    const newest =
      active[0] ??
      workflows
        .flatMap(({ id }) => {
          const s = state(id);
          const run = workflowRuns(s)[0];
          return run ? [{ run, s }] : [];
        })
        .sort((a, b) => b.run.startedAt - a.run.startedAt)[0];
    const entry = shown && current ? { run: shown, s: current } : newest;
    return entry
      ? {
          status: entry.run.status,
          stages: entry.run.status === "running" ? (runDetails(entry.s, entry.run)?.stages ?? []) : [],
        }
      : workflows.length || github
        ? { status: "idle", stages: [] }
        : undefined;
  };
  return {
    ctx,
    /** The directory log files are written to, if they are enabled. */
    logDir: files?.dir,
    snapshot: () => {
      const s = workflowView && selectedId ? state(selectedId) : undefined;
      const runs = s ? workflowRuns(s) : [];
      const run = s && selectedWorkflowRun(s, runs);
      return {
        title: config.title,
        selectedId,
        workflowView,
        selectedJob,
        hasWorkflows: workflows.length > 0 || Boolean(github),
        workflowMessage: workflowView ? s?.githubNotice || githubMessage : undefined,
        workflowRuns: runs.map(({ id, label, status }) => ({ id, label, status })),
        workflowRunId: run?.id,
        workflowSummary: workflowSummary(),
        workflowJobs: s && run ? runDetails(s, run)?.jobs : undefined,
        services: serviceSnapshots(),
        // A selected service narrows the log panel to that service's own output.
        logs: visibleLogs(),
        items: config.status?.() ?? [],
        actions: availableActions().map((action) => ({
          key: action.key,
          label: action.label,
          ...((action as { highlight?: boolean }).highlight ? { highlight: true } : {}),
        })),
        actionLabel,
      };
    },
    start: () =>
      perform("Starting services", async () => {
        if (files) log("supervisor", `Writing logs to ${files.dir}`);
        void discoverGitHubWorkflows();
        await Promise.all(workflows.map(refreshLocalWorkflows));
        const results = await Promise.allSettled(
          services.filter((service) => service.autostart !== false).map((service) => ctx.start(service.id)),
        );
        for (const result of results) if (result.status === "rejected") log("supervisor", String(result.reason));
        writeIndex();
      }),
    async key(key: string) {
      if (key === "c") {
        logsBySource.clear();
        for (const { id } of workflows) {
          const s = state(id);
          if (s.savedLogs) s.savedLogs.logs = [];
          if (s.githubLogs) {
            s.githubLogKey = undefined;
            s.githubLogs = [];
          }
        }
        logVersion++;
        return;
      }
      if (key === "w" && (workflows.length || github)) {
        toggleWorkflows();
        return;
      }
      if (key === "escape") {
        selectedJob = undefined;
        workflowView = false;
        selectedId = undefined;
        return;
      }
      if (workflowView && ["n", "p", "up", "down"].includes(key)) {
        const index = workflows.findIndex((service) => service.id === selectedId);
        const direction = key === "n" || key === "down" ? 1 : -1;
        const next = workflows[(index + direction + workflows.length) % workflows.length];
        if (next) selectEntry(next.id);
        return;
      }
      if (workflowView && selectedId) {
        const service = serviceById(selectedId);
        const s = state(selectedId);
        if (key.startsWith("workflow:")) {
          const id = key.slice("workflow:".length);
          if (workflows.some((workflow) => workflow.id === id)) selectEntry(id);
          return;
        }
        if (["left", "right", "[", "]"].includes(key) || key.startsWith("run:")) {
          const runs = workflowRuns(s);
          const current = runs.findIndex((run) => run.id === selectedWorkflowRun(s, runs)?.id);
          const direction = key === "right" || key === "]" ? 1 : -1;
          const run = key.startsWith("run:")
            ? runs.find((run) => run.id === key.slice(4))
            : runs[Math.max(0, Math.min(runs.length - 1, current + direction))];
          if (!run) return;
          s.selectedRunId = run.id;
          syncSelectedRun(service);
          if (run.source === "github") {
            await s.githubRequest;
            await refreshGitHubWorkflow(service);
          }
          return;
        }
        const run = selectedWorkflowRun(s);
        const jobs = run ? (runDetails(s, run)?.jobs ?? []) : [];
        if (key === "j" || key === "k" || key.startsWith("job:")) {
          if (!jobs.length) return;
          if (key.startsWith("job:")) {
            selectedJob = jobs.find((job) => job.id === key.slice(4))?.id;
          } else {
            // All jobs is the first entry in the same list as the individual jobs.
            const entryCount = jobs.length + 1;
            const entryIndex = jobs.findIndex((job) => job.id === selectedJob) + 1;
            const direction = key === "j" ? 1 : -1;
            const nextIndex = (entryIndex + direction + entryCount) % entryCount;
            selectedJob = jobs[nextIndex - 1]?.id;
          }
          if (run?.source === "github") void loadGitHubLogs(service, run);
          return;
        }
      }
      if (/^[1-9]$/.test(key)) {
        const service = services[Number(key) - 1];
        if (service) selectEntry(service.id);
        return;
      }
      const action = availableActions().find((action) => action.key === key);
      if (action) await perform(action.label, () => action.run(ctx));
    },
    /** Checks now whether stopped services' ports are held; the health loop also does this every few seconds. */
    checkPorts: () => pollPorts(),
    health() {
      if (closing || actionTask || healthTask) return healthTask ?? Promise.resolve();
      healthTask = (async () => {
        if (github && Date.now() - lastGithubPoll >= 8_000) {
          lastGithubPoll = Date.now();
          for (const service of workflows) {
            if (!service.github) continue;
            const s = state(service.id);
            if (
              service.id === selectedId ||
              s.githubRuns?.some((run) => ["running", "queued"].includes(githubStatus(run)))
            )
              void refreshGitHubWorkflow(service);
          }
        }
        // Runs started outside DevPad keep their status file current; read it while one is going,
        // and for the workflow on screen, so they update as DevPad's own runs do. Every other
        // workflow is read again only when a new run directory appears, wherever it was started.
        if (Date.now() - lastLocalPoll >= 2_000) {
          lastLocalPoll = Date.now();
          await Promise.all(
            workflows.map(async (service) => {
              if (!service.local) return;
              const s = state(service.id);
              if (
                service.id === selectedId ||
                s.localRuns?.some((run) => ["running", "queued"].includes(run.state)) ||
                (await localWorkflowRunsStamp(cwd, service.local)) !== s.localRunsStamp
              )
                await refreshLocalWorkflows(service);
            }),
          );
        }
        await config.tick?.(ctx);
        await Promise.all(services.map((service) => service.tick?.(ctx)));
        if (Date.now() - lastPortPoll >= portPollInterval) await pollPorts();
        await Promise.all(
          services.map(async (service) => {
            const s = state(service.id);
            if (service.workflow || !s.active || s.stopping) return;
            const generation = s.generation;
            let healthy = true;
            try {
              if (typeof service.probe === "function") healthy = await service.probe();
              else if (service.probe === "http") {
                const response = await fetch(url(service), { signal: AbortSignal.timeout(900) });
                healthy = response.status < 500;
                await response.body?.cancel();
              } else if (servicePorts(service).length) healthy = await portInUse(servicePorts(service)[0]);
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
          writeIndex();
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
        writeIndex(false);
        files?.close();
        return exitCode;
      })();
      return shutdownTask;
    },
  };
}

export async function runDashboard(config: Config, options: { plain?: boolean; runWorkflow?: string } = {}) {
  const interactive = !options.plain && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const dashboard = createDashboard(config, { plain: !interactive, logFiles: true });
  process.title = config.title;
  if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${config.title.replace(/\p{Cc}/gu, "")}\x07`);
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
    if (options.runWorkflow) {
      const workflow = dashboard
        .snapshot()
        .services.find((service) => service.workflow && service.id === options.runWorkflow);
      if (workflow?.shortcut.length !== 1) throw new Error(`Cannot select workflow: ${options.runWorkflow}`);
      await dashboard.key(workflow.shortcut);
      await dashboard.key("r");
    }
    if (
      !interactive &&
      dashboard
        .snapshot()
        .services.every((service) => ["failed", "stopped", "not started", "busy"].includes(service.status))
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

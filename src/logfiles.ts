import { Buffer } from "node:buffer";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearInterval, setInterval } from "node:timers";

export type LogFileOptions = {
  /** Directory for the log files, relative to the project directory. Defaults to `.dev-pad/logs`. */
  dir?: string;
  /** Size in bytes at which a file moves to `<name>.previous.log` and starts again. Defaults to 2 MB. */
  maxBytes?: number;
};
export type LogFileService = { id: string; name: string; status: string; url: string; ports: readonly number[] };

export const defaultLogDir = join(".dev-pad", "logs");
export const combinedLog = "all";
const reserved = new Set([combinedLog, "readme"]);

/** The file name, without `.log`, that a log source is written to. */
export function logFileName(source: string) {
  const name = source.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_") || "_";
  return reserved.has(name.toLowerCase()) ? `source-${name}` : name;
}

/** Mirrors log lines to plain-text files that agents and other tools can tail while the dashboard runs. */
export function createLogFiles(
  dir: string,
  options: {
    maxBytes?: number;
    title: string;
    cwd: string;
    /** Sources whose files exist from the start, so the index never names a missing file. */
    sources: string[];
    onError: (message: string) => void;
  },
) {
  const maxBytes = Math.max(1024, options.maxBytes ?? 2_000_000);
  type File = { path: string; size: number; pending: string; lines: number };
  const files = new Map<string, File>();
  let failed = false;
  let lastIndex = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimers = () => {
    clearInterval(timer);
    process.off("exit", flush);
  };
  const guard = (task: () => void) => {
    if (failed) return;
    try {
      task();
    } catch (error) {
      // A full disk or unwritable directory must never stop the dashboard.
      failed = true;
      stopTimers();
      options.onError(`Log files disabled: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const rotate = (file: File) => {
    if (existsSync(file.path)) renameSync(file.path, file.path.replace(/\.log$/, ".previous.log"));
    file.size = 0;
    file.lines = 0;
  };
  const open = (name: string) => {
    let file = files.get(name);
    if (!file) {
      file = { path: join(dir, `${name}.log`), size: 0, pending: "", lines: 0 };
      files.set(name, file);
      // A new session starts each file afresh; the last session's output stays in `.previous.log`.
      rotate(file);
    }
    return file;
  };
  const flushFile = (file: File) => {
    if (!file.pending) return;
    const bytes = Buffer.byteLength(file.pending);
    if (file.size && file.size + bytes > maxBytes) rotate(file);
    appendFileSync(file.path, file.pending);
    file.size += bytes;
    file.pending = "";
  };
  const flush = () => guard(() => files.forEach(flushFile));
  const append = (name: string, text: string) => {
    const file = open(name);
    file.pending += text;
    if (Buffer.byteLength(file.pending) > 65_536) flushFile(file);
  };
  const format = (source: string, message: string, time = new Date().toISOString()) =>
    message
      .split(/\r?\n/)
      .map((line) => `${time} [${source}] ${line}\n`)
      .join("");
  guard(() => {
    mkdirSync(dir, { recursive: true });
    // Keeps the files out of version control without editing the project's .gitignore.
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    for (const name of [combinedLog, "supervisor", ...options.sources.map(logFileName)])
      writeFileSync(open(name).path, "");
    timer = setInterval(flush, 100);
    timer.unref();
  });
  process.on("exit", flush);
  return {
    dir,
    write(source: string, message: string) {
      guard(() => {
        const lines = format(source, message);
        const file = open(logFileName(source));
        append(logFileName(source), lines);
        file.lines++;
        append(combinedLog, lines);
      });
    },
    /** A service is starting: its file restarts if the previous run wrote anything, and the combined log is marked. */
    started(source: string, name: string) {
      guard(() => {
        const file = open(logFileName(source));
        flushFile(file);
        if (file.lines) rotate(file);
        const marker = format(source, `──── ${name} starting ────`);
        append(logFileName(source), marker);
        append(combinedLog, marker);
      });
    },
    /** Rewrites README.md, listing each service's status, URL, ports and log file, when any of them changed. */
    index(services: LogFileService[], running = true) {
      guard(() => {
        const cell = (value: string) => value.replace(/\|/g, "\\|") || "–";
        const body = [
          `# dev-pad logs: ${options.title}`,
          "",
          running
            ? `dev-pad is running (PID ${process.pid}) for ${options.cwd}.`
            : `dev-pad stopped. These files are from its last session for ${options.cwd}.`,
          "",
          "Each file mirrors one log source, oldest line first; read the end of the file for the latest output.",
          "Lines are `<ISO time> [<source>] <message>` with terminal colours removed. A service's file starts",
          "again when the service restarts or reaches the size limit; the earlier run is in `<file>.previous.log`.",
          "",
          "| Service | Status | URL | Ports | Log file |",
          "| --- | --- | --- | --- | --- |",
          ...services.map(
            (service) =>
              `| ${cell(`${service.name} (\`${service.id}\`)`)} | ${cell(running ? service.status : "not running")} | ${cell(service.url)} | ${cell(service.ports.join(", "))} | ${logFileName(service.id)}.log |`,
          ),
          "",
          `Also: \`supervisor.log\` (dev-pad's own messages) and \`${combinedLog}.log\` (every source, interleaved).`,
          "Utility commands run from actions write to a file named after their source.",
          "",
        ].join("\n");
        if (body === lastIndex) return;
        lastIndex = body;
        const path = join(dir, "README.md");
        writeFileSync(`${path}.tmp`, body);
        renameSync(`${path}.tmp`, path);
      });
    },
    flush,
    close() {
      flush();
      stopTimers();
    },
  };
}
export type LogFiles = ReturnType<typeof createLogFiles>;

/** Size of a log file, or 0 if it does not exist. */
export function logFileSize(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

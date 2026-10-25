#!/usr/bin/env node
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Config, defaultLogDir, logFileName, runDashboard, validateConfig } from "./index.js";
import { logFileSize } from "./logfiles.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    `dev-pad / devpad / dpad [--config dev-pad.config.ts] [--plain] [--check]\ndev-pad logs [service] [--lines N] [--follow]\n\nKeys: 1–9 select service, then r start/restart, q stop, k kill whatever listens on its ports, o open, Esc back.\nTop level: r restart active, c clear, ${process.platform === "darwin" ? "Cmd+C" : "Ctrl+C"} quit.\nCustom service actions are shown in the dashboard.`,
  );
} else if (args.includes("--version")) {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
} else {
  try {
    const config = await loadConfig();
    if (args[0] === "logs") await printLogs(config, args.slice(1));
    else if (args.includes("--check"))
      console.log(`${config.title}: ${config.services.map((service) => service.id).join(", ")}`);
    else await runDashboard(config, { plain: args.includes("--plain") });
  } catch (error) {
    console.error(`dev-pad: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/** The value after `flag`, which must not itself look like a flag. */
function option(flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}

async function loadConfig() {
  const configPath = option("--config");
  const file = resolve(
    configPath ??
      ["dev-pad.config.ts", "dev-pad.config.mts", "dev-pad.config.js", "dev-pad.config.mjs"].find(existsSync) ??
      "dev-pad.config.ts",
  );
  if (!existsSync(file)) throw new Error(`No config found at ${file}`);
  let config: Config;
  if (!("Bun" in globalThis) && !("Deno" in globalThis) && /\.m?ts$/.test(file)) {
    const { tsImport } = await import("tsx/esm/api");
    config = (await tsImport(pathToFileURL(file).href, import.meta.url)).default;
  } else config = (await import(pathToFileURL(file).href)).default;
  if (config && "default" in config && !config.services) config = (config as unknown as { default: Config }).default;
  config = { ...config, cwd: config.cwd ?? dirname(file) };
  validateConfig(config);
  return config;
}

/** `dev-pad logs [source] [--lines N] [--follow]` prints the files a running (or the last) dashboard wrote. */
async function printLogs(config: Config, rest: string[]) {
  if (config.logFiles === false) throw new Error("Log files are turned off in this config (`logFiles: false`)");
  const dir = resolve(config.cwd ?? ".", config.logFiles?.dir ?? defaultLogDir);
  const source = rest.find((arg, index) => !arg.startsWith("--") && !rest[index - 1]?.match(/^--(lines|config)$/));
  if (!source) {
    const index = join(dir, "README.md");
    if (!existsSync(index)) throw new Error(`No logs in ${dir} yet; start dev-pad first`);
    process.stdout.write(readFileSync(index, "utf8"));
    return;
  }
  const linesValue = option("--lines") ?? "100";
  const lines = Number(linesValue);
  if (!Number.isInteger(lines) || lines < 0) throw new Error(`--lines must be a whole number, not ${linesValue}`);
  const path = join(dir, `${logFileName(source)}.log`);
  if (!existsSync(path)) {
    const available = existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".log") && !name.endsWith(".previous.log"))
          .map((name) => name.slice(0, -4))
      : [];
    throw new Error(
      `No log file for ${source} in ${dir}${available.length ? `; available: ${available.join(", ")}` : ""}`,
    );
  }
  const text = readFileSync(path, "utf8");
  const tail = text.split("\n").slice(0, -1).slice(-lines);
  if (tail.length && lines) process.stdout.write(`${tail.join("\n")}\n`);
  if (!args.includes("--follow")) return;
  let offset = Buffer.byteLength(text);
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      const size = logFileSize(path);
      // The file shrinks when the service restarts or reaches the size limit and starts again.
      if (size < offset) offset = 0;
      if (size === offset) return;
      const fd = openSync(path, "r");
      try {
        const chunk = Buffer.alloc(size - offset);
        readSync(fd, chunk, 0, chunk.length, offset);
        process.stdout.write(chunk);
        offset = size;
      } finally {
        closeSync(fd);
      }
    }, 250);
    const stop = () => {
      clearInterval(timer);
      done();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Config, runDashboard, validateConfig } from "./index.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "runui / run-ui / rui [--config runui.config.ts] [--plain] [--check]\n\nKeys: 1–9 select service, then r start/restart, q stop, o open, Esc back.\nTop level: r restart active, c clear, Ctrl+C quit.\nCustom service actions are shown in the dashboard.",
  );
} else if (args.includes("--version")) {
  console.log("0.1.0");
} else {
  try {
    const configIndex = args.indexOf("--config");
    if (configIndex >= 0 && (!args[configIndex + 1] || args[configIndex + 1].startsWith("--")))
      throw new Error("--config requires a path");
    const file = resolve(
      configIndex >= 0
        ? args[configIndex + 1]
        : (["runui.config.ts", "runui.config.mts", "runui.config.js", "runui.config.mjs"].find(existsSync) ??
            "runui.config.ts"),
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
    if (args.includes("--check"))
      console.log(`${config.title}: ${config.services.map((service) => service.id).join(", ")}`);
    else await runDashboard(config, { plain: args.includes("--plain") });
  } catch (error) {
    console.error(`runui: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

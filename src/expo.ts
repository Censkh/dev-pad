import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Service, ServiceContext } from "./index.js";

export type ExpoPlatform = "ios" | "android";
export type ExpoOptions = Partial<Service> & {
  /** Command used when Metro is not running or cannot take key input. Defaults to `command` plus `--ios`/`--android`. */
  launch?: (platform: ExpoPlatform) => string[];
  /** Host ports to expose to Android devices with `adb reverse`, in addition to Metro's port. */
  androidPorts?: number[];
  /** adb executable. Defaults to the Android SDK's platform-tools, then `adb` on the PATH. */
  adb?: string;
};

const platformNames = { ios: "iOS", android: "Android" };

export function defaultAdb() {
  const sdk =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    resolve(homedir(), process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
  const adb = resolve(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  return existsSync(adb) ? adb : "adb";
}

/** Reverses each port on every ready device, skipping mappings that already exist. */
export async function reverseAndroidPorts(
  run: (args: string[]) => Promise<string>,
  ports: number[],
  log: (message: string) => void,
) {
  const devices = (await run(["devices"]))
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([, state]) => state === "device")
    .map(([serial]) => serial);
  for (const serial of devices) {
    const existing = (await run(["-s", serial, "reverse", "--list"]))
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/));
    for (const port of new Set(ports)) {
      const endpoint = `tcp:${port}`;
      if (existing.some((parts) => parts.at(-2) === endpoint && parts.at(-1) === endpoint)) continue;
      await run(["-s", serial, "reverse", endpoint, endpoint]);
      log(`Android ${serial}: localhost:${port} → host:${port}`);
    }
  }
}

/** An Expo service with iOS/Android launch actions and Android port forwarding. */
export function expo(options: ExpoOptions = {}): Service {
  const { launch: launchCommand, androidPorts = [], adb, ...overrides } = options;
  const id = overrides.id ?? "mobile";
  const name = overrides.name ?? "Expo";
  const command = overrides.command ?? ["bun", "run", "dev"];
  const port = overrides.port ?? 8081;
  let forwarding = false;
  let forwardingError = "";

  const launch = async (ctx: ServiceContext, platform: ExpoPlatform) => {
    if (platform === "android") forwarding = true;
    // Metro only reads its i/a shortcuts through Bun's PTY.
    if (
      "Bun" in globalThis &&
      process.platform !== "win32" &&
      process.stdin.isTTY &&
      ctx.write(id, platform === "ios" ? "i" : "a")
    )
      return;
    const service = ctx.service(id);
    service.name = `${name} ${platformNames[platform]}`;
    service.command = launchCommand?.(platform) ?? [...command, `--${platform}`];
    await ctx.restart(id);
  };

  return {
    url: `http://localhost:${port}`,
    terminal: true,
    ...overrides,
    id,
    name,
    command,
    port,
    actions: [
      { key: "i", label: "iOS", global: true, run: (ctx) => launch(ctx, "ios") },
      { key: "a", label: "Android", global: true, run: (ctx) => launch(ctx, "android") },
      ...(overrides.actions ?? []),
    ],
    status: () => [
      ...(forwarding
        ? [
            {
              label: "Android forwarding",
              value: forwardingError || [port, ...androidPorts].join(", "),
              tone: forwardingError ? ("warning" as const) : ("success" as const),
            },
          ]
        : []),
      ...(overrides.status?.() ?? []),
    ],
    async tick(ctx) {
      await overrides.tick?.(ctx);
      if (!forwarding) return;
      const executable = adb ?? defaultAdb();
      try {
        await reverseAndroidPorts(
          (args) => ctx.run([executable, ...args], { source: "adb", quiet: true }),
          [port, ...androidPorts],
          (message) => ctx.log("supervisor", message),
        );
        forwardingError = "";
      } catch (error) {
        const message = String(error);
        if (message !== forwardingError) ctx.log("supervisor", `Android port forwarding: ${message}`);
        forwardingError = message;
      }
    },
  };
}

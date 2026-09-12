import { spawn } from "node:child_process";
import { logStream } from "./logs.js";

export type RunningProcess = {
  pid: number;
  exited: Promise<number>;
  write(value: string): void;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  close(): void;
};
type SpawnOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
  terminal?: boolean;
  log: (message: string) => void;
};

export async function launch(command: string[], options: SpawnOptions): Promise<RunningProcess> {
  const streams = [logStream(options.log), logStream(options.log)];
  // Bun's PTY is used for Expo keyboard input; other runtimes use ordinary pipes.
  const bun = (
    globalThis as unknown as {
      Bun?: {
        spawn(
          command: string[],
          options: Record<string, unknown>,
        ): {
          pid: number;
          exited: Promise<number>;
          kill(signal: number): void;
          terminal: { write(input: string): void; close(): void };
        };
      };
    }
  ).Bun;
  if (options.terminal && bun && process.platform !== "win32") {
    const decoder = new TextDecoder();
    const child = bun.spawn(command, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      terminal: {
        cols: process.stdout.columns || 100,
        rows: process.stdout.rows || 30,
        data: (_terminal: unknown, bytes: Uint8Array) => streams[0].write(decoder.decode(bytes, { stream: true })),
      },
    });
    const exited = child.exited.then((code) => {
      streams[0].write(decoder.decode());
      streams[0].end();
      return code;
    });
    return {
      pid: child.pid,
      exited,
      write: (input) => child.terminal.write(input),
      kill: (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal === "SIGKILL" ? 9 : 15);
        }
      },
      close: () => child.terminal.close(),
    };
  }
  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.on("error", () => {});
  child.stdout?.setEncoding("utf8").on("data", (chunk) => streams[0].write(chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk) => streams[1].write(chunk));
  const exited = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      options.log(error.message);
      resolve(1);
    });
    child.once("close", (code, signal) => {
      for (const stream of streams) stream.end();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return {
    pid: child.pid as number,
    exited,
    write: (input) => {
      child.stdin.write(input);
    },
    kill: (signal) => {
      if (process.platform === "win32") {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-(child.pid as number), signal);
      } catch {
        child.kill(signal);
      }
    },
    close: () => {
      child.stdin.destroy();
    },
  };
}

export async function terminate(child: RunningProcess) {
  child.kill("SIGTERM");
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  const groupAlive = () => {
    if (process.platform === "win32") return !exited;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 2500;
  // A shell can exit before a descendant that ignored SIGTERM. Check the whole group.
  while (Date.now() < deadline && (!exited || groupAlive())) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!exited || groupAlive()) child.kill("SIGKILL");
  await child.exited;
  child.close();
}

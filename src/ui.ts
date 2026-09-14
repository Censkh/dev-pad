import process from "node:process";
import { emitKeypressEvents, type Key } from "node:readline";
import { stripVTControlCharacters } from "node:util";

export type StatusItem = { label: string; value: string; tone?: string };
export type Snapshot = {
  title: string;
  selectedId?: string;
  services: Array<{ id: string; name: string; status: string; url: string; items?: StatusItem[] }>;
  logs: Array<{ id: number; source: string; message: string }>;
  items: StatusItem[];
  actions: Array<{ key: string; label: string }>;
  actionLabel: string;
};

export const palette = {
  background: "#08080d",
  border: "#3d3d52",
  danger: "#fb7185",
  foreground: "#f4f4f5",
  info: "#67e8f9",
  muted: "#85859b",
  panel: "#11111a",
  primary: "#e879f9",
  success: "#4ade80",
  warning: "#fbbf24",
};

export const cleanText = (text: string) => stripVTControlCharacters(text).replace(/\p{Cc}/gu, " ");

export function statusAppearance(status: string) {
  switch (status) {
    case "ready":
      return { tone: "success", marker: "●" };
    case "failed":
      return { tone: "danger", marker: "✗" };
    case "restarting":
      return { tone: "warning", marker: "↻" };
    case "starting":
    case "stopping":
      return { tone: "warning", marker: "◌" };
    default:
      return { tone: "muted", marker: "○" };
  }
}

export async function mountUI(
  getSnapshot: () => Snapshot,
  onKey: (key: string) => void,
  theme: Record<string, string> = {},
): Promise<() => void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return () => {};
  if ("Bun" in globalThis) {
    const ui = await import("./opentui.js");
    return ui.mountUI(getSnapshot, onKey, theme);
  }

  const colors: Record<string, string> = { ...palette, ...theme };
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let anchor: number | undefined;
  let logHeight = 1;
  let previousFrame = "";
  const esc = "\x1b[";
  const color = (tone: string) => {
    const hex = colors[tone] ?? tone;
    if (!/^#[\da-f]{6}$/i.test(hex)) return "";
    const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
    return `${esc}38;2;${rgb.join(";")}m`;
  };
  // Conservative cell widths keep CJK and emoji from wrapping past the viewport.
  const clip = (value: string, width: number) => {
    let result = "";
    let cells = 0;
    for (const char of cleanText(value)) {
      const code = char.codePointAt(0) ?? 0;
      const size = /[\p{Mark}\p{Cf}]/u.test(char)
        ? 0
        : code >= 0x1100 &&
            (code <= 0x115f ||
              (code >= 0x2329 && code <= 0xa4cf) ||
              (code >= 0xac00 && code <= 0xd7a3) ||
              (code >= 0xf900 && code <= 0xfaff) ||
              (code >= 0xfe10 && code <= 0xfe6f) ||
              (code >= 0xff01 && code <= 0xff60) ||
              (code >= 0xffe0 && code <= 0xffe6) ||
              code >= 0x1f000)
          ? 2
          : 1;
      if (cells + size > width) break;
      result += char;
      cells += size;
    }
    return result;
  };
  const logEnd = (logs: Snapshot["logs"]) => {
    if (anchor === undefined) return logs.length;
    const index = logs.findIndex((entry) => entry.id === anchor);
    return Math.min(logs.length, Math.max(logHeight, index + 1));
  };
  const render = () => {
    if (disposed) return;
    const snapshot = getSnapshot();
    const width = Math.max(0, (output.columns || 80) - 1);
    const height = Math.max(1, output.rows || 24);
    const lines: string[] = [];
    const line = (text: string, tone = "foreground") => lines.push(`${color(tone)}${clip(text, width)}${esc}0m${esc}K`);
    line(
      ` ${snapshot.title}${snapshot.selectedId ? ` · Selected: ${snapshot.services.find((service) => service.id === snapshot.selectedId)?.name}` : ""}`,
      "primary",
    );
    const details: Array<[string, string]> = [];
    for (const [index, service] of snapshot.services.entries()) {
      const appearance = statusAppearance(service.status);
      details.push([
        ` ${`${snapshot.selectedId === service.id ? ">" : ""}${index + 1}.`.padEnd(4)}${appearance.marker}  ${service.name}  ${service.status}  ${service.url}`,
        appearance.tone,
      ]);
      for (const item of service.items ?? [])
        details.push([`        ${item.label}: ${item.value}`, item.tone ?? "muted"]);
    }
    for (const item of snapshot.items) details.push([` ${item.label}: ${item.value}`, item.tone ?? "info"]);
    const budget = Math.max(0, height - 7);
    const visible = details.slice(0, budget);
    if (details.length > budget && visible.length)
      visible[visible.length - 1] = [` … ${details.length - budget + 1} more status rows`, "muted"];
    for (const [text, tone] of visible) line(text, tone);
    const logs = snapshot.logs.slice(-500);
    logHeight = Math.max(1, height - lines.length - 4);
    const end = logEnd(logs);
    line(` ─ Recent logs · ${end}/${logs.length}${anchor === undefined ? " · live" : " · scrolled"} ─`, "primary");
    const visibleLogs = logs.slice(Math.max(0, end - logHeight), end);
    for (let i = 0; i < logHeight; i++) {
      const entry = visibleLogs[i];
      line(
        entry ? ` [${entry.source}] ${entry.message}` : i === 0 ? " Waiting for service output…" : "",
        entry && /\b(error|failed|fatal)\b/i.test(entry.message) ? "danger" : "muted",
      );
    }
    line(` ${snapshot.actionLabel}`, "info");
    line(` ${"─".repeat(Math.max(0, width - 1))}`, "muted");
    const actions = snapshot.actions.map(({ key, label }) => `${key} ${label}`);
    line(
      ` ${(snapshot.selectedId ? [...actions, "Esc back", "1–9 select"] : [`${process.platform === "darwin" ? "Cmd+C" : "Ctrl+C"} quit`, "c clear", ...actions, "↑↓ logs", ...(snapshot.services.length ? ["1–9 select"] : [])]).join(" · ")}`,
      "warning",
    );
    const frame = lines.slice(0, height).join("\r\n");
    if (frame !== previousFrame) {
      output.write(`${esc}H${frame}${esc}J`);
      previousFrame = frame;
    }
  };
  const keypress = (text: string, key: Key = {}) => {
    if (key.name === "up" || key.name === "down") {
      const logs = getSnapshot().logs.slice(-500);
      const end = Math.min(logs.length, Math.max(logHeight, logEnd(logs) + (key.name === "up" ? -1 : 1)));
      anchor = end >= logs.length ? undefined : logs[end - 1]?.id;
      render();
      return;
    }
    if (key.ctrl && key.name === "c") {
      onKey("ctrl+c");
      return;
    }
    if (key.name === "escape") {
      onKey("escape");
      return;
    }
    if (key.ctrl || key.meta) return;
    const value = key.name === "escape" ? "escape" : text || key.name || "";
    if (
      value === "escape" ||
      value === "q" ||
      value === "r" ||
      value === "c" ||
      /^[0-9]$/.test(value) ||
      getSnapshot().actions.some((action) => action.key === value)
    )
      onKey(value);
  };
  const resize = () => {
    previousFrame = "";
    render();
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    input.off("keypress", keypress);
    output.off("resize", resize);
    process.off("exit", cleanup);
    input.setRawMode(Boolean(wasRaw));
    if (!wasFlowing) input.pause();
    output.write(`${esc}0m${esc}?25h${esc}?1049l`);
  };
  try {
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on("keypress", keypress);
    output.on("resize", resize);
    process.once("exit", cleanup);
    input.resume();
    output.write(`${esc}?1049h${esc}?25l${esc}2J`);
    render();
    timer = setInterval(render, 100);
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}

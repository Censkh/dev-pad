import process from "node:process";
import { emitKeypressEvents, type Key } from "node:readline";
import { stripVTControlCharacters } from "node:util";

export type StatusItem = { label: string; value: string; tone?: string };
export type WorkflowJob = {
  id: string;
  name: string;
  state: string;
  /** Why the job is in its state, such as the machine's load a queued job waits for. */
  note?: string;
  needs: string[];
  logKeys: string[];
};
export type Snapshot = {
  title: string;
  selectedId?: string;
  workflowView?: boolean;
  workflowMessage?: string;
  workflowRuns?: { id: string; label: string; status: string }[];
  workflowRunId?: string;
  /** The options the selected run was started with. */
  workflowRunOptions?: string;
  hasWorkflows?: boolean;
  workflowJobs?: WorkflowJob[];
  workflowSummary?: { status: string; stages: string[] };
  selectedJob?: string;
  services: Array<{
    id: string;
    name: string;
    workflow?: boolean;
    workflowSource?: string;
    shortcut?: string;
    status: string;
    url: string;
    /** Shown instead of the URL, e.g. which process holds a busy service's port. */
    detail?: string;
    items?: StatusItem[];
  }>;
  logs: Array<{ id: number; source: string; message: string }>;
  items: StatusItem[];
  /** `highlight` marks the action that resolves the selected service's problem, such as freeing a busy port. */
  actions: Array<{ key: string; label: string; highlight?: boolean }>;
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

// Both renderers sample this on their existing refresh loop.
export const runningPulse = () => Math.floor(performance.now() / 650) % 2 === 0;

export function statusAppearance(status: string, pulse = false) {
  switch (status) {
    case "success":
    case "passed":
    case "started":
    case "ready":
      return { tone: "success", marker: "●" };
    case "failure":
    case "failed":
      return { tone: "danger", marker: "✗" };
    case "partial":
    case "busy":
      return { tone: "warning", marker: "!" };
    case "restarting":
      return { tone: "warning", marker: "↻" };
    case "running":
      return { tone: "warning", marker: pulse ? "●" : "◌" };
    case "starting":
    case "queued":
    case "stopping":
      return { tone: "warning", marker: "◌" };
    default:
      return { tone: "muted", marker: "○" };
  }
}

// Conservative cell widths keep CJK and emoji from wrapping past the viewport.
function fitText(value: string, width: number) {
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
  return { text: result, cells };
}

export function workflowChip(snapshot: Snapshot, width: number, pulse = false) {
  if (!snapshot.hasWorkflows) return undefined;
  const destination = snapshot.workflowView ? "Commands" : "Workflows";
  const { status, stages } = snapshot.workflowSummary ?? { status: "idle", stages: [] };
  const { marker, tone } = statusAppearance(status, pulse);
  const stateLabel = (status === "running" ? `${marker} ` : "") + status.charAt(0).toUpperCase() + status.slice(1);
  const budget = Math.max(0, width - Math.min(22, Math.floor(width / 3)) - 1);
  const fullLabel = `w ${destination} · ${stateLabel}`;
  const label = budget >= fullLabel.length + (stages.length ? 9 : 0) ? fullLabel : `w ${stateLabel}`;
  const extra = stages.length > 1 ? ` +${stages.length - 1}` : "";
  const stageWidth = budget - label.length - 3 - extra.length;
  const stage = stages[0] && stageWidth > 0 ? fitText(stages[0], stageWidth).text : "";
  return {
    ...fitText(stage ? `${label} · ${stage}${extra}` : label, budget),
    tone,
  };
}

type FooterAction = Snapshot["actions"][number] & { input?: string };

export function footerActions(snapshot: Snapshot, width: number, chipWidth: number) {
  const commands = snapshot.actions.map((action) => ({ ...action, input: action.key }));
  const select = { key: "1–9", label: "select" };
  if (snapshot.workflowView && snapshot.workflowJobs?.length) {
    commands.push({ key: "j", label: "next job", input: "j" }, { key: "k", label: "previous job", input: "k" });
  }
  const actions: FooterAction[] =
    snapshot.workflowView || snapshot.selectedId
      ? [...commands, { key: "Esc", label: "back", input: "escape" }, select]
      : [
          { key: process.platform === "darwin" ? "Cmd+C" : "Ctrl+C", label: "quit", input: "ctrl+c" },
          { key: "c", label: "clear", input: "c" },
          ...commands,
          ...(snapshot.services.length ? [select] : []),
          { key: "↑↓", label: "logs" },
          { key: "drag", label: "copy" },
        ];
  const measure = ({ key, label, highlight }: FooterAction) =>
    fitText(`${key} ${label}`, Infinity).cells + (highlight ? 2 : 0);
  const inlineBudget = Math.max(0, width - chipWidth - Number(chipWidth > 0));

  if (!snapshot.workflowView) {
    const inline: FooterAction[] = [];
    let inlineWidth = 0;
    for (const action of actions) {
      const cells = measure(action) + (inline.length ? 3 : 0);
      if (inlineWidth + cells > inlineBudget) break;
      inline.push(action);
      inlineWidth += cells;
    }
    return { inline, inlineWidth, rows: [] };
  }

  const rows: FooterAction[][] = [];
  let rowWidth = 0;
  for (const action of actions) {
    const cells = measure(action);
    const row = rows.at(-1);
    if (!row || rowWidth + 3 + cells > width) {
      rows.push([action]);
      rowWidth = cells;
    } else {
      row.push(action);
      rowWidth += 3 + cells;
    }
  }
  const finalRow = rows.at(-1);
  if (finalRow && rowWidth <= inlineBudget) {
    rows.pop();
    return { inline: finalRow, inlineWidth: rowWidth, rows };
  }
  return { inline: [], inlineWidth: 0, rows };
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
  let anchoredSelection: string | undefined;
  const esc = "\x1b[";
  const color = (tone: string, background = false) => {
    const hex = colors[tone] ?? tone;
    if (!/^#[\da-f]{6}$/i.test(hex)) return "";
    const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
    return `${esc}${background ? 48 : 38};2;${rgb.join(";")}m`;
  };
  const clip = (text: string, width: number) => fitText(text, width).text;
  const logEnd = (logs: Snapshot["logs"]) => {
    if (anchor === undefined) return logs.length;
    const index = logs.findIndex((entry) => entry.id === anchor);
    return Math.min(logs.length, Math.max(logHeight, index + 1));
  };
  const render = () => {
    if (disposed) return;
    const snapshot = getSnapshot();
    const pulse = runningPulse();
    // Log ids differ per filter, so a scroll position never carries across selections.
    const selection =
      [snapshot.selectedId, snapshot.workflowRunId, snapshot.selectedJob].filter(Boolean).join("/") || undefined;
    if (selection !== anchoredSelection) {
      anchor = undefined;
      anchoredSelection = selection;
    }
    const selectedName = snapshot.services.find((service) => service.id === snapshot.selectedId)?.name;
    const width = Math.max(0, (output.columns || 80) - 1);
    const height = Math.max(1, output.rows || 24);
    const lines: string[] = [];
    const line = (text: string, tone = "foreground", selected = false) =>
      lines.push(
        selected
          ? `${color(tone)}${color("border", true)}${clip(text, width)}${esc}K${esc}0m`
          : `${color(tone)}${clip(text, width)}${esc}0m${esc}K`,
      );
    line(` ${snapshot.title}${snapshot.selectedId ? ` · Selected: ${selectedName}` : ""}`, "primary");
    const run = snapshot.workflowRuns?.find((run) => run.id === snapshot.workflowRunId);
    const chip = workflowChip(snapshot, width, pulse);
    const footer = footerActions(snapshot, Math.max(0, width - 1), chip?.cells ?? 0);
    if (run) {
      const indicator = run.status === "running" ? `${statusAppearance(run.status, pulse).marker} ` : "";
      line(
        ` ←→ Runs · ${run.label} · ${indicator}${run.status}${snapshot.workflowRunOptions ? ` · ${snapshot.workflowRunOptions}` : ""}`,
        "info",
      );
    }
    const budget = Math.max(0, height - 7 - footer.rows.length - Number(Boolean(run)));
    const detailCount =
      snapshot.items.length + snapshot.services.reduce((count, service) => count + (service.items?.length ?? 0), 0);
    const statusDetailsFit = snapshot.services.length + detailCount <= budget;
    const entries = snapshot.services
      .map((service, index) => ({
        service,
        key: service.shortcut ?? String(index + 1),
      }))
      .filter(({ service }) => Boolean(service.workflow) === Boolean(snapshot.workflowView));
    const commandEntries = entries.filter(({ service }) => !service.workflow);
    const workflowEntries = entries.filter(({ service }) => service.workflow);
    const commands: Array<[string, string, boolean?]> = [];
    for (const { service, key } of commandEntries) {
      const appearance = statusAppearance(service.status, pulse);
      commands.push([
        ` ${`${key}.`.padEnd(4)}${appearance.marker}  ${service.name}  ${service.status}${service.detail ? ` · ${service.detail}` : `  ${service.url}`}`,
        appearance.tone,
        snapshot.selectedId === service.id,
      ]);
      for (const item of statusDetailsFit ? (service.items ?? []) : [])
        commands.push([`        ${item.label}: ${item.value}`, item.tone ?? "muted"]);
    }
    for (const item of statusDetailsFit && !snapshot.workflowView ? snapshot.items : [])
      commands.push([` ${item.label}: ${item.value}`, item.tone ?? "info"]);
    for (const job of snapshot.workflowJobs ?? []) {
      const { marker, tone } = statusAppearance(job.state, pulse);
      const dependencies = job.needs.length ? ` ← ${job.needs.join(", ")}` : "";
      commands.push([
        ` ${job.id === snapshot.selectedJob ? `>${job.state === "running" ? marker : ""}` : marker} ${job.name}${dependencies} · ${job.state}${job.note ? ` · ${job.note}` : ""}`,
        tone,
      ]);
    }
    const selectedIndex = snapshot.workflowView
      ? (snapshot.workflowJobs?.findIndex((job) => job.id === snapshot.selectedJob) ?? -1)
      : commandEntries.findIndex(({ service }) => service.id === snapshot.selectedId);
    const first = Math.max(0, selectedIndex - budget + 1);
    const visible = commands.slice(first, first + budget);
    if (workflowEntries.length) {
      const rightWidth = Math.min(36, Math.max(19, Math.floor(width * 0.4)));
      const leftWidth = Math.max(0, width - rightWidth - 1);
      const workflowIndex = workflowEntries.findIndex(({ service }) => service.id === snapshot.selectedId);
      const count = Math.floor(budget / 2);
      const right = workflowEntries
        .slice(Math.max(0, workflowIndex - count + 1), Math.max(count, workflowIndex + 1))
        .flatMap(({ service, key }) => {
          const { marker, tone } = statusAppearance(service.status, pulse);
          return [
            [`${snapshot.selectedId === service.id ? ">" : " "}${key} ${service.name}`, "primary"],
            [`  ${marker} ${service.status}${service.workflowSource ? ` · ${service.workflowSource}` : ""}`, tone],
          ];
        });
      for (let i = 0; i < Math.min(budget, Math.max(visible.length, right.length)); i++) {
        const [left = "", leftTone = "muted"] = visible[i] ?? [];
        const [status = "", tone = "muted"] = right[i] ?? [];
        const fitted = fitText(left, leftWidth);
        const gap = " ".repeat(leftWidth + 1 - fitted.cells);
        lines.push(`${color(leftTone)}${fitted.text}${gap}${color(tone)}${clip(status, rightWidth)}${esc}0m${esc}K`);
      }
    } else {
      for (const [text, tone, selected] of visible) line(text, tone, selected);
    }
    const logs = snapshot.logs;
    const logName = snapshot.workflowJobs?.find((job) => job.id === snapshot.selectedJob)?.name ?? selectedName;
    logHeight = Math.max(1, height - lines.length - 4 - footer.rows.length);
    const end = logEnd(logs);
    line(
      ` ─ ${logName ? `${logName} logs` : "Recent logs"} · ${end}/${logs.length}${anchor === undefined ? " · live" : " · scrolled"} ─`,
      "primary",
    );
    const visibleLogs = logs.slice(Math.max(0, end - logHeight), end);
    for (let i = 0; i < logHeight; i++) {
      const entry = visibleLogs[i];
      line(
        entry
          ? ` [${entry.source}] ${entry.message}`
          : i === 0
            ? ` Waiting for ${selectedName ?? "service"} output…`
            : "",
        entry && /\b(error|failed|fatal)\b/i.test(entry.message) ? "danger" : "muted",
      );
    }
    line(` ${snapshot.actionLabel || snapshot.workflowMessage || ""}`, "info");
    line(` ${"─".repeat(Math.max(0, width - 1))}`, "muted");
    const formatActions = (row: FooterAction[]) =>
      row.map(({ key, label, highlight }) => `${highlight ? "▶ " : ""}${key} ${label}`);
    for (const row of footer.rows) line(` ${formatActions(row).join(" · ")}`, "warning");
    const shortcuts = ` ${formatActions(footer.inline).join(" · ")}`;
    if (chip?.cells) {
      const available = width - chip.cells;
      const left = fitText(shortcuts, available - 1);
      const gap = " ".repeat(available - left.cells);
      lines.push(`${color("warning")}${left.text}${gap}${color(chip.tone)}${chip.text}${esc}0m${esc}K`);
    } else {
      line(shortcuts, "warning");
    }
    const frame = lines.slice(0, height).join("\r\n");
    if (frame !== previousFrame) {
      output.write(`${esc}H${frame}${esc}J`);
      previousFrame = frame;
    }
  };
  const keypress = (text: string, key: Key = {}) => {
    if (
      (key.name === "up" || key.name === "down" || key.name === "left" || key.name === "right") &&
      getSnapshot().workflowView
    ) {
      if (!key.ctrl && !key.meta) onKey(key.name);
      return;
    }
    const scroll = (
      { up: -1, down: 1, pageup: -logHeight, pagedown: logHeight, home: -Infinity, end: Infinity } as Record<
        string,
        number
      >
    )[key.name ?? ""];
    if (scroll !== undefined) {
      const logs = getSnapshot().logs;
      const end = Math.min(logs.length, Math.max(logHeight, logEnd(logs) + scroll));
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
      (value === "w" && getSnapshot().hasWorkflows) ||
      (["j", "k", "n", "p", "[", "]"].includes(value) && getSnapshot().workflowView) ||
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

/** @jsxImportSource @opentui/react */

import { spawn } from "node:child_process";
import process from "node:process";
import { createCliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cleanText, palette, type Snapshot, type StatusItem, statusAppearance } from "./ui.js";

// Rows rendered at the live tail; older ones load in chunks as the log panel reaches its top.
const logWindow = 300;

/** Index of the first entry whose id is at least `id`; entries are sorted by id. */
function firstAtOrAfter(logs: Snapshot["logs"], id: number) {
  let low = 0;
  let high = logs.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (logs[middle].id < id) low = middle + 1;
    else high = middle;
  }
  return low;
}

async function writeSystemClipboard(value: string): Promise<boolean> {
  const commands =
    process.platform === "darwin"
      ? [["pbcopy"]]
      : process.platform === "win32"
        ? [["cmd", "/c", "clip"]]
        : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
  for (const [command, ...args] of commands) {
    const copied = await new Promise<boolean>((resolve) => {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 2000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(value);
    });
    if (copied) return true;
  }
  return false;
}

export async function mountUI(
  getSnapshot: () => Snapshot,
  onKey: (key: string) => void,
  theme: Record<string, string> = {},
): Promise<() => void> {
  const colors: Record<string, string> = { ...palette, ...theme };
  let disposed = false;
  const LogLine = memo(({ entry, sourceColor }: { entry: Snapshot["logs"][number]; sourceColor: string }) => (
    <text id={`log-${entry.id}`} wrapMode="word">
      <span fg={sourceColor}>[{cleanText(entry.source).padEnd(10)}]</span>
      <span
        fg={
          /\b(error|failed|fatal)\b|exited with code [1-9]/i.test(entry.message)
            ? colors.danger
            : /\bwarn(ing)?\b/i.test(entry.message)
              ? colors.warning
              : colors.muted
        }
      >
        {` ${cleanText(entry.message)}`}
      </span>
    </text>
  ));
  const Dashboard = () => {
    const [snapshot, setSnapshot] = useState(getSnapshot);
    const renderer = useRenderer();
    const { width, height } = useTerminalDimensions();
    const compact = width < 68;
    const small = height < 20;
    const logs = snapshot.logs;
    const selectedName = cleanText(snapshot.services.find((service) => service.id === snapshot.selectedId)?.name ?? "");
    // Only a window of rows is rendered. While scrolled away from the tail, `startId` pins its first row so new
    // output can't shift the view; reaching the top loads the previous chunk.
    const [range, setRange] = useState<{ selectedId?: string; startId?: number }>({});
    const startId = range.selectedId === snapshot.selectedId ? range.startId : undefined;
    const start = startId === undefined ? Math.max(0, logs.length - logWindow) : firstAtOrAfter(logs, startId);
    const rendered = logs.slice(start);
    const view = useRef({ logs, start, pinned: false, selectedId: snapshot.selectedId });
    view.current = { logs, start, pinned: startId !== undefined, selectedId: snapshot.selectedId };
    const scrollbox = useRef<ScrollBoxRenderable | null>(null);
    // The first row before older rows were prepended; scrolling by its new offset keeps the view in place.
    const anchorRow = useRef<number | undefined>(undefined);
    const previous = useRef({ start, firstId: rendered[0]?.id, selectedId: snapshot.selectedId });
    useLayoutEffect(() => {
      const before = previous.current;
      if (before.selectedId === snapshot.selectedId && start < before.start && before.firstId !== undefined)
        anchorRow.current = before.firstId;
      previous.current = { start, firstId: rendered[0]?.id, selectedId: snapshot.selectedId };
    });
    const attachLogs = useCallback((box: ScrollBoxRenderable | null) => {
      scrollbox.current = box;
      if (!box) return;
      // Chain OpenTUI's own handler, which recalculates the scrollbars for the new content size.
      const resize = box.content.onSizeChange;
      box.content.onSizeChange = () => {
        resize?.call(box.content);
        if (anchorRow.current === undefined) return;
        const row = box.getRenderable(`log-${anchorRow.current}`);
        anchorRow.current = undefined;
        if (row) box.scrollTop += row.getLayoutNode().getComputedTop();
      };
    }, []);
    useEffect(() => {
      const timer = setInterval(() => {
        setSnapshot({ ...getSnapshot() });
        const box = scrollbox.current;
        if (!box) return;
        const { logs, start, pinned, selectedId } = view.current;
        const atTail = box.scrollTop + box.viewport.height >= box.scrollHeight - 1;
        if (box.scrollTop <= 0 && start > 0) setRange({ selectedId, startId: logs[Math.max(0, start - logWindow)].id });
        else if (!atTail && !pinned && logs[start]) setRange({ selectedId, startId: logs[start].id });
        else if (atTail && pinned && logs.length - start > logWindow) setRange({ selectedId });
      }, 100);
      return () => clearInterval(timer);
    }, []);
    const copySelection = async () => {
      const text = renderer.getSelection()?.getSelectedText();
      if (text && !(await writeSystemClipboard(text)) && !disposed) renderer.copyToClipboardOSC52(text);
    };
    useSelectionHandler((selection) => {
      if (!selection.isDragging && selection.getSelectedText()) void copySelection();
    });
    useKeyboard((key) => {
      if (key.name === "c" && ((key.ctrl && key.shift) || key.super)) {
        key.preventDefault();
        void copySelection();
        return;
      }
      if (key.ctrl && key.name === "c") {
        key.preventDefault();
        onKey("ctrl+c");
        return;
      }
      if (key.name === "escape") {
        key.preventDefault();
        onKey("escape");
        return;
      }
      if (key.ctrl || key.meta || key.super) return;
      const value = key.name === "escape" ? "escape" : key.sequence.length === 1 ? key.sequence : key.name;
      if (
        value === "escape" ||
        value === "q" ||
        value === "r" ||
        value === "c" ||
        /^[0-9]$/.test(value) ||
        getSnapshot().actions.some((action) => action.key === value)
      ) {
        key.preventDefault();
        onKey(value);
      }
    });
    const itemLine = (item: StatusItem, index: number) => (
      <text key={index} height={1} truncate fg={colors[item.tone ?? "info"] ?? item.tone ?? colors.info}>
        <span fg={colors.muted}>{cleanText(item.label)}: </span>
        {cleanText(item.value)}
      </text>
    );
    const statusRows = snapshot.services.reduce(
      (sum, service) => sum + 1 + (service.items?.length ?? 0),
      snapshot.items.length,
    );
    return (
      <box
        width="100%"
        height="100%"
        flexDirection="column"
        backgroundColor={colors.background}
        paddingX={1}
        paddingY={small ? 0 : 1}
        gap={small ? 0 : 1}
      >
        <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
          <text fg={colors.primary} flexGrow={1} minWidth={0} truncate>
            <strong>{cleanText(snapshot.title)}</strong>
            {snapshot.selectedId && <span> · Selected: {selectedName}</span>}
          </text>
          {!compact && (
            <text fg={colors.muted}>
              {width}×{height}
            </text>
          )}
        </box>
        <scrollbox
          title=" Services "
          titleColor={colors.primary}
          border
          borderStyle="rounded"
          borderColor={colors.border}
          backgroundColor={colors.panel}
          contentOptions={{ paddingX: 1 }}
          height={Math.min(statusRows + 2, Math.max(3, Math.floor(height / 3)))}
          flexShrink={0}
          scrollY
          scrollX={false}
        >
          {snapshot.services.map((service, index) => {
            const appearance = statusAppearance(service.status);
            return (
              <box key={service.id} flexDirection="column" flexShrink={0}>
                <box height={1} flexDirection="row">
                  <text width={4} fg={snapshot.selectedId === service.id ? colors.primary : colors.muted}>
                    {snapshot.selectedId === service.id ? ">" : ""}
                    {index + 1}.
                  </text>
                  <text width={3} fg={colors[appearance.tone]}>
                    {appearance.marker}
                  </text>
                  <text width={compact ? 14 : 18} fg={colors.foreground} truncate>
                    <strong>{cleanText(service.name)}</strong>
                  </text>
                  <text width={compact ? 11 : 13} fg={colors[appearance.tone]} truncate>
                    {cleanText(service.status)}
                  </text>
                  {!compact && (
                    <text flexGrow={1} fg={service.detail ? colors.warning : colors.info} truncate>
                      {cleanText(service.detail ?? service.url)}
                    </text>
                  )}
                </box>
                {!!service.items?.length && (
                  <box flexDirection="column" paddingLeft={7} flexShrink={0}>
                    {service.items.map(itemLine)}
                  </box>
                )}
              </box>
            );
          })}
          {snapshot.items.map(itemLine)}
        </scrollbox>
        <scrollbox
          key={snapshot.selectedId ?? "all"}
          ref={attachLogs}
          title={selectedName ? ` ${selectedName} logs · ${logs.length} ` : ` Recent logs · ${logs.length} `}
          titleColor={colors.primary}
          border
          borderStyle="rounded"
          borderColor={colors.border}
          backgroundColor={colors.panel}
          contentOptions={{ paddingX: 1 }}
          flexGrow={1}
          minHeight={small ? 1 : 4}
          scrollY
          scrollX={false}
          stickyScroll
          stickyStart="bottom"
          viewportCulling
          focused
        >
          {logs.length ? (
            rendered.map((entry) => (
              <LogLine
                key={entry.id}
                entry={entry}
                sourceColor={
                  colors[
                    ["primary", "warning", "info", "success"][
                      Math.max(
                        0,
                        snapshot.services.findIndex((service) => service.id === entry.source),
                      ) % 4
                    ]
                  ]
                }
              />
            ))
          ) : (
            <text fg={colors.muted}>Waiting for {selectedName || "service"} output…</text>
          )}
        </scrollbox>
        {snapshot.actionLabel && (
          <text height={1} flexShrink={0} truncate fg={colors.info}>
            {cleanText(snapshot.actionLabel)}
          </text>
        )}
        <box
          height={3}
          flexShrink={0}
          border
          borderStyle="rounded"
          borderColor={colors.border}
          backgroundColor={colors.panel}
          paddingX={1}
          alignItems="center"
        >
          <text truncate>
            {(snapshot.selectedId
              ? [...snapshot.actions, { key: "Esc", label: "back" }, { key: "1–9", label: "select" }]
              : [
                  { key: process.platform === "darwin" ? "Cmd+C" : "Ctrl+C", label: "quit" },
                  { key: "c", label: "clear" },
                  ...snapshot.actions,
                  ...(snapshot.services.length ? [{ key: "1–9", label: "select" }] : []),
                  { key: "↑↓", label: "logs" },
                  { key: "drag", label: "copy" },
                ]
            ).map((action, index) => {
              const highlight = "highlight" in action && action.highlight;
              return (
                <span key={action.key}>
                  {index > 0 && <span fg={colors.muted}> · </span>}
                  <strong
                    fg={highlight ? colors.background : colors.warning}
                    bg={highlight ? colors.warning : undefined}
                  >
                    {highlight ? ` ${cleanText(action.key)} ` : cleanText(action.key)}
                  </strong>
                  <span fg={highlight ? colors.warning : colors.foreground}> {cleanText(action.label)}</span>
                </span>
              );
            })}
          </text>
        </box>
      </box>
    );
  };
  const renderer = await createCliRenderer({
    backgroundColor: colors.background,
    clearOnShutdown: true,
    exitOnCtrlC: false,
    maxFps: 30,
    targetFps: 20,
    useMouse: true,
  });
  const root = createRoot(renderer);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    process.off("exit", cleanup);
    try {
      root.unmount();
    } finally {
      renderer.destroy();
    }
  };
  try {
    process.once("exit", cleanup);
    root.render(<Dashboard />);
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}

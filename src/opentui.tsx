/** @jsxImportSource @opentui/react */

import { spawn } from "node:child_process";
import process from "node:process";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { cleanText, palette, type Snapshot, type StatusItem, statusAppearance } from "./ui.js";

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
  const Dashboard = () => {
    const [snapshot, setSnapshot] = useState(getSnapshot);
    const renderer = useRenderer();
    const { width, height } = useTerminalDimensions();
    const compact = width < 68;
    const small = height < 20;
    const logs = snapshot.logs.slice(-500);
    useEffect(() => {
      const timer = setInterval(() => setSnapshot({ ...getSnapshot() }), 100);
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
            {snapshot.selectedId && (
              <span>
                {" "}
                · Selected:{" "}
                {cleanText(snapshot.services.find((service) => service.id === snapshot.selectedId)?.name ?? "")}
              </span>
            )}
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
                    <text flexGrow={1} fg={colors.info} truncate>
                      {cleanText(service.url)}
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
          title={` Recent logs · ${logs.length}/500 `}
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
            logs.map((entry) => (
              <text key={entry.id} wrapMode="word">
                <span
                  fg={
                    colors[
                      ["primary", "warning", "info", "success"][
                        Math.max(
                          0,
                          snapshot.services.findIndex((service) => service.id === entry.source),
                        ) % 4
                      ]
                    ]
                  }
                >
                  [{cleanText(entry.source).padEnd(10)}]
                </span>
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
            ))
          ) : (
            <text fg={colors.muted}>Waiting for service output…</text>
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
            ).map((action, index) => (
              <span key={action.key}>
                {index > 0 && <span fg={colors.muted}> · </span>}
                <strong fg={colors.warning}>{cleanText(action.key)}</strong>
                <span fg={colors.foreground}> {cleanText(action.label)}</span>
              </span>
            ))}
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

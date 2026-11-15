/** @jsxImportSource @opentui/react */

import { spawn } from "node:child_process";
import process from "node:process";
import { createCliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/react";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  cleanText,
  footerActions,
  palette,
  runningPulse,
  type Snapshot,
  type StatusItem,
  statusAppearance,
  workflowChip,
} from "./ui.js";
import { graphJobHeight, graphJobWidth, layoutWorkflowGraph } from "./workflow-graph.js";

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
    const compactFooter = small && snapshot.hasWorkflows;
    const footerWidth = Math.max(0, width - (compactFooter ? 4 : 6));
    const pulse = runningPulse();
    const chip = workflowChip(snapshot, footerWidth, pulse);
    const footer = footerActions(snapshot, footerWidth, chip?.cells ?? 0);
    const footerHeight = (compactFooter ? 1 : 3) + footer.rows.length;
    const statusMessage = snapshot.actionLabel || snapshot.workflowMessage;
    const statusRows = Number(Boolean(statusMessage));
    const rootPaddingY = small ? 0 : 1;
    const panelGap = small ? 0 : 1;
    const renderFooterActions = (actions: ReturnType<typeof footerActions>["inline"]) =>
      actions.map(({ key, label, input, highlight }, index) => (
        <Fragment key={key}>
          {index > 0 && (
            <text flexShrink={0} fg={colors.muted}>
              {" "}
              ·{" "}
            </text>
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: actions have terminal keyboard shortcuts. */}
          <text
            height={1}
            minWidth={0}
            maxWidth={footerWidth}
            truncate
            wrapMode="none"
            fg={highlight ? colors.warning : colors.foreground}
            onMouseUp={(event) => {
              if (input && event.button === 0) onKey(input);
            }}
          >
            <strong fg={highlight ? colors.background : colors.warning} bg={highlight ? colors.warning : undefined}>
              {highlight ? ` ${cleanText(key)} ` : cleanText(key)}
            </strong>
            {` ${cleanText(label)}`}
          </text>
        </Fragment>
      ));
    const logs = snapshot.logs;
    const logSelection =
      [snapshot.selectedId, snapshot.workflowRunId, snapshot.selectedJob].filter(Boolean).join("/") || undefined;
    const selectedName = cleanText(snapshot.services.find((service) => service.id === snapshot.selectedId)?.name ?? "");
    // Only a window of rows is rendered. While scrolled away from the tail, `startId` pins its first row so new
    // output can't shift the view; reaching the top loads the previous chunk.
    const [range, setRange] = useState<{ selectedId?: string; startId?: number }>({});
    const startId = range.selectedId === logSelection ? range.startId : undefined;
    const start = startId === undefined ? Math.max(0, logs.length - logWindow) : firstAtOrAfter(logs, startId);
    const rendered = logs.slice(start);
    const view = useRef({ logs, start, pinned: false, selectedId: logSelection });
    view.current = { logs, start, pinned: startId !== undefined, selectedId: logSelection };
    const scrollbox = useRef<ScrollBoxRenderable | null>(null);
    const serviceBox = useRef<ScrollBoxRenderable | null>(null);
    const workflowBox = useRef<ScrollBoxRenderable | null>(null);
    const previousJob = useRef<string | undefined>(undefined);
    useLayoutEffect(() => {
      if (!snapshot.workflowView) return;
      if (snapshot.selectedJob) workflowBox.current?.scrollChildIntoView(`workflow-job-${snapshot.selectedJob}`);
      else if (previousJob.current) workflowBox.current?.scrollChildIntoView("workflow-all-jobs");
      previousJob.current = snapshot.selectedJob;
    }, [snapshot.selectedJob, snapshot.workflowView]);
    useLayoutEffect(() => {
      if (!snapshot.selectedId) {
        serviceBox.current?.scrollTo(0);
      } else if (snapshot.workflowView) {
        workflowBox.current?.scrollChildIntoView(`workflow-${snapshot.selectedId}`);
      } else {
        serviceBox.current?.scrollChildIntoView(`service-${snapshot.selectedId}`);
      }
    }, [snapshot.selectedId, snapshot.workflowView]);
    useLayoutEffect(() => {
      if (snapshot.workflowRunId) workflowBox.current?.scrollChildIntoView(`workflow-run-${snapshot.workflowRunId}`);
    }, [snapshot.workflowRunId]);
    // The first row before older rows were prepended; scrolling by its new offset keeps the view in place.
    const anchorRow = useRef<number | undefined>(undefined);
    const previous = useRef({ start, firstId: rendered[0]?.id, selectedId: logSelection });
    useLayoutEffect(() => {
      const before = previous.current;
      if (before.selectedId === logSelection && start < before.start && before.firstId !== undefined)
        anchorRow.current = before.firstId;
      previous.current = { start, firstId: rendered[0]?.id, selectedId: logSelection };
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
      const value = key.name === "j" || key.name === "k" || key.sequence.length !== 1 ? key.name : key.sequence;
      if (
        value === "escape" ||
        value === "q" ||
        (value === "w" && getSnapshot().hasWorkflows) ||
        (["j", "k", "n", "p", "up", "down", "left", "right", "[", "]"].includes(value) && getSnapshot().workflowView) ||
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
    const entries = snapshot.services
      .map((service, index) => ({
        service,
        key: service.shortcut ?? String(index + 1),
      }))
      .filter(({ service }) => Boolean(service.workflow) === Boolean(snapshot.workflowView));
    const commands = entries.filter(({ service }) => !service.workflow);
    const workflows = entries.filter(({ service }) => service.workflow);
    const jobRows = snapshot.workflowJobs ?? [];
    const logName = jobRows.find((job) => job.id === snapshot.selectedJob)?.name ?? selectedName;
    const graph = useMemo(() => layoutWorkflowGraph(snapshot.workflowJobs ?? []), [snapshot.workflowJobs]);
    const runs = snapshot.workflowRuns ?? [];
    const runIndex = runs.findIndex((run) => run.id === snapshot.workflowRunId);
    const firstRun = Math.max(0, Math.min(runIndex - 2, runs.length - 5));
    const visibleRuns = runs.slice(firstRun, firstRun + 5);
    const commandRows = commands.reduce(
      (sum, { service }) => sum + 1 + (service.items?.length ?? 0),
      snapshot.workflowView ? 0 : snapshot.items.length,
    );
    const statusHeight = Math.min(
      Math.max(commandRows, workflows.length * 2, jobRows.length) + 2,
      Math.max(
        3,
        Math.min(
          Math.max(Math.floor(height / 3), commands.length + 2, workflows.length * 2 + 2),
          height - (small ? 5 : 12) - Number(Boolean(snapshot.actionLabel)),
        ),
      ),
    );
    const statusDetailsFit = commandRows + 2 <= statusHeight;
    const workflowWidth = Math.min(36, Math.max(16, Math.floor(width * 0.29)));
    // Leave room for terminal padding, the sidebar gap, and the graph's border and padding.
    const graphViewportWidth = width - workflowWidth - 7;
    const graphHeight = graph.height + 2 + Number(graph.width > graphViewportWidth);
    const logsMinHeight = small ? (snapshot.workflowView ? 3 : 1) : 4;
    const workflowHeight = height - rootPaddingY * 2 - 1 - footerHeight - statusRows - panelGap * (2 + statusRows);
    const availableGraphHeight = Math.max(0, workflowHeight - panelGap - logsMinHeight);
    const logsPanel = (
      <scrollbox
        key={logSelection ?? "all"}
        ref={attachLogs}
        title={` ${logName || "Recent"} logs · ${logs.length} `}
        titleColor={colors.primary}
        border
        borderStyle="rounded"
        borderColor={colors.border}
        backgroundColor={colors.panel}
        contentOptions={{ paddingX: 1 }}
        flexGrow={1}
        minHeight={logsMinHeight}
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
          <text fg={colors.muted}>Waiting for {logName || "service"} output…</text>
        )}
      </scrollbox>
    );
    return (
      <box
        width="100%"
        height="100%"
        flexDirection="column"
        backgroundColor={colors.background}
        paddingX={1}
        paddingY={rootPaddingY}
        gap={panelGap}
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
        {snapshot.workflowView ? (
          <box flexGrow={1} minHeight={0} flexDirection="row" gap={1}>
            <scrollbox
              ref={workflowBox}
              title=" Workflows · ↑↓ "
              titleColor={colors.primary}
              border
              borderStyle="rounded"
              borderColor={colors.border}
              backgroundColor={colors.panel}
              contentOptions={{ paddingX: 1 }}
              width={workflowWidth}
              flexShrink={0}
              scrollY
              scrollX={false}
            >
              {workflows.map(({ service, key }) => (
                // biome-ignore lint/a11y/noStaticElementInteractions: terminal row also has a numbered keyboard shortcut.
                <text
                  key={service.id}
                  id={`workflow-${service.id}`}
                  height={1}
                  truncate
                  fg={colors[statusAppearance(service.status).tone]}
                  bg={snapshot.selectedId === service.id ? colors.border : undefined}
                  onMouseUp={(event) => {
                    if (event.button === 0) onKey(`workflow:${service.id}`);
                  }}
                >
                  {key} {service.status === "running" ? `${statusAppearance(service.status, pulse).marker} ` : ""}
                  {cleanText(service.name)}
                  {service.workflowSource ? ` · ${service.workflowSource}` : ""}
                </text>
              ))}
              {Boolean(snapshot.workflowRuns?.length) && (
                <text height={1} truncate fg={colors.info}>
                  Runs · ←→
                </text>
              )}
              {visibleRuns.map(({ id, label, status }) => (
                // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys also select this terminal row.
                <text
                  key={id}
                  id={`workflow-run-${id}`}
                  height={1}
                  truncate
                  fg={colors[statusAppearance(status).tone]}
                  bg={snapshot.workflowRunId === id ? colors.border : undefined}
                  onMouseUp={(event) => {
                    if (event.button === 0) onKey(`run:${id}`);
                  }}
                >
                  {statusAppearance(status, pulse).marker} {cleanText(label)}
                </text>
              ))}
              <text height={1} truncate fg={colors.info}>
                Jobs
              </text>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: j/k selects this terminal row. */}
              <text
                height={1}
                truncate
                id="workflow-all-jobs"
                fg={snapshot.selectedJob ? colors.muted : colors.primary}
                bg={snapshot.selectedJob ? undefined : colors.border}
                onMouseUp={(event) => {
                  if (event.button === 0) onKey("job:");
                }}
              >
                All jobs
              </text>
              {jobRows.map((job) => {
                const { marker, tone } = statusAppearance(job.state, pulse);
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: j/k selects terminal job rows.
                  <text
                    key={job.id}
                    id={`workflow-job-${job.id}`}
                    height={1}
                    truncate
                    fg={colors[tone]}
                    bg={snapshot.selectedJob === job.id ? colors.border : undefined}
                    onMouseUp={(event) => {
                      if (event.button === 0) onKey(`job:${job.id}`);
                    }}
                  >
                    {marker} {cleanText(job.name)}
                  </text>
                );
              })}
            </scrollbox>
            <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column" gap={panelGap}>
              <scrollbox
                title={
                  snapshot.workflowRunOptions
                    ? ` Run graph · ${cleanText(snapshot.workflowRunOptions)} `
                    : " Run graph "
                }
                titleColor={colors.primary}
                border
                borderStyle="rounded"
                borderColor={colors.border}
                backgroundColor={colors.panel}
                height={Math.min(graphHeight, availableGraphHeight)}
                flexShrink={0}
                contentOptions={{ paddingX: 1 }}
                scrollY
                scrollX
              >
                {jobRows.length ? (
                  <box width={graph.width} height={graph.height} flexShrink={0}>
                    {graph.lines.map(({ x, y, text }) => (
                      <text key={y} position="absolute" left={x} top={y} height={1} fg={colors.muted}>
                        {text}
                      </text>
                    ))}
                    {graph.cards.map(({ job, x, y }) => {
                      const { marker, tone } = statusAppearance(job.state, pulse);
                      return (
                        // biome-ignore lint/a11y/noStaticElementInteractions: the terminal sidebar provides keyboard selection.
                        <box
                          key={job.id}
                          position="absolute"
                          left={x}
                          top={y}
                          width={graphJobWidth}
                          height={graphJobHeight}
                          paddingX={1}
                          flexDirection="column"
                          backgroundColor={snapshot.selectedJob === job.id ? colors.border : colors.background}
                          onMouseUp={(event) => {
                            if (event.button === 0) onKey(`job:${job.id}`);
                          }}
                        >
                          <text height={1} truncate fg={colors[tone]}>
                            {marker} {cleanText(job.name)}
                          </text>
                          <text height={1} truncate fg={colors.muted}>
                            {job.note ? `${job.state} · ${job.note}` : job.state}
                          </text>
                        </box>
                      );
                    })}
                  </box>
                ) : (
                  <text height={1} truncate>
                    {snapshot.workflowRunId ? "No jobs reported yet" : "Start a run to see its jobs"}
                  </text>
                )}
              </scrollbox>
              {logsPanel}
            </box>
          </box>
        ) : (
          <>
            <scrollbox
              ref={serviceBox}
              title=" Commands "
              titleColor={colors.primary}
              border
              borderStyle="rounded"
              borderColor={colors.border}
              backgroundColor={colors.panel}
              contentOptions={{ paddingX: 1 }}
              height={statusHeight}
              flexShrink={0}
              minWidth={0}
              scrollY
              scrollX={false}
            >
              {commands.map(({ service, key }) => {
                const appearance = statusAppearance(service.status, pulse);
                const selected = snapshot.selectedId === service.id;
                return (
                  <box key={service.id} id={`service-${service.id}`} flexDirection="column" flexShrink={0}>
                    <box height={1} flexDirection="row" backgroundColor={selected ? colors.border : undefined}>
                      <text width={4} fg={selected ? colors.primary : colors.muted}>
                        {key}.
                      </text>
                      <text width={3} fg={colors[appearance.tone]}>
                        {appearance.marker}
                      </text>
                      <text width={compact ? (workflows.length ? 9 : 18) : 18} fg={colors.foreground} truncate>
                        <strong>{cleanText(service.name)}</strong>
                      </text>
                      <text width={compact ? (workflows.length ? 8 : 11) : 13} fg={colors[appearance.tone]} truncate>
                        {cleanText(service.status)}
                      </text>
                      {!compact && (
                        <text flexGrow={1} fg={service.detail ? colors[appearance.tone] : colors.info} truncate>
                          {cleanText(service.detail ?? service.url)}
                        </text>
                      )}
                    </box>
                    {!!service.items?.length && (statusDetailsFit || snapshot.selectedId === service.id) && (
                      <box flexDirection="column" paddingLeft={7} flexShrink={0}>
                        {service.items.map(itemLine)}
                      </box>
                    )}
                  </box>
                );
              })}
              {!snapshot.workflowView && statusDetailsFit && snapshot.items.map(itemLine)}
            </scrollbox>
            {logsPanel}
          </>
        )}
        {statusMessage && (
          <text height={1} flexShrink={0} truncate fg={colors.info}>
            {cleanText(statusMessage)}
          </text>
        )}
        <box
          key={compactFooter ? "compact-footer" : "footer"}
          height={footerHeight}
          flexShrink={0}
          {...(compactFooter ? {} : { border: true, borderStyle: "rounded" as const, borderColor: colors.border })}
          backgroundColor={colors.panel}
          paddingX={1}
          flexDirection="column"
        >
          {footer.rows.map((row) => (
            <box key={row[0].key} height={1} flexShrink={0} flexDirection="row">
              {renderFooterActions(row)}
            </box>
          ))}
          <box height={1} flexShrink={0} flexDirection="row">
            {footer.inline.length > 0 && (
              <box height={1} width={footer.inlineWidth} flexShrink={0} flexDirection="row">
                {renderFooterActions(footer.inline)}
              </box>
            )}
            <box flexGrow={1} />
            {chip && chip.cells > 0 && (
              // biome-ignore lint/a11y/noStaticElementInteractions: w is the terminal keyboard equivalent.
              <text
                flexShrink={0}
                height={1}
                wrapMode="none"
                width={chip.cells + 1}
                fg={colors[chip.tone]}
                onMouseUp={(event) => {
                  if (event.button === 0) onKey("w");
                }}
              >
                {` ${chip.text}`}
              </text>
            )}
          </box>
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

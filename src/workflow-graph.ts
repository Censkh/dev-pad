import type { WorkflowJob } from "./ui.js";

export const graphJobHeight = 2;
export const graphJobWidth = 24;
const rowStride = graphJobHeight + 1;

const up = 1;
const right = 2;
const down = 4;
const left = 8;
const glyphs = [" ", "│", "─", "└", "│", "│", "┌", "├", "─", "┘", "─", "┴", "┐", "┤", "┬", "┼"];

export function layoutWorkflowGraph(jobs: WorkflowJob[]) {
  const depths = new Map<string, number>();
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const depth = (id: string, path = new Set<string>()): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const job = byId.get(id);
    if (!job || path.has(id)) return -1;
    const ancestors = new Set(path).add(id);
    const level = 1 + Math.max(-1, ...job.needs.map((need) => depth(need, ancestors)));
    depths.set(id, level);
    return level;
  };

  const counts: number[] = [];
  const nodes = jobs.map((job) => {
    const column = depth(job.id);
    const row = counts[column] ?? 0;
    counts[column] = row + 1;
    return { job, column, y: row * rowStride };
  });
  const positions = new Map(nodes.map((node) => [node.job.id, node]));
  const lanes = Array.from({ length: Math.max(0, counts.length - 1) }, () => new Map<string, number>());
  const lane = (gap: number, key: string) => {
    const tracks = lanes[gap];
    if (!tracks.has(key)) tracks.set(key, tracks.size);
    return (tracks.get(key) ?? 0) * 2 + 1;
  };
  const edges = nodes.flatMap((target) =>
    target.job.needs.flatMap((id) => {
      const source = positions.get(id);
      if (!source || source.column >= target.column) return [];
      const adjacent = target.column === source.column + 1;
      return [
        {
          source,
          target,
          exit: lane(source.column, source.job.id),
          entry: adjacent ? undefined : lane(target.column - 1, `${target.job.id}:in`),
        },
      ];
    }),
  );

  const columns = [0];
  for (const tracks of lanes)
    columns.push(columns[columns.length - 1] + graphJobWidth + Math.max(3, tracks.size * 2 + 2));
  const cards = nodes.map((node) => ({ job: node.job, x: columns[node.column], y: node.y }));
  const width = columns[columns.length - 1] + graphJobWidth;
  const cardHeight = Math.max(0, ...nodes.map(({ y }) => y + graphJobHeight));
  const rows = new Map<number, Map<number, number>>();
  const arrows = new Map<number, Set<number>>();
  const bypasses = new Map<string, number>();
  const mark = (x: number, y: number, bits: number) => {
    const row = rows.get(y) ?? new Map<number, number>();
    row.set(x, (row.get(x) ?? 0) | bits);
    rows.set(y, row);
  };
  const horizontal = (from: number, to: number, y: number) => {
    for (let x = from; x < to; x++) {
      mark(x, y, right);
      mark(x + 1, y, left);
    }
  };
  const vertical = (x: number, from: number, to: number) => {
    for (let y = Math.min(from, to); y < Math.max(from, to); y++) {
      mark(x, y, down);
      mark(x, y + 1, up);
    }
  };

  for (const { source, target, exit, entry } of edges) {
    const start = columns[source.column] + graphJobWidth;
    const end = columns[target.column] - 1;
    const exitX = start + exit;
    mark(start, source.y, left);
    horizontal(start, exitX, source.y);
    if (entry === undefined) {
      vertical(exitX, source.y, target.y);
      horizontal(exitX, end, target.y);
    } else {
      // A dependency that skips a column gets a clear path below the job cards.
      const bypassY = bypasses.get(source.job.id) ?? cardHeight + bypasses.size;
      bypasses.set(source.job.id, bypassY);
      const entryX = columns[target.column - 1] + graphJobWidth + entry;
      vertical(exitX, source.y, bypassY);
      horizontal(exitX, entryX, bypassY);
      vertical(entryX, bypassY, target.y);
      horizontal(entryX, end, target.y);
    }
    const rowArrows = arrows.get(target.y) ?? new Set<number>();
    rowArrows.add(end);
    arrows.set(target.y, rowArrows);
  }

  const lines = Array.from(rows, ([y, row]) => {
    const start = Math.min(...row.keys());
    const end = Math.max(...row.keys());
    const text = Array.from({ length: end - start + 1 }, (_, index) => {
      const x = start + index;
      return arrows.get(y)?.has(x) ? "▶" : glyphs[row.get(x) ?? 0];
    }).join("");
    return { x: start, y, text };
  });
  return { cards, lines, width, height: Math.max(1, cardHeight + bypasses.size) };
}

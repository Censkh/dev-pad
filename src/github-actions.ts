import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseDocument } from "yaml";

const exec = promisify(execFile);

export type GitHubWorkflow = { id: number; name: string; path: string };
export type GitHubRun = {
  databaseId: number;
  workflowDatabaseId: number;
  createdAt: string;
  startedAt: string;
  number: number;
  attempt: number;
  headBranch: string;
  headSha: string;
  status: string;
  conclusion: string;
  url: string;
};
type GitHubJob = {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  steps: { name: string; status: string }[];
};

type JobDefinition = { id: string; name: string; needs: string[] };

function workflowJobs(source: string): JobDefinition[] {
  const document = parseDocument(source);
  if (document.errors.length) return [];
  const workflow = document.toJS() as { jobs?: Record<string, { name?: unknown; needs?: unknown }> } | null;
  return Object.entries(workflow?.jobs ?? {}).flatMap(([id, job]) => {
    if (!job || typeof job !== "object") return [];
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    return [
      {
        id,
        name: typeof job.name === "string" ? job.name : id,
        needs: needs.filter((need): need is string => typeof need === "string"),
      },
    ];
  });
}

export function githubJobDependencies(jobs: GitHubJob[], definitions: JobDefinition[]) {
  const idsByDefinition = new Map<string, string[]>();
  const definitionByJob = new Map<string, JobDefinition>();
  for (const job of jobs) {
    const exact = definitions.filter(({ name }) => job.name === name);
    const matches = exact.length
      ? exact
      : definitions.filter(({ name }) => job.name.startsWith(`${name} (`) && job.name.endsWith(")"));
    if (matches.length !== 1) continue;
    const definition = matches[0];
    const id = String(job.databaseId);
    definitionByJob.set(id, definition);
    const ids = idsByDefinition.get(definition.id) ?? [];
    ids.push(id);
    idsByDefinition.set(definition.id, ids);
  }
  return new Map(
    Array.from(definitionByJob, ([id, definition]) => [
      id,
      definition.needs.flatMap((need) => idsByDefinition.get(need) ?? []),
    ]),
  );
}

export function githubStatus({ status, conclusion }: Pick<GitHubRun, "status" | "conclusion">) {
  if (status === "in_progress") return "running";
  if (status !== "completed") return "queued";
  if (conclusion === "success") return "passed";
  if (["neutral", "skipped", "cancelled"].includes(conclusion)) return conclusion;
  return "failed";
}

export async function githubActions(cwd: string) {
  const options = { cwd, timeout: 12_000 };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
  };
  const gh = async (args: string[]) =>
    (await exec("gh", args, { ...options, env, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const json = async <T>(args: string[]): Promise<T> => JSON.parse(await gh(args));
  const remotes = await exec("git", ["remote"], options).catch(() => undefined);
  if (!remotes?.stdout.trim() && !env.GH_REPO) return undefined;
  try {
    await gh(["--version"]);
  } catch {
    return undefined;
  }
  const runFields =
    "databaseId,workflowDatabaseId,createdAt,startedAt,number,attempt,headBranch,headSha,status,conclusion,url";
  const root =
    (await exec("git", ["rev-parse", "--show-toplevel"], options).catch(() => undefined))?.stdout.trim() || cwd;
  const definitions = new Map<string, Promise<JobDefinition[]>>();
  const definition = (path: string, ref: string): Promise<JobDefinition[]> => {
    if (!ref) return Promise.resolve([]);
    const key = `${ref}:${path}`;
    const cached = definitions.get(key);
    if (cached) return cached;
    const file = path.split("/").map(encodeURIComponent).join("/");
    const request = gh([
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github.raw+json",
      `repos/{owner}/{repo}/contents/${file}`,
      "-f",
      `ref=${ref}`,
    ])
      .then(workflowJobs)
      .catch(() => []);
    if (definitions.size >= 30) {
      const oldest = definitions.keys().next().value;
      if (oldest !== undefined) definitions.delete(oldest);
    }
    definitions.set(key, request);
    return request;
  };
  return {
    root,
    definition,
    workflows: () => json<GitHubWorkflow[]>(["workflow", "list", "--json", "id,name,path", "--limit", "100"]),
    runs: (workflow?: number) =>
      json<GitHubRun[]>([
        "run",
        "list",
        ...(workflow ? ["--workflow", String(workflow)] : []),
        "--json",
        runFields,
        "--limit",
        workflow ? "15" : "100",
      ]),
    jobs: async (run: GitHubRun) =>
      (
        await json<{ jobs: GitHubJob[] }>([
          "run",
          "view",
          String(run.databaseId),
          "--attempt",
          String(run.attempt),
          "--json",
          "jobs",
        ])
      ).jobs,
    logs: (run: GitHubRun, job?: string) =>
      gh([
        "run",
        "view",
        String(run.databaseId),
        "--attempt",
        String(run.attempt),
        "--log",
        ...(job ? ["--job", job] : []),
      ]),
    cancel: (run: GitHubRun) => gh(["run", "cancel", String(run.databaseId)]),
  };
}

export function githubError(error: unknown) {
  if (error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim())
    return error.stderr.trim();
  return error instanceof Error
    ? error.message.split("\n").slice(1).join("\n").trim() || error.name
    : "GitHub CLI failed";
}

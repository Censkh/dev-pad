import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  const runFields = "databaseId,workflowDatabaseId,createdAt,startedAt,number,attempt,headBranch,status,conclusion,url";
  const root =
    (await exec("git", ["rev-parse", "--show-toplevel"], options).catch(() => undefined))?.stdout.trim() || cwd;
  return {
    root,
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

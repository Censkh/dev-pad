// Job workspaces, pooled so runs of the same workflow and branch can go at once. A job combination
// uses workspaces/<key> when no other run holds it, else workspaces/<key>.2, <key>.3 and so on, the
// first nobody holds, created when every one is taken. The lease beside each (<name>.lease, see
// leases.ts) says who holds it, so two runs never share a workspace and pruning never removes one
// in use.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Lease, tryLease } from "./leases";

export const workspaceLeasePath = (workspace: string) => `${workspace}.lease`;

/** The pool member's directory name: the first is the key itself. */
export const poolMember = (key: string, index: number) => (index === 1 ? key : `${key}.${index}`);

export const isExtraPoolMember = (name: string) => /\.\d+$/.test(name);

export function leaseWorkspace(directory: string, key: string, owner: string): { path: string; lease: Lease } {
  for (let index = 1; ; index++) {
    const path = join(directory, poolMember(key, index));
    const lease = tryLease(workspaceLeasePath(path), owner);
    if (lease) {
      mkdirSync(path, { recursive: true });
      return { path, lease };
    }
  }
}

---
"dev-pad": minor
---

Runs of the same workflow and branch now go side by side instead of waiting for each other. Each job leases a workspace of its own: the usual one when it's free, otherwise `<job>.2`, `<job>.3` and so on, and the first free one is used first, so its dependencies stay warm. Exclusive groups and the ports `step.openPorts` gives hold across every runner on the machine, and the shared job slots keep the total within what the machine can take. A new run still stops an earlier one whose work it covers, and runs with `--deploy` still take turns. Pruning skips workspaces a run holds and removes the extra workspaces after a day idle.

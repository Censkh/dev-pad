---
"dev-pad": minor
---

Local workflow runs start whichever waiting job holds up the most work first: its own expected duration, the rest of its exclusive group still waiting, and the longest chain of jobs that wait for it. A short build that serial test shards depend on no longer waits behind longer independent jobs.

A processors module can export `preserve`, a list of untracked paths relative to the workspace (such as a Cargo `target` directory), which a job's checkout keeps between runs instead of cleaning. Paths inside submodules apply there. `--check` rejects anything but a plain relative path.

The dashboard lists partial local runs, such as one started with `--job` from the command line, under the entry for the whole workflow, labelled with the jobs they ran, unless another entry for the same workflow runs exactly those jobs.

Hosted runs show the dependencies between their jobs, read from the workflow file at the run's commit, including matrix combinations. The workflow graph draws dependency lines between job cards, and anything running has a pulsing marker in both renderers.

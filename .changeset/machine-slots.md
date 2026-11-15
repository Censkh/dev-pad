---
"dev-pad": minor
---

Runs using the same tool cache now share one set of job slots, so workflows run at the same time (another workflow, another branch, another checkout) take turns instead of each starting its own jobs on top of the others'. `DEVPAD_MACHINE_JOBS` sets the number, which defaults to the per-run default. A slot held by a runner that died is taken over. Each job's steps also get `DEVPAD_JOB_CPUS`, the job's share of the CPUs when every slot is busy, to size their own parallelism.

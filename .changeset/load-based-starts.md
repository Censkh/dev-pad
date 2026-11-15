---
"dev-pad": minor
---

Workflow runs start job combinations by the machine's load instead of a fixed number of job slots. A combination starts while the CPUs are under 75% busy and enough memory is free (4 GiB or 15% of the machine's memory, whichever is more). Starts across every runner sharing a tool cache are spaced 10 seconds apart, so the load the last one adds shows before the next is weighed. A run with nothing of its own running always starts its next combination, so outside load can slow it down but never stall it. `DEVPAD_MAX_CPU_BUSY`, `DEVPAD_MIN_FREE_MEMORY_GIB` and `DEVPAD_LOAD_SETTLE_SECONDS` tune the gate, and `--jobs` now only caps one run, with no cap by default. `DEVPAD_MACHINE_JOBS` is gone. `DEVPAD_JOB_CPUS` is the CPUs that were idle when the combination started, shared with its run's other combinations starting with it. A queued job's card says what it waits for: busy CPUs, low memory, or the last start's load settling.

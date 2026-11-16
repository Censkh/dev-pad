# Changelog

## 0.13.0

### Minor Changes

- 6dfd9f8: The workflow view shows when each run started and how long ago that was, such as `Local · 14:02 · 5m ago` (with the date for runs from an earlier day), and GitHub runs show their age. Job cards and job rows show how long each finished job took, from its first matrix combination's start to its last one's end, and how long a running job has run so far.

## 0.12.1

### Patch Changes

- Changes merged to master.

## 0.12.0

### Minor Changes

- a0bc048: Workflow runs start job combinations by the machine's load instead of a fixed number of job slots. A combination starts while the CPUs are under 75% busy and enough memory is free (4 GiB or 15% of the machine's memory, whichever is more). Starts across every runner sharing a tool cache are spaced 10 seconds apart, so the load the last one adds shows before the next is weighed. A run with nothing of its own running always starts its next combination, so outside load can slow it down but never stall it. `DEVPAD_MAX_CPU_BUSY`, `DEVPAD_MIN_FREE_MEMORY_GIB` and `DEVPAD_LOAD_SETTLE_SECONDS` tune the gate, and `--jobs` now only caps one run, with no cap by default. `DEVPAD_MACHINE_JOBS` is gone. `DEVPAD_JOB_CPUS` is the CPUs that were idle when the combination started, shared with its run's other combinations starting with it. A queued job's card says what it waits for: busy CPUs, low memory, or the last start's load settling.

## 0.11.0

### Minor Changes

- f1dbc56: A complete workflow run now deploys by default: it loads the workflow's secrets and runs the jobs that use them unless you pass `--dry-run`. A run limited with `--job`, `--skip`, `--matrix` or `--since` never deploys. `--deploy` is gone. The dashboard's **Run checks** (**r**) passes `--dry-run`, and **Deploy** (**d**) runs the whole workflow.

## 0.10.0

### Minor Changes

- 08be792: Runs of the same workflow and branch now go side by side instead of waiting for each other. Each job leases a workspace of its own: the usual one when it's free, otherwise `<job>.2`, `<job>.3` and so on, and the first free one is used first, so its dependencies stay warm. Exclusive groups and the ports `step.openPorts` gives hold across every runner on the machine, and the shared job slots keep the total within what the machine can take. A new run still stops an earlier one whose work it covers, and runs with `--deploy` still take turns. Pruning skips workspaces a run holds and removes the extra workspaces after a day idle.

## 0.9.0

### Minor Changes

- b9af36b: Runs using the same tool cache now share one set of job slots, so workflows run at the same time (another workflow, another branch, another checkout) take turns instead of each starting its own jobs on top of the others'. `DEVPAD_MACHINE_JOBS` sets the number, which defaults to the per-run default. A slot held by a runner that died is taken over. Each job's steps also get `DEVPAD_JOB_CPUS`, the job's share of the CPUs when every slot is busy, to size their own parallelism.

### Patch Changes

- 0ef68a3: The dashboard lists local runs that are waiting for another run to finish, as queued, with the run they wait for. A queued run can be cancelled from the dashboard.

## 0.8.0

### Minor Changes

- e440860: Processors can call `step.openPorts(count, from)` for ports nothing listens on, at or above `from`, to give the servers a step starts. Each combination's ports stay reserved until it ends, so matrix combinations and jobs running side by side never get the same ones.

## 0.7.1

### Patch Changes

- 62aefaf: Local runs started outside DevPad now appear on every workflow within a couple of seconds, not only on the selected workflow or one with a run already going: the dashboard checks each workflow's newest run directory and reads its runs again when a new one appears.

## 0.7.0

### Minor Changes

- 69444a2: Local workflow runs start whichever waiting job holds up the most work first: its own expected duration, the rest of its exclusive group still waiting, and the longest chain of jobs that wait for it. A short build that serial test shards depend on no longer waits behind longer independent jobs.
  
  A processors module can export `preserve`, a list of untracked paths relative to the workspace (such as a Cargo `target` directory), which a job's checkout keeps between runs instead of cleaning. Paths inside submodules apply there. `--check` rejects anything but a plain relative path.
  
  The dashboard lists partial local runs, such as one started with `--job` from the command line, under the entry for the whole workflow, labelled with the jobs they ran, unless another entry for the same workflow runs exactly those jobs.
  
  Hosted runs show the dependencies between their jobs, read from the workflow file at the run's commit, including matrix combinations. The workflow graph draws dependency lines between job cards, and anything running has a pulsing marker in both renderers.

## 0.6.0

### Minor Changes

- eecc563: While the dashboard runs, every log source is now also written to a plain-text file in `.dev-pad/logs` under the project directory: `<service-id>.log` for each service, `supervisor.log`, `all.log` with everything interleaved, and a file for each utility command source. Coding agents, scripts and other terminals can now read service output, for example with `tail -n 100 .dev-pad/logs/portal.log`. Each line has an ISO timestamp and its source, with terminal colours removed. A service's file starts again each time the service starts, and any file starts again when it reaches 2 MB or a new session begins. The earlier contents move to `<name>.previous.log`. `.dev-pad/logs/README.md` lists each service's status, URL, ports and log file, and says whether dev-pad is running. The directory has its own `.gitignore`.
  
  Set `logFiles: { dir, maxBytes }` on the config to change the directory or size limit, or `logFiles: false` to turn the files off. `dev-pad logs` prints the index, and `dev-pad logs <service> [--lines N] [--follow]` prints a source's latest lines. The dashboard's log panel is unchanged.
- e220eeb: Track finite launch commands separately from service processes and display mixed web/iOS/Android outcomes in the dashboard and log index.
- e220eeb: Register and run local GitHub workflows from the dashboard or CLI, with streamed step logs, cancellation, and retained artifacts.

## 0.5.0

### Minor Changes

- c48719e: **Breaking:** every service must now declare `ports`, the TCP ports it listens on, such as `ports: [6110, 6120]` for a service that starts two servers. Use `ports: false` for a service that listens on nothing, such as a file watcher. dev-pad refuses to start a config with a service that leaves `ports` out or gives an empty list, and names the service. `port` still works if it's also listed in `ports`, so one config can run with 0.4 and 0.5. Every declared port is now checked for a conflicting process at startup, not just the first.
  
  Select a service and press `k` to free its ports when something is still holding them, such as an orphaned dev server from an earlier session. dev-pad stops the service if it's running, then kills every process listening on its ports. If the listener's parent is a `wrangler` or `vite` dev process, that parent is stopped too, so it can't respawn the listener. Processes that are only connected to a port, dev-pad itself, Docker and other container runtimes, and SSH tunnels are left alone. The service's log shows each process killed, or that nothing was listening.
  
  Services that aren't running now show **busy** when another process holds one of their ports, with the port and the holder's PID and command (for example `busy · :6110 held by PID 123 (workerd)`). dev-pad checks every few seconds while the dashboard is open, so an orphan shows up before you press start, and the status clears once the port is free. A start refused because of a held port now shows **busy** instead of **failed**, and `k` leads the action bar. Once `k` frees the port, a service set to start automatically starts; otherwise press `r`.
  
  The `dev-pad/expo` helper always includes Metro's port in `ports`.
  
  `dev-pad --version` now prints the installed version instead of always printing 0.1.0.

## 0.4.0

### Minor Changes

- 07ab69b: Logs are kept per service instead of in one shared 500-line buffer, so selecting a quiet service still shows its history after a noisy one has printed a lot. Each source keeps its last 5,000 lines by default; set `logLimit` in the config to change it. Long histories stay responsive: the dashboard renders only the lines near the visible area and loads older ones as you scroll up, and `PgUp`/`PgDn`/`Home`/`End` now scroll the log panel in every runtime.

## 0.3.0

### Minor Changes

- 0559227: Add `dev-pad/expo`, an Expo service helper with iOS/Android launch actions and Android `adb reverse` port forwarding.
- 0559227: Selecting a service now filters the log panel to that service's output. Press the service's number again or `Esc` to return to all logs.
- 0559227: Add a per-service `tick(ctx)` hook for periodic work.

### Patch Changes

- 0559227: Build `dist` in `prepare`, so Git and workspace installs work without a separate build.

## 0.2.1

- Press a selected service’s number again to deselect it and return to the dashboard’s global actions.
- Resolve React from the host project so the dashboard and OpenTUI share one React instance.

## 0.2.0

- Show `Cmd+C` instead of `Ctrl+C` in macOS dashboard and CLI help labels.
- Set the process and terminal titles from the dashboard configuration.
- Fix repeated ANSI spinner frames being concatenated in logs, with regression coverage for split chunks and interleaved streams.

## 0.1.0

Initital release

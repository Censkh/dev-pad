---
"dev-pad": minor
---

While the dashboard runs, every log source is now also written to a plain-text file in `.dev-pad/logs` under the project directory: `<service-id>.log` for each service, `supervisor.log`, `all.log` with everything interleaved, and a file for each utility command source. Coding agents, scripts and other terminals can now read service output, for example with `tail -n 100 .dev-pad/logs/portal.log`. Each line has an ISO timestamp and its source, with terminal colours removed. A service's file starts again each time the service starts, and any file starts again when it reaches 2 MB or a new session begins. The earlier contents move to `<name>.previous.log`. `.dev-pad/logs/README.md` lists each service's status, URL, ports and log file, and says whether dev-pad is running. The directory has its own `.gitignore`.

Set `logFiles: { dir, maxBytes }` on the config to change the directory or size limit, or `logFiles: false` to turn the files off. `dev-pad logs` prints the index, and `dev-pad logs <service> [--lines N] [--follow]` prints a source's latest lines. The dashboard's log panel is unchanged.

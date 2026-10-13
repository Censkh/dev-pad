---
"dev-pad": minor
---

Logs are kept per service instead of in one shared 500-line buffer, so selecting a quiet service still shows its history after a noisy one has printed a lot. Each source keeps its last 5,000 lines by default; set `logLimit` in the config to change it. Long histories stay responsive: the dashboard renders only the lines near the visible area and loads older ones as you scroll up, and `PgUp`/`PgDn`/`Home`/`End` now scroll the log panel in every runtime.

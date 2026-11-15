---
"dev-pad": minor
---

A complete workflow run now deploys by default: it loads the workflow's secrets and runs the jobs that use them unless you pass `--dry-run`. A run limited with `--job`, `--skip`, `--matrix` or `--since` never deploys. `--deploy` is gone. The dashboard's **Run checks** (**r**) passes `--dry-run`, and **Deploy** (**d**) runs the whole workflow.

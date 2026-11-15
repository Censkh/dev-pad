---
"dev-pad": minor
---

Processors can call `step.openPorts(count, from)` for ports nothing listens on, at or above `from`, to give the servers a step starts. Each combination's ports stay reserved until it ends, so matrix combinations and jobs running side by side never get the same ones.

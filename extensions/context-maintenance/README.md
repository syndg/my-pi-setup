# Context Maintenance (retired user interface)

The `/context-maintain` command and pressure notifications are intentionally retired.

Routine pressure is handled by native percentage-based auto-compaction and overflow recovery. Users who deliberately want a fresh session can invoke `/handoff <exact next action>` directly. The historical policy/configuration modules remain available for tests and reference, but the extension registers no commands, lifecycle hooks, or automatic maintenance behavior.

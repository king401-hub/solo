# Changelog

## 0.1.0 — Unreleased (Phase 1 in progress)
- Monorepo scaffold (npm workspaces), git init.
- `@solo/shared`: wire protocol envelope, task/action types, permission policy, model routing/budget, memory types, tests.
- Docs: REQUIREMENTS, ARCHITECTURE, ROADMAP, DATABASE, API, SECURITY, TESTING.
- `@solo/desktop`: Electron + React + TS shell (context isolation, sandbox, CSP, all permission requests denied), design tokens, voice orb preview. Builds cleanly.
- `apps/android`: Flutter scaffold (default template; analyze + test pass). Note: `flutter` needs `--no-version-check` here (git tag fetch fails on this machine).

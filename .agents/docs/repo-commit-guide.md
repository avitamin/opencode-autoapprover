# Repo Commit Guide

Repository: `opencode-autoapprover` (OpenCode V2 plugin `opencode-llm-approval`).
Created 29.09.2026 by owner consent; repo had zero commits at creation, so most rules below are owner-selected defaults, not history-derived facts. Facts are marked `Fact:`, safe fallbacks `Conservative default:`.

## Source Priority

Conflict resolution order for commit tasks:

1. Explicit instruction of the owner in the current session.
2. This guide.
3. Repository product docs (`README.md`, `AGENTS.md`, `docs/`) — only for what a commit must not violate (e.g. no secrets, no runtime configs), not for message format.
4. The actual diff being committed (subject must describe what is really staged).

If `AGENTS.md` and this guide conflict on commit mechanics, this guide wins for git workflow; `AGENTS.md` wins for development constraints.

## Commit Message Format

Owner-selected default (confirmed 29.09.2026): Conventional Commits, English subjects.

```text
type(scope): subject
```

- `type`: `docs`, `feat`, `fix`, `test`, `refactor`, `build`, `chore`.
- `scope` (optional): area clear from changed files — e.g. `guard`, `audit`, `reviewer`, `host-smoke`, `kit` (documentation kit), `reports`.
- subject: lowercase imperative, no trailing period, ≤ 72 chars.
- Body (optional): short bullets in Russian or English for non-obvious changes.

Examples:

```text
docs(kit): add documentation kit and acceptance baseline
feat(guard): add threshold mapper with structural ceilings
fix(audit): inject fs deps in healthy() check
test(corpus): wire assessment fixtures to threshold matrix
chore: pin bun and typescript dev versions
```

## Issue Key Rules

Fact: no issue-key pattern exists anywhere in the repo (no Jira/AG references, no tracker integration, empty history).

Conservative default: do not add issue keys. Use one only if the owner explicitly provides it for the commit.

## Branch Policy

Fact: single branch `main`, remote `origin` = `github.com/avitamin/opencode-autoapprover.git`, no commit history yet.

Conservative default: direct commits to `main` are allowed for this repository (docs and code). Feature branches are optional for larger code changes; if used, name them `feat/<short-name>` or `fix/<short-name>` (no issue key required). Never rewrite published history on `main` without owner instruction.

## Staging Policy

- Stage explicit paths only; never `git add -A` / `git add .`.
- Fact: `.gitignore` already excludes `node_modules/`, `dist/`, `coverage/`, logs, `.env*`, `.audit/`, `.local/`, archives, and local runtime settings (`config.local.json`, `host-traces.local.jsonl`).
- Do not stage `.idea/` (IDE metadata).
- Do not mix unrelated changes in one commit; split docs / implementation / tooling commits.
- Never stage secrets, real guard configs of the owner machine, or traces captured on the host.

## Validation Policy

Fact: `package.json` defines `check` = typecheck + offline tests + build (no network, no keys).

- Commits touching `src/`, `tests/`, `scripts/`, `package.json`, `tsconfig*`: run `PATH="$HOME/.bun/bin:$PATH" bun run check` and require 0 failures before committing.
- Docs-only commits: no build validation required; keep `FILE_INDEX.md` count consistent when files are added/removed.
- Commits must not enable `mode:auto` in any example/runtime config.

## Missing Facts And Defaults

- No commit history exists yet: message format is an owner choice, not derived evidence. To change it, edit this file.
- No CI, hooks, or commit linting configured; nothing validates subjects automatically.
- Merge/PR policy unknown: default is direct commits to `main`; adjust when the owner defines a PR flow.
- Tagging/release policy unknown: no tags yet.

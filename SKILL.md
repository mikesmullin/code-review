---
name: code-review
description: Run the LLM-powered code-review CLI to enforce repo conventions against natural-language rules
---

# code-review

An LLM-powered code reviewer / "code cop". It searches recursively for all
`.code-review.yaml` files in the current directory tree and judges code against
natural-language rules. Each rule is a tiny linter backed by an LLM: it gathers
the files matching the rule's globs, sends each file to the model, and returns a
structured verdict (`pass`, `confidence`, `rationale`). One LLM call is made per
file; calls run in parallel with a live stderr progress bar.

- Project: `~/Workspace/me/agent/tmp/code-review/`
- Runtime: Bun + `agl-ai` (default model `copilot:claude-haiku-4.5`)

## When to use

- After making code changes, run `code-review` to get reminded of any repo
  conventions that were broken — instead of re-pasting long docs into the prompt.
- To review a PR: `code-review --pr <url>` clones the branch and runs rules against it.
- To onboard new (human or AI) coders to repo conventions.

## Running

```sh
code-review                       # RSpec-style report, searches cwd tree
code-review clean                 # clear the global review cache
code-review --yaml                # machine-readable YAML (parse this in scripts)
code-review --concurrency 6       # max simultaneous LLM calls (default 6)
code-review --model copilot:claude-haiku-4.5   # default model override
code-review path/to/dir           # run against another directory
code-review path/to/.code-review.yaml          # explicit config file

# PR review: auto-clone the branch into .<org>--<repo>-pr<N>/ then run rules
code-review --pr https://github.com/org/repo/pull/42
```

Exit code is non-zero when any `error`-severity rule fails (clean for CI / agent loops).

## Rule sources (loaded and merged at runtime)

| Source | Path | Filtered by `repos:`? |
|--------|------|-----------------------|
| **Local** | `.code-review.yaml` found recursively in scanned dir | No |
| **Global** | `~/.code-review.yaml` | Yes |
| **Library** | `library/**/*.yaml` inside the `code-review` package | Yes |

Rules with a `repos:` list are only applied when the target repo's
`git remote get-url origin` matches one of the listed HTTPS URLs.
Rules without `repos:` apply to every repo.

## Authoring `.code-review.yaml`

A bare top-level YAML array of rules:

```yaml
- id: no-stray-console-logs           # optional, defaults to rule-<n>
  description: Disallow debug logging in shipped source.   # optional
  repos:                              # optional: limit to specific repos
    - https://github.com/org/repo
  matches:                            # required: glob-star path list
    - "src/**/*.ts"
  exclude:                            # optional globs subtracted from matches
    - "src/**/*.test.ts"
  model: copilot:claude-haiku-4.5     # optional, defaults to --model / haiku
  severity: error                     # optional: error (default) | warn
  prompt: |                           # required: criteria for the model
    This file is production source. Return pass=false if it contains
    console.log/console.debug calls that should not ship.
```

Each matched file is supplied to the model wrapped in `<file path="...">…</file>`.

| Field         | Required | Description                                                            |
|---------------|----------|------------------------------------------------------------------------|
| `id`          | no       | Stable, unique rule identifier. Defaults to `rule-<n>`.                |
| `description` | no       | Human-readable summary.                                                |
| `repos`       | no       | HTTPS remote URLs this rule applies to (global/library rules only).    |
| `matches`     | yes      | One or more glob patterns of files to review.                          |
| `exclude`     | no       | Glob patterns subtracted from `matches`.                               |
| `model`       | no       | `provider:model`. Defaults to `--model` or `copilot:claude-haiku-4.5`. |
| `severity`    | no       | `error` (fails the run) or `warn` (reported, exit 0).                  |
| `prompt`      | yes      | Natural-language criteria.                                             |

## Caching

LLM results are cached globally in `~/.code-review/cache.yaml` (shared across
all repos on the machine), keyed by `(base_dir, rule, file)`. Entries expire when
the file changes or the rule's prompt/model changes. A per-project human-readable
report is also written to `.code-review/report.yaml`.

To force a full re-evaluation:
```sh
code-review clean
```

Override the cache location (e.g. in tests):
```sh
CODE_REVIEW_CACHE=/tmp/my-cache code-review
```

## Install / dev

```sh
cd ~/Workspace/me/agl && bun link            # one-time: register agl-ai
cd ~/Workspace/me/agent/tmp/code-review
bun link agl-ai && bun install && bun link   # exposes global `code-review`

bun test/unit.mjs     # pure logic tests (no LLM)
bun test/smoke.mjs    # full CLI against test/fixtures (live LLM, needs Copilot auth)
```

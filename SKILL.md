---
name: code-review
description: Run the LLM-powered code-review CLI to enforce repo conventions against natural-language rules
---

# code-review

An LLM-powered code reviewer / "code cop". It reads a `.code-review.yaml` from the
current directory (or the nearest ancestor) and judges code against
natural-language rules. Each rule is a tiny linter backed by an LLM: it gathers
the files matching the rule's globs, sends each file to the model, and returns a
structured verdict (`pass`, `confidence`, `rationale`). One LLM call is made per
file; calls run in parallel.

- Project: `~/Workspace/me/agent/tmp/code-review/`
- Runtime: Bun + `agl-ai` (default model `copilot:claude-haiku-4.5`)

## When to use

- After making code changes, run `code-review` to get reminded of any repo
  conventions that were broken — instead of re-pasting long docs into the prompt.
- To onboard new (human or AI) coders to repo conventions.

## Running

```sh
code-review                       # RSpec-style report for the current dir
code-review --yaml                # machine-readable YAML (parse this in scripts)
code-review --concurrency 6       # max simultaneous LLM calls (default 6)
code-review --model copilot:claude-haiku-4.5   # default model override
code-review path/to/dir           # run against another directory
code-review path/to/.code-review.yaml          # explicit config file
```

Exit code is non-zero when any `error`-severity rule fails (clean for CI / agent loops).

## Authoring `.code-review.yaml`

A bare top-level YAML array of rules:

```yaml
- id: no-stray-console-logs           # optional, defaults to rule-<n>
  description: Disallow debug logging in shipped source.   # optional
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
| `matches`     | yes      | One or more glob patterns of files to review.                          |
| `exclude`     | no       | Glob patterns subtracted from `matches`.                               |
| `model`       | no       | `provider:model`. Defaults to `--model` or `copilot:claude-haiku-4.5`. |
| `severity`    | no       | `error` (fails the run) or `warn` (reported, exit 0).                  |
| `prompt`      | yes      | Natural-language criteria.                                             |

## Install / dev

```sh
cd ~/Workspace/me/agl && bun link            # one-time: register agl-ai
cd ~/Workspace/me/agent/tmp/code-review
bun link agl-ai && bun install && bun link   # exposes global `code-review`

bun test/unit.mjs     # pure logic tests (no LLM)
bun test/smoke.mjs    # full CLI against test/fixtures (live LLM, needs Copilot auth)
```

# 👮 Code Review

**Your conventions, enforced by an LLM — not a regex.** Code Review is a tiny CLI
that judges your code against rules written in plain English. You describe what
"good" looks like ("handlers must validate input at the boundary", "microagents
must keep their system prompt minimal"), and an LLM reads each matching file and
returns a verdict: pass or fail, a confidence score, and a one-paragraph rationale. 
Feed this back into your PR reviews to create a virtuous cycle of enforced behavior.

In the past, traditional linters and code-smell detectors (ESLint, SonarQube, and friends) 
could only catch what someone could express as an AST pattern or a metric threshold. The
conventions that actually matter on a team — architectural boundaries, naming
intent, "don't duplicate this in the prompt", "keep this function pure" — are
*subjective*, and historically the only way to enforce them was a long `docs/*.md`
file plus a human reviewer who remembers to look. Code Review puts those judgment
calls where LLMs genuinely excel, so the rule lives in version control and runs on
every change. One LLM per rule, evaluated in parallel, with results cached so
unchanged files cost nothing. Drop it into CI or an agent loop and enjoy not having to 
constantly remind your about coding conventions you decided long ago.

**Why use it**

- **Usable by humans *and* AI coders.** Point an agent at it after every change
  and it gets automatically reminded of any convention it broke — no more
  re-pasting the same guidance into prompts as the context window compacts.
- **Onboard new contributors.** A rule set doubles as a guided tour of your repo's
  conventions, without making someone read a wall of docs first.
- **A better home for your `docs/*.md`.** Long convention docs eventually shrink to
  quick-reference tables nobody re-reads; here the rules of logic *exist* and are
  actively enforced on every file they apply to.
- **Rules don't have to share a context window.** Each rule is its own LLM
  evaluation, so your full body of conventions can grow without limit (they could
  never all fit in one prompt).
- **Reaches where compilers can't.** Static contracts catch what's deterministic;
  this enters the space where judgment is required and an LLM has the advantage —
  enforcing the *shape* of code, not just its syntax.

## Install

For a quick try without installing:

```sh
npx code-review
```

For contributors / a global `code-review` command:

```sh
git clone <repo-url> code-review
bun install
bun link
```

## Usage

Run it from any directory. It searches recursively for all `.code-review.yaml`
files in the subtree and evaluates each one:

```sh
code-review
```

That prints a human-readable RSpec-style report to stdout (with a live progress
bar on stderr) and exits non-zero if any `error`-severity rule fails.

### Reviewing a Pull Request

Pass `--pr <url>` to automatically fetch the PR branch, clone it locally as
`.<org>--<repo>-pr<N>/` in the current directory, then run all matching rules
against it:

```sh
code-review --pr https://github.com/org/repo/pull/42
```

Rules from `~/.code-review.yaml` and `library/` are applied automatically
(filtered by each rule's `repos:` list against the cloned repo's git remote).

## Rule Sources

Rules are loaded from three places and merged at runtime:

| Source | Path | Filtered by `repos:`? |
|--------|------|-----------------------|
| **Local** | `.code-review.yaml` / `.code-review.yml` in the scanned subtree | No |
| **Global** | `~/.code-review.yaml` | Yes |
| **Library** | `library/**/*.yaml` inside the `code-review` package | Yes |

The `repos:` field on a rule is a list of full HTTPS remote URLs. A rule is only
applied to a repo whose `git remote get-url origin` matches one of those URLs.
Rules with no `repos:` field apply everywhere.

### Library rules

Create `library/<org>/<repo>/my-rules.yaml` inside the `code-review` package to
ship reusable rule sets that activate automatically when `code-review` is run
against a matching repo:

```
library/
  example-org/
    example-repo/
      rules.yaml   ← only applied to that repo
```

## Rule Schema

A `.code-review.yaml` is a bare top-level YAML array of rules. Each rule is
evaluated once per matched file. A rule can give the model a `read_file` tool, so
a prompt can pull in a referenced conventions document. Here is a real rule that
checks a set of "microagents" against a conventions doc:

```yaml
- id: microagent-conventions
  description: Microagents must follow the conventions in MICROAGENT.md.
  matches:
    - "microagents/**/*.coffee"
  prompt: |
    Use the read_file tool to read the conventions document at:
      node_modules/agl-ai/docs/MICROAGENT.md
    (this path is relative to the project directory).

    The given file is a microagent (or a module of microagent helpers).
    Decide whether it adheres to the rules and qualities described in that
    document — in particular:
      - one microagent equals one decision (one Agent.factory + one run per wrapper);
      - minimal system prompt (decision intent / constraints / quality bar only);
      - field semantics and tool behavior live in the output schema and Tool
        definitions, NOT duplicated in the system prompt;
      - runtime inputs passed as explicit XML-style tags;
      - deterministic work (I/O, parsing, formatting) kept out of the model.

    Return pass=true only if the file genuinely adheres to these conventions.
    If it violates one or more, return pass=false and name the specific
    convention(s) broken in the rationale.
```

> **NOTE**: (**rule × file evaluation**) If 10 files match the glob pattern, the rule is evaluated 10 times (_once per file_). 

| Field         | Description                                                                                       |
|---------------|---------------------------------------------------------------------------------------------------|
| `matches`     | (required) One or more glob patterns of files to review.                                          |
| `prompt`      | (required) Natural-language criteria. The file is supplied wrapped in `<file path="…">…</file>`.  |
| `id`          | Stable, unique rule identifier. Defaults to `rule-<n>`.                                            |
| `description` | Human-readable summary.                                                                            |
| `exclude`     | Glob patterns subtracted from `matches`.                                                           |
| `model`       | `provider:model`. Defaults to `--model` or `copilot:claude-haiku-4.5`.                             |
| `severity`    | `error` (fails the run) or `warn` (reported, exit 0). Defaults to `error`.                         |

## Output

The default report groups failures, each with a confidence percentage, the rule,
the file, and how long that evaluation took:

```text
Failures:

  1) [FAIL] 85% microagent-conventions — microagents/00-summarize-task.coffee  11.00s
     The system prompt duplicates field semantics that should live exclusively in
     the output schema. The constraints (3–7 words, lowercase, no punctuation,
     telegraphic style) are described both in the prompt rules and in the schema
     description, violating the convention that "detailed field semantics into the
     output schema descriptions instead of bloating the prompt." Move all
     formatting constraints into the schema parameter description and reduce the
     system prompt to decision intent only.

  2) [FAIL] 95% microagent-conventions — microagents/01-triage-note.coffee  12.33s
     The file violates multiple microagent conventions. (1) The system prompt is
     excessively long (~40 lines) when it should be "usually a few sentences". (2)
     Field semantics are heavily duplicated between the prompt and the output_tool
     schema. (3) The prompt reads like a requirements document rather than focusing
     narrowly on decision intent, constraints, and quality bar.

16 files, 13 failures
Finished in 32.82s
```

> **NOTE**: (**Report caching**) LLM results are cached in `~/.code-review/cache.yaml` (shared across all repos on the machine). Each entry is keyed by `(base_dir, rule, file)` and expires when the file is modified or the rule's prompt changes. A per-project human-readable report is also written to `.code-review/report.yaml`. To force a full re-evaluation, run: `code-review clean`

Pass `--yaml` for a machine-readable report you can parse in scripts or CI:

```yaml
summary:
  total: 16
  passed: 3
  failures: 13
  warnings: 0
  errors: 0
  elapsed_ms: 32820
results:
  - rule: microagent-conventions
    file: microagents/00-summarize-task.coffee
    severity: error
    model: copilot:claude-haiku-4.5
    pass: false
    confidence: 0.85
    rationale: >-
      The system prompt duplicates field semantics that should live exclusively in
      the output schema. Move all formatting constraints into the schema parameter
      description and reduce the system prompt to decision intent only.
    error: null
    ms: 11002
  # …one entry per (rule × file)…
```

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
cd code-review
bun install
bun link            # exposes the global `code-review` executable
```

## Usage

Run it from any directory that contains a `.code-review.yaml`:

```sh
code-review
```

That prints a human-readable report and exits non-zero if any `error`-severity
rule fails (so it drops cleanly into CI or an agent loop). For machine-readable
output, alternate models, concurrency, explicit paths, and other options:

```sh
code-review --help
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

> **NOTE**: (**Report caching**) Outputs are stored in `.code-review/report.yaml`, to prevent needlessly burning time/tokens. To break the cache, simply modify your code, and any rules touching that file will have their report outputs updated on the next `code-review` run.

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

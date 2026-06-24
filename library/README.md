# Code Review Library

This directory is the collection of [`code-review`](https://github.com/mikesmullin/code-review) rule libraries for repos we regularly review.

Rules here are automatically applied by the `code-review` CLI whenever you run a review against a matching repo — no manual config needed. Each file is a standard `.code-review.yaml` rule list, with a `repos:` field that filters rules to the target repo's git remote URL.

## Structure

```
library/
  <org>/
    <repo>/
      <scope>.yaml    ← rules scoped to a subsystem or team within that repo
```

**Example:**
```
library/
  weather-org/
    weather-checker/
      firewall.yaml   ← firewall convention rules
```

## How rules are applied

When `code-review` runs, it loads all `library/**/*.yaml` files alongside `~/.code-review.yaml`. Each rule's `repos:` list is compared against the target repo's `git remote get-url origin`. Rules without a `repos:` field apply universally.

```yaml
- id: my-rule
  repos:
    - https://github.com/org/repo   # only applies to this repo
  matches:
    - "path/to/**/*.hcl"
  severity: error
  prompt: |
    Check that ...
```

## Adding new rules

1. Create a file at `library/<org>/<repo>/<scope>.yaml`
2. Add rules following the schema above
3. Commit and push — the CLI picks them up from the installed package automatically

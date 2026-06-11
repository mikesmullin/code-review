#!/usr/bin/env bun
import Agent from 'agl-ai';
import { join } from 'node:path';
import { findConfig, loadConfig } from './lib/config.mjs';
import { resolveFiles, readMatched } from './lib/files.mjs';
import { reviewFile, DEFAULT_MODEL } from './lib/review.mjs';
import { formatRspec, formatYaml, exitCode } from './lib/report.mjs';
import { loadCache, getCached, isFresh, writeCache } from './lib/cache.mjs';

const HELP = `code-review — LLM-powered code reviewer

Usage:
  code-review [options] [path]

Reads .code-review.yaml from the current directory (or the nearest ancestor,
or the given path) and evaluates each rule against its matched files. One LLM
call is made per file; calls run in parallel up to --concurrency.

Arguments:
  path                  Directory or config file to use (default: cwd).

Options:
  --yaml                Emit machine-readable YAML instead of the RSpec report.
  --concurrency <n>     Max simultaneous LLM calls (default: 6).
  --model <provider:m>  Default model for rules without an explicit model
                        (default: ${DEFAULT_MODEL}).
  -h, --help            Show this help.

Exit code is non-zero when any error-severity rule fails.`;

function parseArgs(argv) {
  const opts = { yaml: false, concurrency: 6, model: null, path: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--yaml':
        opts.yaml = true;
        break;
      case '--concurrency': {
        const n = Number(argv[++i]);
        if (!Number.isFinite(n) || n < 1) throw new Error('--concurrency must be a positive integer');
        opts.concurrency = Math.floor(n);
        break;
      }
      case '--model':
        opts.model = argv[++i];
        if (!opts.model) throw new Error('--model requires a value (e.g. copilot:claude-haiku-4.5)');
        break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
        if (opts.path) throw new Error(`Unexpected argument: ${a}`);
        opts.path = a;
    }
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (opts.help) {
    console.log(HELP);
    return;
  }

  // Resolve config: explicit file, explicit dir, or search from cwd.
  let configPath;
  if (opts.path) {
    const isFile = opts.path.endsWith('.yaml') || opts.path.endsWith('.yml');
    configPath = isFile ? opts.path : findConfig(opts.path);
  } else {
    configPath = findConfig(process.cwd());
  }

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  // Tune the global agl-ai concurrency gate.
  Agent.default.concurrency = opts.concurrency;

  // Load any cached results so unchanged (rule, file) pairs can be skipped.
  const cache = loadCache(config.baseDir);

  // Build the flat list of (rule, file) pairs, splitting into cached hits
  // (file unchanged since last evaluation, rule unchanged) and tasks to run.
  const cachedResults = [];
  const tasks = [];
  for (const rule of config.rules) {
    const matched = await resolveFiles(rule, config.baseDir);
    for (const relPath of matched) {
      const absPath = join(config.baseDir, relPath);
      const hit = getCached(cache, rule.id, relPath);
      if (isFresh(hit, rule, absPath)) {
        cachedResults.push({ ...hit, cached: true });
      } else {
        tasks.push({ rule, file: readMatched(relPath, config.baseDir) });
      }
    }
  }

  if (tasks.length === 0 && cachedResults.length === 0) {
    console.error('No files matched any rule. Check the "matches" globs in your .code-review.yaml.');
    process.exit(0);
  }

  const started = Date.now();
  // Fan out every task at once; the agl-ai concurrency gate throttles the
  // actual in-flight provider calls to opts.concurrency. Cached hits are not
  // re-evaluated.
  const freshResults = await Promise.all(
    tasks.map((t) => reviewFile(t.rule, t.file, { defaultModel: opts.model, baseDir: config.baseDir })),
  );
  const elapsedMs = Date.now() - started;

  // Merge cached + freshly-evaluated results; stdout shows the full report.
  const results = [...cachedResults, ...freshResults];

  // Stable ordering for deterministic output: by rule, then file.
  results.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file));

  // Persist the full report so the next run can skip unchanged pairs.
  writeCache(config.baseDir, results, { elapsedMs });

  const output = opts.yaml ? formatYaml(results, { elapsedMs }) : formatRspec(results, { elapsedMs });
  console.log(output);

  process.exit(exitCode(results));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});

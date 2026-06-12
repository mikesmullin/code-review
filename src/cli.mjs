#!/usr/bin/env bun
import Agent from 'agl-ai';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { findConfig, findAllConfigs, loadConfig, loadGlobalConfig, loadLibraryConfigs, GLOBAL_CONFIG } from './lib/config.mjs';

// Library rules live alongside the CLI source: <package-root>/library/
const LIBRARY_DIR = join(import.meta.dirname, '..', 'library');
import { resolveFiles, readMatched } from './lib/files.mjs';
import { reviewFile, DEFAULT_MODEL, Progress } from './lib/review.mjs';
import { formatRspec, formatYaml, formatHtml, exitCode } from './lib/report.mjs';
import { loadCache, getCached, isFresh, writeCache, clearGlobalCache, globalCachePath } from './lib/cache.mjs';

const HELP = `code-review — LLM-powered code reviewer

Usage:
  code-review clean
  code-review [options] [path]

Reads .code-review.yaml from the current directory tree (searches recursively
downward) and evaluates each rule against its matched files. One LLM call is made
per file; calls run in parallel up to --concurrency.

Arguments:
  path                  Directory or config file to use (default: cwd).

Options:
  --pr <url>            Fetch a PR branch from GitHub, clone it locally
                        as .<repo>-pr<N>/ in cwd, and run rules against it.
                        Applies rules from ~/.code-review.yaml (global config) and
                        any .code-review.yaml found in the cloned repo.
  --html <path>         Write a standalone HTML report to the given file.
  --yaml                Emit machine-readable YAML instead of the RSpec report.
  --concurrency <n>     Max simultaneous LLM calls (default: 6).
  --model <provider:m>  Default model for rules without an explicit model
                        (default: ${DEFAULT_MODEL}).
  -h, --help            Show this help.

Subcommands:
  clean                 Clear the global review cache at ${globalCachePath()}.

Exit code is non-zero when any error-severity rule fails.`;

function parseArgs(argv) {
  const opts = { yaml: false, html: null, concurrency: 6, model: null, path: null, pr: null, subcommand: null };
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
      case '--html':
        opts.html = argv[++i];
        if (!opts.html) throw new Error('--html requires a file path (e.g. report.html)');
        break;
      case '--pr':
        opts.pr = argv[++i];
        if (!opts.pr) throw new Error('--pr requires a PR URL (e.g. https://github.com/org/repo/pull/42)');
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
        if (a === 'clean') {
          if (opts.subcommand || opts.path || opts.pr) throw new Error('clean cannot be combined with other arguments');
          opts.subcommand = 'clean';
          break;
        }
        if (opts.subcommand) throw new Error(`Unexpected argument: ${a}`);
        if (opts.path) throw new Error(`Unexpected argument: ${a}`);
        opts.path = a;
    }
  }
  return opts;
}

// Parse a GitHub PR URL into { host, org, repo, prNum }.
// Supports: https://github.com/org/repo/pull/42
function parsePrUrl(url) {
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Cannot parse PR URL: ${url}\nExpected: https://<host>/<org>/<repo>/pull/<N>`);
  return { host: m[1], org: m[2], repo: m[3], prNum: Number(m[4]) };
}

// Fetch PR branch name via gh CLI and clone it locally.
// Returns the absolute path to the cloned directory.
function clonePr(prUrl, destDir) {
  const { host, org, repo, prNum } = parsePrUrl(prUrl);
  const ghEnv = { ...process.env, GH_HOST: host };

  // Resolve the branch name from the PR.
  const branchResult = spawnSync(
    'gh', ['pr', 'view', String(prNum), '--repo', `${org}/${repo}`, '--json', 'headRefName', '-q', '.headRefName'],
    { encoding: 'utf8', env: ghEnv },
  );
  if (branchResult.status !== 0) {
    throw new Error(`Failed to resolve PR #${prNum} branch: ${branchResult.stderr.trim()}`);
  }
  const branch = branchResult.stdout.trim();
  if (!branch) throw new Error(`gh returned an empty branch name for PR #${prNum}`);

  const cloneDir = join(destDir, `.${org}--${repo}-pr${prNum}`);
  const sshUrl = `git@${host}:${org}/${repo}.git`;

  process.stderr.write(`  Cloning ${org}/${repo}#${prNum} (branch: ${branch}) → ${cloneDir}\n`);

  // Try cloning the branch directly; fall back to fetching via the PR ref.
  let cloneResult = spawnSync(
    'git', ['clone', '--branch', branch, '--depth', '1', sshUrl, cloneDir],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (cloneResult.status !== 0) {
    process.stderr.write(`  Direct branch clone failed; fetching via PR ref refs/pull/${prNum}/head\n`);
    const initResult = spawnSync('git', ['init', cloneDir], { encoding: 'utf8', stdio: 'inherit' });
    if (initResult.status !== 0) throw new Error('git init failed');
    const fetchResult = spawnSync(
      'git', ['fetch', '--depth', '1', sshUrl, `refs/pull/${prNum}/head`],
      { encoding: 'utf8', stdio: 'inherit', cwd: cloneDir },
    );
    if (fetchResult.status !== 0) throw new Error(`git fetch PR ref failed (exit ${fetchResult.status})`);
    const checkoutResult = spawnSync('git', ['checkout', 'FETCH_HEAD'], { encoding: 'utf8', stdio: 'inherit', cwd: cloneDir });
    if (checkoutResult.status !== 0) throw new Error('git checkout FETCH_HEAD failed');
    // Set the remote so git remote get-url origin works for rule matching.
    spawnSync('git', ['remote', 'add', 'origin', sshUrl], { encoding: 'utf8', stdio: 'pipe', cwd: cloneDir });
  }
  return cloneDir;
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

  if (opts.subcommand === 'clean') {
    clearGlobalCache();
    console.log(`Cleared cache: ${globalCachePath()}`);
    return;
  }

  // --pr: clone the PR branch, then run rules from the global config + any
  // .code-review.yaml found inside the cloned repo.
  if (opts.pr) {
    let cloneDir;
    try {
      cloneDir = clonePr(opts.pr, resolve(opts.path || process.cwd()));
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    }
    // Treat the cloned dir as the path for subsequent config resolution.
    opts.path = cloneDir;
  }

  // Resolve config(s): explicit file, explicit dir, or recursive search from cwd.
  // When searching recursively, all .code-review.yaml files found in the subtree
  // are loaded; each uses its own directory as baseDir so globs resolve correctly.
  let configs;
  if (opts.path) {
    const isFile = opts.path.endsWith('.yaml') || opts.path.endsWith('.yml');
    // Search recursively inside an explicit directory (e.g. a cloned PR).
    const subConfigs = findAllConfigs(isFile ? dirname(opts.path) : opts.path);
    if (subConfigs.length === 0 && opts.pr) {
      // No local .code-review.yaml in the cloned repo — synthesize a bare config
      // so that global rules can still be applied to the directory.
      configs = [{ configPath: null, baseDir: resolve(opts.path), rules: [] }];
      process.stderr.write(`  No local .code-review.yaml found; applying global rules only\n`);
    } else if (subConfigs.length === 0) {
      // Explicit path with no config: fall back to ancestor search.
      const configPath = isFile ? opts.path : findConfig(opts.path);
      if (!configPath) { console.error(`No .code-review.yaml found in ${opts.path}.`); process.exit(2); }
      configs = [];
      try { configs.push(loadConfig(configPath)); } catch (err) { console.error(err.message); process.exit(2); }
    } else {
      configs = [];
      for (const p of subConfigs) {
        try { configs.push(loadConfig(p)); } catch (err) { console.error(err.message); process.exit(2); }
      }
    }
  } else {
    const configPaths = findAllConfigs(process.cwd());
    if (configPaths.length === 0) {
      console.error('No .code-review.yaml found in the current directory or any subdirectory.');
      process.exit(2);
    }
    configs = [];
    for (const p of configPaths) {
      try { configs.push(loadConfig(p)); } catch (err) { console.error(err.message); process.exit(2); }
    }
    if (configPaths.length > 1) {
      process.stderr.write(`  Found ${configPaths.length} config files\n`);
    }
  }

  // Collect all "ambient" rule sources: ~/.code-review.yaml + library/**/*.yaml.
  // Each source's rules are filtered by their `repos:` list against each target
  // repo's actual git remote URL.
  const ambientSources = [];
  const globalCfg = loadGlobalConfig();
  if (globalCfg) ambientSources.push(globalCfg);
  ambientSources.push(...loadLibraryConfigs(LIBRARY_DIR));

  if (ambientSources.length > 0) {
    for (const config of configs) {
      // Resolve the git remote URL for this repo.
      let remoteUrl = null;
      try {
        remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
          cwd: config.baseDir,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim()
          .replace(/\.git$/, '')
          .replace(/^git@([^:]+):(.+)$/, 'https://$1/$2');
      } catch { /* not a git repo or no remote */ }

      for (const source of ambientSources) {
        const applicableRules = source.rules.filter((r) => {
          if (r.repos.length === 0) return true; // no filter → applies everywhere
          if (!remoteUrl) return false;
          return r.repos.some((ref) => {
            const norm = ref.replace(/\.git$/, '');
            return remoteUrl === norm || remoteUrl.startsWith(norm + '/');
          });
        });
        if (applicableRules.length > 0) {
          const existingIds = new Set(config.rules.map((r) => r.id));
          for (const r of applicableRules) {
            if (!existingIds.has(r.id)) config.rules.push(r);
          }
        }
      }
    }
  }

  // Tune the global agl-ai concurrency gate.
  Agent.default.concurrency = opts.concurrency;

  // Build the flat list of (rule, file) pairs across all configs, splitting into
  // cached hits and tasks to run. Track which config each task belongs to.
  const cachedResults = [];
  const tasks = [];
  for (const config of configs) {
    const cache = loadCache(config.baseDir);
    for (const rule of config.rules) {
      const matched = await resolveFiles(rule, config.baseDir);
      for (const relPath of matched) {
        const absPath = join(config.baseDir, relPath);
        const hit = getCached(cache, rule.id, relPath);
        if (isFresh(hit, rule, absPath)) {
          cachedResults.push({ ...hit, cached: true, _baseDir: config.baseDir });
        } else {
          tasks.push({ rule, file: readMatched(relPath, config.baseDir), config });
        }
      }
    }
  }

  if (tasks.length === 0 && cachedResults.length === 0) {
    console.error('No files matched any rule. Check the "matches" globs in your .code-review.yaml.');
    process.exit(0);
  }

  // Emit a brief summary to stderr so the user knows what's about to run.
  if (tasks.length > 0) {
    process.stderr.write(`  Running ${tasks.length} LLM evaluation${tasks.length === 1 ? '' : 's'}`);
    if (cachedResults.length > 0) process.stderr.write(` (${cachedResults.length} cached)`);
    process.stderr.write('\n');
  }

  const started = Date.now();
  const progress = new Progress(tasks.length);

  // Fan out every task at once; the agl-ai concurrency gate throttles the
  // actual in-flight provider calls to opts.concurrency. Cached hits are not
  // re-evaluated.
  const freshResults = await Promise.all(
    tasks.map((t) =>
      reviewFile(t.rule, t.file, { defaultModel: opts.model, baseDir: t.config.baseDir }).then((r) => {
        progress.tick({ cached: false, pass: r.pass });
        return { ...r, _baseDir: t.config.baseDir };
      }),
    ),
  );
  if (tasks.length > 0) progress.finish();
  const elapsedMs = Date.now() - started;

  // Merge cached + freshly-evaluated results; stdout shows the full report.
  const results = [...cachedResults, ...freshResults];

  // Stable ordering for deterministic output: by rule, then file.
  results.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file));

  // Persist results per config baseDir (each config gets its own local report;
  // all entries are merged into the global ~/.code-review/cache.yaml).
  for (const config of configs) {
    const configResults = results.filter((r) => r._baseDir === config.baseDir);
    if (configResults.length > 0) writeCache(config.baseDir, configResults, { elapsedMs });
  }

  const output = opts.yaml ? formatYaml(results, { elapsedMs }) : formatRspec(results, { elapsedMs });
  if (opts.html) {
    writeFileSync(opts.html, formatHtml(results, { elapsedMs }));
  }
  console.log(output);

  process.exit(exitCode(results));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

// Global LLM result cache shared across all repos on this machine.
// Can be overridden via CODE_REVIEW_CACHE env var (used in tests).
function globalDir() {
  return process.env.CODE_REVIEW_CACHE
    ? join(process.env.CODE_REVIEW_CACHE)
    : join(homedir(), '.code-review');
}

export function globalCachePath() {
  return join(globalDir(), 'cache.yaml');
}

// Per-project human-readable report (summary + results for this run).
const LOCAL_DIR = '.code-review';
const LOCAL_REPORT = 'report.yaml';

function localReportPath(baseDir) {
  return join(baseDir, LOCAL_DIR, LOCAL_REPORT);
}

// Build a key for the in-memory Map (scoped to a single baseDir).
function key(ruleId, file) {
  return `${ruleId}\u0000${file}`;
}

// Fingerprint the parts of a rule that affect a per-file verdict. If the rule's
// prompt/model/severity changes, cached results for it are no longer valid even
// when the file is unchanged.
export function ruleFingerprint(rule) {
  return createHash('sha1')
    .update(`${rule.prompt}\u0000${rule.model || ''}\u0000${rule.severity}`)
    .digest('hex')
    .slice(0, 16);
}

// Load the cached results for a specific repo (baseDir) from the global cache.
// Returns an in-memory Map keyed by (ruleId, file) — same interface as before.
export function loadCache(baseDir) {
  const absBase = resolve(baseDir);
  const map = new Map();
  const cachePath = globalCachePath();
  if (!existsSync(cachePath)) return map;
  try {
    const doc = yaml.load(readFileSync(cachePath, 'utf8'));
    for (const r of doc?.entries ?? []) {
      if (r?.base_dir === absBase && r?.rule && r?.file) {
        map.set(key(r.rule, r.file), r);
      }
    }
  } catch {
    // Corrupt global cache is non-fatal: treat as empty.
  }
  return map;
}

// Decide whether a cached result can be reused for (rule, file). It is reusable
// when the cache holds a matching entry, the rule fingerprint is unchanged, and
// the file has not been modified since it was last evaluated.
export function isFresh(cached, rule, absFilePath) {
  if (!cached || cached.evaluated_at == null) return false;
  if (cached.fingerprint !== ruleFingerprint(rule)) return false;
  let mtimeMs;
  try {
    mtimeMs = statSync(absFilePath).mtimeMs;
  } catch {
    return false;
  }
  return mtimeMs <= cached.evaluated_at;
}

// Look up a cached result for a (rule, file) pair.
export function getCached(cache, ruleId, file) {
  return cache.get(key(ruleId, file));
}

// Persist results to:
//   ~/.code-review/cache.yaml     — global LLM result cache (merged across repos)
//   {baseDir}/.code-review/report.yaml — per-project human-readable report
export function writeCache(baseDir, results, { elapsedMs } = {}) {
  const absBase = resolve(baseDir);
  const cachePath = globalCachePath();

  // --- global cache: merge new entries for this repo, preserve all others ---
  let existing = [];
  if (existsSync(cachePath)) {
    try {
      const doc = yaml.load(readFileSync(cachePath, 'utf8'));
      existing = (doc?.entries ?? []).filter((r) => r?.base_dir !== absBase);
    } catch {
      // Corrupt global cache: start fresh.
    }
  }
  const newEntries = results.map((r) => ({
    base_dir: absBase,
    rule: r.rule,
    file: r.file,
    severity: r.severity,
    model: r.model,
    pass: r.pass,
    confidence: r.confidence,
    rationale: r.rationale,
    error: r.error,
    ms: r.ms,
    evaluated_at: r.evaluated_at ?? null,
    fingerprint: r.fingerprint ?? null,
  }));
  mkdirSync(globalDir(), { recursive: true });
  writeFileSync(cachePath, yaml.dump({ entries: [...existing, ...newEntries] }, { lineWidth: 100, noRefs: true }));

  // --- per-project report (human-readable summary for this run) ---
  const total = results.length;
  const errored = results.filter((r) => r.error).length;
  const fails = results.filter((r) => !r.pass && !r.error);
  const hardFails = fails.filter((r) => r.severity !== 'warn').length;
  const warnFails = fails.length - hardFails;

  const doc = {
    summary: {
      total,
      passed: results.filter((r) => r.pass).length,
      failures: hardFails,
      warnings: warnFails,
      errors: errored,
      elapsed_ms: elapsedMs ?? null,
      generated_at: Date.now(),
    },
    results: results.map((r) => ({
      rule: r.rule,
      file: r.file,
      severity: r.severity,
      model: r.model,
      pass: r.pass,
      confidence: r.confidence,
      rationale: r.rationale,
      error: r.error,
      ms: r.ms,
      evaluated_at: r.evaluated_at ?? null,
      fingerprint: r.fingerprint ?? null,
    })),
  };

  const reportDir = join(baseDir, LOCAL_DIR);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(localReportPath(baseDir), yaml.dump(doc, { lineWidth: 100, noRefs: true }));
}

export function clearGlobalCache() {
  rmSync(globalCachePath(), { force: true });
}

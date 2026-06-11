import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

const CACHE_DIR = '.code-review';
const CACHE_FILE = 'report.yaml';

function cachePath(baseDir) {
  return join(baseDir, CACHE_DIR, CACHE_FILE);
}

// Build a key uniquely identifying a (rule, file) evaluation.
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

// Load the cached report into a Map keyed by (rule, file). Returns an empty Map
// when no cache exists or it cannot be parsed.
export function loadCache(baseDir) {
  const path = cachePath(baseDir);
  const map = new Map();
  if (!existsSync(path)) return map;
  try {
    const doc = yaml.load(readFileSync(path, 'utf8'));
    for (const r of doc?.results ?? []) {
      if (r?.rule && r?.file) map.set(key(r.rule, r.file), r);
    }
  } catch {
    // A corrupt cache is non-fatal: treat as empty and let this run rebuild it.
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

// Persist results to .code-review/report.yaml, including the metadata needed to
// validate freshness on the next run (evaluated_at + rule fingerprint).
export function writeCache(baseDir, results, { elapsedMs } = {}) {
  const dir = join(baseDir, CACHE_DIR);
  mkdirSync(dir, { recursive: true });

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

  writeFileSync(cachePath(baseDir), yaml.dump(doc, { lineWidth: 100, noRefs: true }));
}

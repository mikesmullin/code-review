// Unit tests for the pure (non-LLM) parts: config parsing, file resolution,
// and report formatting. Run with:  bun test/unit.mjs
import { join } from 'node:path';
import { statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { findConfig, loadConfig } from '../src/lib/config.mjs';
import { resolveFiles } from '../src/lib/files.mjs';
import { formatRspec, formatYaml, exitCode } from '../src/lib/report.mjs';
import { loadCache, getCached, isFresh, writeCache, ruleFingerprint } from '../src/lib/cache.mjs';

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const fixturesDir = join(import.meta.dir, 'fixtures');

// --- config ---------------------------------------------------------------
const cfgPath = findConfig(fixturesDir);
ok(!!cfgPath, 'findConfig locates the fixtures .code-review.yaml');

const config = loadConfig(cfgPath);
ok(config.rules.length === 2, `loadConfig parses 2 rules (got ${config.rules.length})`);
ok(config.rules[0].id === 'no-stray-console-logs', 'first rule id parsed');
ok(config.rules[0].severity === 'error', 'default severity is error');
ok(config.rules[1].matches.length === 1, 'second rule has one match glob');

// --- validation errors -----------------------------------------------------
let threw = false;
try {
  loadConfig.call(null);
} catch {
  threw = true;
}
ok(threw, 'loadConfig throws when path is missing');

// --- file resolution --------------------------------------------------------
const logFiles = await resolveFiles(config.rules[0], config.baseDir);
ok(
  logFiles.includes('src/handlers/bad-handler.js') &&
    logFiles.includes('src/util/math.js') &&
    logFiles.includes('src/handlers/clean-handler.js'),
  `glob matches all src/**/*.js (got ${JSON.stringify(logFiles)})`,
);

const handlerFiles = await resolveFiles(config.rules[1], config.baseDir);
ok(
  handlerFiles.length === 2 && handlerFiles.every((f) => f.startsWith('src/handlers/')),
  `handler glob matches only handlers (got ${JSON.stringify(handlerFiles)})`,
);

// --- reporting --------------------------------------------------------------
const sample = [
  { rule: 'r1', severity: 'error', file: 'a.js', model: 'm', pass: true, confidence: 0.9, rationale: 'ok', error: null, ms: 1 },
  { rule: 'r1', severity: 'error', file: 'b.js', model: 'm', pass: false, confidence: 0.8, rationale: 'bad', error: null, ms: 1 },
  { rule: 'r2', severity: 'warn', file: 'c.js', model: 'm', pass: false, confidence: 0.5, rationale: 'meh', error: null, ms: 1 },
];

process.env.NO_COLOR = '1';
const rspec = formatRspec(sample, { elapsedMs: 1234 });
ok(rspec.includes('Failures:'), 'rspec report includes a Failures section');
ok(rspec.includes('1 failure'), 'rspec summary counts one hard failure');
ok(rspec.includes('1 warning'), 'rspec summary counts one warning');

const y = formatYaml(sample, { elapsedMs: 1234 });
ok(y.includes('summary:') && y.includes('results:'), 'yaml report has summary and results');

ok(exitCode(sample) === 1, 'exitCode is 1 when an error-severity rule fails');
ok(exitCode([sample[0], sample[2]]) === 0, 'exitCode is 0 when only warnings fail');

// --- cache ------------------------------------------------------------------
const cacheRule = config.rules[0];
const cacheFile = 'src/util/math.js';
const cacheAbs = join(config.baseDir, cacheFile);

// Fingerprint is stable for an unchanged rule and changes with the prompt.
const fp1 = ruleFingerprint(cacheRule);
ok(fp1 === ruleFingerprint(cacheRule), 'ruleFingerprint is stable for the same rule');
ok(fp1 !== ruleFingerprint({ ...cacheRule, prompt: cacheRule.prompt + ' x' }), 'ruleFingerprint changes when the prompt changes');

// isFresh: cached entry evaluated after the file's mtime, matching fingerprint.
const future = statSync(cacheAbs).mtimeMs + 60_000;
const freshHit = { evaluated_at: future, fingerprint: fp1 };
ok(isFresh(freshHit, cacheRule, cacheAbs), 'isFresh true when cache is newer than file and fingerprint matches');
ok(!isFresh({ evaluated_at: 1, fingerprint: fp1 }, cacheRule, cacheAbs), 'isFresh false when file is newer than cache');
ok(!isFresh({ evaluated_at: future, fingerprint: 'deadbeef' }, cacheRule, cacheAbs), 'isFresh false when fingerprint differs');
ok(!isFresh(undefined, cacheRule, cacheAbs), 'isFresh false when there is no cache entry');

// write -> load round trip.
const tmpBase = mkdtempSync(join(tmpdir(), 'cr-cache-'));
const cacheSample = [{ rule: 'r1', file: 'a.js', severity: 'error', model: 'm', pass: true, confidence: 0.9, rationale: 'ok', error: null, ms: 5, evaluated_at: future, fingerprint: fp1 }];
writeCache(tmpBase, cacheSample, { elapsedMs: 10 });
const reloaded = loadCache(tmpBase);
const got = getCached(reloaded, 'r1', 'a.js');
ok(got && got.evaluated_at === future && got.fingerprint === fp1, 'writeCache/loadCache round trips evaluated_at and fingerprint');
rmSync(tmpBase, { recursive: true, force: true });

// --- summary ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';

const CONFIG_NAMES = ['.code-review.yaml', '.code-review.yml'];
export const GLOBAL_CONFIG = join(homedir(), '.code-review.yaml');

// Walk up from `startDir` (and its ancestors) looking for a config file.
// Returns the absolute path to the first match, or null if none found.
export function findConfig(startDir = process.cwd()) {
  let dir = resolve(startDir);
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

// Walk down from `startDir` recursively, collecting all .code-review.yaml files
// found anywhere in the subtree (including startDir itself). Skips hidden dirs
// (except the root) and node_modules. Returns sorted array of absolute paths.
export function findAllConfigs(startDir = process.cwd()) {
  const root = resolve(startDir);
  const found = [];

  function walk(dir, depth) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        found.push(candidate);
        break; // only one config per directory
      }
    }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip hidden dirs (except at root depth 0), node_modules, .git
      if (depth > 0 && entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(join(dir, entry.name), depth + 1);
    }
  }

  walk(root, 0);
  return found.sort();
}

// Parse and validate a .code-review.yaml file.
// The top-level document must be a bare array of rule objects.
// Returns { configPath, baseDir, rules } where rules are normalized.
export function loadConfig(configPath) {
  if (!configPath) {
    throw new Error('No .code-review.yaml found in the current directory or any parent.');
  }
  const raw = readFileSync(configPath, 'utf8');
  let doc;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${err.message}`);
  }

  if (!Array.isArray(doc)) {
    throw new Error(`${configPath}: top-level document must be a list of rules (a YAML array).`);
  }

  const baseDir = dirname(configPath);
  const seen = new Set();
  const rules = doc.map((rule, i) => normalizeRule(rule, i, configPath, seen));
  return { configPath, baseDir, rules };
}

const VALID_SEVERITIES = new Set(['error', 'warn']);

function normalizeRule(rule, index, configPath, seen) {
  if (rule == null || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error(`${configPath}: rule #${index + 1} must be a mapping (object).`);
  }

  const id = rule.id != null ? String(rule.id) : `rule-${index + 1}`;
  if (seen.has(id)) {
    throw new Error(`${configPath}: duplicate rule id "${id}".`);
  }
  seen.add(id);

  const matches = toStringArray(rule.matches);
  if (matches.length === 0) {
    throw new Error(`${configPath}: rule "${id}" must define at least one "matches" glob.`);
  }

  const prompt = typeof rule.prompt === 'string' ? rule.prompt.trim() : '';
  if (!prompt) {
    throw new Error(`${configPath}: rule "${id}" must define a non-empty "prompt".`);
  }

  const severity = rule.severity != null ? String(rule.severity) : 'error';
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(`${configPath}: rule "${id}" has invalid severity "${severity}" (expected error|warn).`);
  }

  return {
    id,
    description: rule.description != null ? String(rule.description) : '',
    matches,
    exclude: toStringArray(rule.exclude),
    model: rule.model != null ? String(rule.model) : null,
    severity,
    prompt,
    repos: toStringArray(rule.repos), // global config only: list of repo URLs/paths
  };
}

function toStringArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

// Load the global ~/.code-review.yaml. Returns null if it doesn't exist.
// Rules may have a `repos:` field listing repo URLs or local paths they apply to.
// Returns { configPath, rules } — no baseDir (set per repo at call time).
export function loadGlobalConfig() {
  if (!existsSync(GLOBAL_CONFIG)) return null;
  const raw = readFileSync(GLOBAL_CONFIG, 'utf8');
  let doc;
  try { doc = yaml.load(raw); } catch (err) {
    throw new Error(`Failed to parse ${GLOBAL_CONFIG}: ${err.message}`);
  }
  if (doc == null) return null; // empty or comment-only file
  if (!Array.isArray(doc)) {
    throw new Error(`${GLOBAL_CONFIG}: top-level document must be a list of rules.`);
  }
  const seen = new Set();
  const rules = doc.map((rule, i) => normalizeRule(rule, i, GLOBAL_CONFIG, seen));
  return { configPath: GLOBAL_CONFIG, rules };
}

// Load all YAML files under <packageRoot>/library/**/*.yaml as additional rule
// sources. Each file is a bare array of rules (same schema as .code-review.yaml)
// and may include a `repos:` filter. packageRoot is determined by the caller
// via import.meta.dirname so this module stays pure.
export function loadLibraryConfigs(libraryDir) {
  if (!existsSync(libraryDir)) return [];
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
      let doc;
      try { doc = yaml.load(readFileSync(full, 'utf8')); } catch { continue; }
      if (!Array.isArray(doc)) continue;
      const seen = new Set();
      try {
        const rules = doc.map((rule, i) => normalizeRule(rule, i, full, seen));
        results.push({ configPath: full, rules });
      } catch { /* skip malformed library files */ }
    }
  }
  walk(libraryDir);
  return results;
}

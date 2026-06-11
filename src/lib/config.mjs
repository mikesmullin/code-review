import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';

const CONFIG_NAMES = ['.code-review.yaml', '.code-review.yml'];

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
  };
}

function toStringArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

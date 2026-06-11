import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolve the set of files a rule applies to, relative to `baseDir`.
// Files matching any `matches` glob are included, then any matching an
// `exclude` glob are removed. Returns a sorted array of POSIX-style
// workspace-relative paths.
export async function resolveFiles(rule, baseDir) {
  const included = new Set();

  for (const pattern of rule.matches) {
    const glob = new Bun.Glob(pattern);
    for await (const path of glob.scan({ cwd: baseDir, dot: false, onlyFiles: true })) {
      included.add(path);
    }
  }

  if (rule.exclude.length > 0) {
    const excludeGlobs = rule.exclude.map((p) => new Bun.Glob(p));
    for (const path of [...included]) {
      if (excludeGlobs.some((g) => g.match(path))) {
        included.delete(path);
      }
    }
  }

  return [...included].sort();
}

// Read a matched file's contents from disk. Returns { path, content }.
export function readMatched(relPath, baseDir) {
  const abs = join(baseDir, relPath);
  return { path: relPath, content: readFileSync(abs, 'utf8') };
}

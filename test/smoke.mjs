// Smoke test: runs the full CLI against the fixtures, exercising real LLM
// calls via agl-ai (copilot provider). Requires GitHub Copilot auth.
//
//   bun test/smoke.mjs            # human-readable RSpec output
//   bun test/smoke.mjs --yaml     # machine-readable YAML output
//
// Expected outcome: bad-handler.js fails both rules; the clean handler and the
// math util pass. The CLI exits non-zero because error-severity rules fail.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const fixturesDir = join(import.meta.dir, 'fixtures');
const cli = join(import.meta.dir, '..', 'src', 'cli.mjs');
const extraArgs = process.argv.slice(2);

const child = spawn('bun', [cli, ...extraArgs], {
  cwd: fixturesDir,
  stdio: 'inherit',
});

child.on('exit', (code) => {
  console.error(`\n[smoke] code-review exited with ${code} (non-zero expected: rules should fail on bad-handler.js)`);
  process.exit(0);
});

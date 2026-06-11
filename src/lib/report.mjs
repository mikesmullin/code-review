import yaml from 'js-yaml';

// Color is enabled when stdout is a TTY and NO_COLOR is unset. Evaluated
// lazily so callers (and tests) can toggle NO_COLOR at runtime.
function useColor() {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

// --- 24-bit (truecolor) ANSI helpers ---------------------------------------
const fg = ([r, g, b], s) => (useColor() ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s);
const bold = (s) => (useColor() ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (useColor() ? `\x1b[2m${s}\x1b[0m` : s);

// Named anchor colors used across the report.
const PASS = [56, 199, 96]; // green
const FAIL = [224, 64, 64]; // red
const ERR = [200, 48, 160]; // magenta (exceptions, distinct from a fail verdict)
const WARN = [226, 170, 32]; // amber
const green = (s) => fg(PASS, s);
const red = (s) => fg(FAIL, s);
const yellow = (s) => fg(WARN, s);

// Map a confidence value in [0,1] onto a red -> amber -> green gradient.
// Low confidence reads "hot" (red), high confidence reads "cool/safe" (green).
function confidenceColor(conf) {
  const t = Math.max(0, Math.min(1, conf));
  const lerp = (a, b, u) => Math.round(a + (b - a) * u);
  // stops: 0.0 red(224,64,64) -> 0.5 amber(230,176,32) -> 1.0 green(56,199,96)
  let rgb;
  if (t < 0.5) {
    const u = t / 0.5;
    rgb = [lerp(224, 230, u), lerp(64, 176, u), lerp(64, 32, u)];
  } else {
    const u = (t - 0.5) / 0.5;
    rgb = [lerp(230, 56, u), lerp(176, 199, u), lerp(32, 96, u)];
  }
  return rgb;
}

// Format a per-test duration suffix (e.g. "1.88s" or "640ms").
function timeToken(ms) {
  if (ms == null) return '';
  const text = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
  return dim(text);
}

// Render results in an RSpec-style report to a string: a Failures section
// (each line carrying confidence %, rule, file, and individual run time)
// followed by the summary line.
export function formatRspec(results, { elapsedMs } = {}) {
  const lines = [];

  const failures = results.filter((r) => !r.pass);
  if (failures.length > 0) {
    lines.push(bold('Failures:'));
    lines.push('');
    failures.forEach((r, i) => {
      const n = i + 1;
      const tag = r.error ? fg(ERR, 'ERROR') : r.severity === 'warn' ? yellow('WARN') : red('FAIL');
      const pct = r.confidence != null ? `${fg(confidenceColor(r.confidence), `${Math.round(r.confidence * 100)}%`)} ` : '';
      lines.push(`  ${n}) [${tag}] ${pct}${bold(r.rule)} — ${r.file}  ${timeToken(r.ms)}`);
      if (r.error) {
        lines.push(`     ${red(r.error)}`);
      } else {
        lines.push(`     ${r.rationale}`);
      }
      lines.push('');
    });
  }

  const total = results.length;
  const errored = results.filter((r) => r.error).length;
  const failed = results.filter((r) => !r.pass && !r.error).length;
  const warnFails = results.filter((r) => !r.pass && !r.error && r.severity === 'warn').length;
  const hardFails = failed - warnFails;

  const summaryParts = [
    `${total} ${plural(total, 'file', 'files')}`,
    `${hardFails} ${plural(hardFails, 'failure', 'failures')}`,
  ];
  if (warnFails > 0) summaryParts.push(`${warnFails} ${plural(warnFails, 'warning', 'warnings')}`);
  if (errored > 0) summaryParts.push(`${errored} ${plural(errored, 'error', 'errors')}`);

  const summary = summaryParts.join(', ');
  const colored = errored > 0 || hardFails > 0 ? red(summary) : warnFails > 0 ? yellow(summary) : green(summary);
  lines.push(colored);
  if (elapsedMs != null) lines.push(dim(`Finished in ${(elapsedMs / 1000).toFixed(2)}s`));

  return lines.join('\n');
}

// Render results as machine-readable YAML.
export function formatYaml(results, { elapsedMs } = {}) {
  const total = results.length;
  const errored = results.filter((r) => r.error).length;
  const fails = results.filter((r) => !r.pass && !r.error);
  const hardFails = fails.filter((r) => r.severity !== 'warn').length;
  const warnFails = fails.length - hardFails;

  return yaml.dump(
    {
      summary: {
        total,
        passed: results.filter((r) => r.pass).length,
        failures: hardFails,
        warnings: warnFails,
        errors: errored,
        elapsed_ms: elapsedMs ?? null,
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
      })),
    },
    { lineWidth: 100, noRefs: true },
  );
}

// Exit code policy: hard failures (severity=error) or errors -> 1, else 0.
export function exitCode(results) {
  const hardFail = results.some((r) => (!r.pass && r.severity !== 'warn') || r.error);
  return hardFail ? 1 : 0;
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

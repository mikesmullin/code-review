import Agent from 'agl-ai';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ruleFingerprint } from './cache.mjs';

export const DEFAULT_MODEL = 'copilot:claude-haiku-4.5';

// Upper bound on tool-read file size, to protect the model's context window.
const MAX_READ_BYTES = 256 * 1024;

// ─── Progress bar ─────────────────────────────────────────────────────────────
// Writes a live rewriting progress line to stderr. Falls back to dots when
// stderr is not a TTY (so CI logs stay clean).
export class Progress {
  constructor(total) {
    this.total   = total;
    this.done    = 0;
    this.cached  = 0;
    this.fails   = 0;
    this.startMs = Date.now();
    this._tty    = process.stderr.isTTY;
    this._width  = process.stderr.columns ?? 100;
  }

  tick({ cached = false, pass = true } = {}) {
    this.done++;
    if (cached) this.cached++;
    if (!pass) this.fails++;
    this._render();
  }

  _render() {
    const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(1);
    const pct     = Math.round((this.done / this.total) * 100);
    const remain  = this.total - this.done;

    const isTTY = this._tty;
    const cyan  = s => isTTY ? `\x1b[96m${s}\x1b[0m` : s;
    const dim   = s => isTTY ? `\x1b[2m${s}\x1b[0m`  : s;
    const amber = s => isTTY ? `\x1b[93m${s}\x1b[0m`  : s;

    const bar = (() => {
      const w = Math.min(20, this._width - 80);
      if (w < 4) return '';
      const filled = Math.round((this.done / this.total) * w);
      return '[' + '█'.repeat(filled) + '░'.repeat(w - filled) + '] ';
    })();

    const failPart = this.fails > 0 ? amber(`${this.fails} failing`) : dim('0 failing');
    const line = cyan(`  ${bar}${pct}% ${this.done}/${this.total} `) +
      dim(`(${this.cached} cached · `) + failPart +
      dim(` · ${remain} left · ${elapsed}s)`);

    if (this._tty) {
      process.stderr.write('\r' + line.slice(0, this._width + 60).padEnd(this._width));
    } else {
      process.stderr.write('.');
    }
  }

  finish() {
    process.stderr.write('\n');
  }
}

// Register a read_file tool on the agent so a rule's prompt can pull in
// referenced material (e.g. a conventions doc like MICROAGENT.md). Relative
// paths resolve against the config's base directory; absolute paths are
// allowed since this is a local developer tool operating on the user's machine.
function registerReadFileTool(agent, baseDir) {
  agent.Tool(
    'read_file',
    'Read a UTF-8 text file from disk and return its contents. Use this to load any file the rule references (for example a conventions document). Relative paths are resolved against the project directory.',
    {
      path: {
        type: 'string',
        description: 'Path to the file. Relative paths resolve against the project directory; absolute paths are allowed.',
      },
    },
    ['path'],
    (_ctx, { path }) => {
      try {
        const abs = isAbsolute(path) ? path : resolve(baseDir, path);
        let content = readFileSync(abs, 'utf8');
        if (content.length > MAX_READ_BYTES) {
          content = content.slice(0, MAX_READ_BYTES) + '\n…[truncated]…';
        }
        return content;
      } catch (err) {
        return JSON.stringify({ error: `could not read "${path}": ${err?.message || String(err)}` });
      }
    },
  );
}

// Build the system prompt that frames the rule for the model.
function systemPrompt(rule) {
  return `You are a meticulous code reviewer enforcing a single repository rule.
You will be given exactly one source file, wrapped in <file path="..."></file> tags.
If the rule references another file (for example a conventions document), use the
read_file tool to load it before judging. Judge whether the given file satisfies
the rule described below, then report your verdict via the output tool. Be strict
but fair: only fail a file when it genuinely violates the rule.

<rule id="${rule.id}">
${rule.prompt}
</rule>`;
}

// Wrap a single file's contents in the <file> envelope the prompt expects.
function filePrompt({ path, content }) {
  return `<file path="${path}">\n${content}\n</file>`;
}

// The structured verdict the model must return for every file.
const OUTPUT_TOOL = {
  name: 'report_verdict',
  description: 'Report whether the file satisfies the rule.',
  parameters: {
    pass: {
      type: 'boolean',
      description: 'true if the file fully satisfies the rule; false if it violates it.',
    },
    confidence: {
      type: 'number',
      description: 'Confidence in the verdict, from 0.0 (guess) to 1.0 (certain).',
    },
    rationale: {
      type: 'string',
      description: 'One or two sentences citing the specific evidence behind the verdict.',
    },
  },
  required: ['pass', 'confidence', 'rationale'],
};

// Evaluate a single file against a single rule with one LLM call.
// A fresh Agent instance is created per file so concurrent runs never share
// the instance-level last_output state. Returns a result record.
export async function reviewFile(rule, file, { defaultModel, baseDir } = {}) {
  const model = rule.model || defaultModel || DEFAULT_MODEL;
  const started = Date.now();
  try {
    const agent = await Agent.factory({
      model,
      system_prompt: systemPrompt(rule),
      output_tool: OUTPUT_TOOL,
    });
    registerReadFileTool(agent, baseDir || process.cwd());
    const out = (await agent.run({ prompt: filePrompt(file) })) || {};
    return {
      rule: rule.id,
      severity: rule.severity,
      file: file.path,
      model,
      pass: out.pass === true,
      confidence: typeof out.confidence === 'number' ? out.confidence : null,
      rationale: typeof out.rationale === 'string' ? out.rationale : '',
      error: null,
      ms: Date.now() - started,
      evaluated_at: Date.now(),
      fingerprint: ruleFingerprint(rule),
    };
  } catch (err) {
    return {
      rule: rule.id,
      severity: rule.severity,
      file: file.path,
      model,
      pass: false,
      confidence: null,
      rationale: '',
      error: err?.message || String(err),
      ms: Date.now() - started,
      evaluated_at: Date.now(),
      fingerprint: ruleFingerprint(rule),
    };
  }
}

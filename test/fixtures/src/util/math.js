// Fixture: utility module with no debug logging — should pass the log rule.
export function add(a, b) {
  return a + b;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

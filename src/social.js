// Link-preview text must never carry a score: X and other unfurlers cache the
// card per URL for days, so a score in og/twitter title or description goes stale.
const SCORE = /\d+(?:\.\d+)?\s*\/\s*10\b/;
export function socialText(text) {
  let s = String(text ?? "");
  s = s.replace(/\s*\(\s*\d+(?:\.\d+)?\s*\/\s*10\s*\)/g, "");
  s = s.replace(/\s*[·|—-]\s*tonight\s+\d+(?:\.\d+)?\s*\/\s*10\b/gi, "");
  s = s.replace(/:\s*\d+(?:\.\d+)?\s*\/\s*10\b(\s*[—-]\s*[^·.]*)?/g, "");
  // Drop whole sentences that still mention a score.
  if (SCORE.test(s)) s = s.split(/(?<=[.!?])\s+/).filter((part) => !SCORE.test(part)).join(" ");
  s = s.replace(/\s{2,}/g, " ").trim();
  if (SCORE.test(s)) s = s.replace(new RegExp(SCORE.source, "g"), "").replace(/\s{2,}/g, " ").trim();
  return s;
}
export function hasScore(text) { return SCORE.test(String(text ?? "")); }

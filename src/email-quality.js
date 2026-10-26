// Rejects obviously junk addresses before they hit D1 or Resend.
const JUNK_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "test.com", "test.test", "email.com", "domain.com",
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "yopmail.com", "trashmail.com",
  "tempmail.com", "temp-mail.org", "sharklasers.com", "throwawaymail.com", "dispostable.com",
  "maildrop.cc", "getnada.com", "fakeinbox.com",
]);
const TYPO_DOMAINS = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gmail.co": "gmail.com",
  "gmail.con": "gmail.com", "gnail.com": "gmail.com", "gmaill.com": "gmail.com",
  "yaho.com": "yahoo.com", "yahoo.co": "yahoo.com", "hotmial.com": "hotmail.com", "hotmail.co": "hotmail.com",
  "outlok.com": "outlook.com", "icloud.co": "icloud.com",
};
const JUNK_LOCALS = new Set(["test", "asdf", "qwerty", "abc", "aaa", "xxx", "fake", "none", "noreply", "no-reply", "spam", "null"]);

/** Returns "" when fine, otherwise a user-facing error message. */
export function emailProblem(email) {
  const at = email.lastIndexOf("@");
  if (at < 1) return "Please enter a valid email.";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (TYPO_DOMAINS[domain]) return `Did you mean ${local}@${TYPO_DOMAINS[domain]}?`;
  if (JUNK_DOMAINS.has(domain)) return "Please use a real email address so your alerts arrive.";
  if (JUNK_LOCALS.has(local)) return "Please use a real email address so your alerts arrive.";
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const base = local.split("+")[0].replace(/\./g, "");
    if (base.length < 6) return "That Gmail address looks too short. Gmail names have at least 6 characters.";
  }
  return "";
}

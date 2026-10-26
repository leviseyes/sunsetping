import test from "node:test";
import assert from "node:assert/strict";
import { emailProblem } from "../src/email-quality.js";

test("email quality rejects junk and typos, accepts real", () => {
  assert.match(emailProblem("gg@gmail.com"), /too short/);
  assert.match(emailProblem("a.b@gmail.com"), /too short/);
  assert.match(emailProblem("jane@gmial.com"), /gmail\.com/);
  assert.match(emailProblem("x@mailinator.com"), /real email/);
  assert.match(emailProblem("test@foo.com"), /real email/);
  assert.equal(emailProblem("jane.doe@gmail.com"), "");
  assert.equal(emailProblem("jo@smugmug.com"), "");
  assert.equal(emailProblem("growth1026@resend.dev"), "");
});

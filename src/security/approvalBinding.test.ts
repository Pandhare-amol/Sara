import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalArgumentDigest, verifyApprovalArgumentDigest } from "./approvalBinding";

const key = Buffer.from("test-only approval binding secret");

test("approval argument digest is stable across object key order", () => {
  const first = createApprovalArgumentDigest(key, "deleteFile", { path: "C:/temp/a.txt", options: { force: false, mode: "safe" } });
  const reordered = createApprovalArgumentDigest(key, "deleteFile", { options: { mode: "safe", force: false }, path: "C:/temp/a.txt" });
  assert.equal(first, reordered);
  assert.equal(verifyApprovalArgumentDigest(key, "deleteFile", { path: "C:/temp/a.txt", options: { mode: "safe", force: false } }, first), true);
});

test("approval argument digest binds action, exact arguments, and secret key", () => {
  const digest = createApprovalArgumentDigest(key, "sendMessage", { to: "+15551234567", text: "Approved text" });
  assert.equal(verifyApprovalArgumentDigest(key, "sendMessage", { to: "+15551234567", text: "Approved text" }, digest), true);
  assert.equal(verifyApprovalArgumentDigest(key, "sendMessage", { to: "+15551234567", text: "Changed text" }, digest), false);
  assert.equal(verifyApprovalArgumentDigest(key, "deleteFile", { to: "+15551234567", text: "Approved text" }, digest), false);
  assert.equal(verifyApprovalArgumentDigest(Buffer.from("different key"), "sendMessage", { to: "+15551234567", text: "Approved text" }, digest), false);
});

test("approval argument digest rejects malformed or missing digests", () => {
  assert.equal(verifyApprovalArgumentDigest(key, "sendMessage", {}, undefined), false);
  assert.equal(verifyApprovalArgumentDigest(key, "sendMessage", {}, "not-a-digest"), false);
});

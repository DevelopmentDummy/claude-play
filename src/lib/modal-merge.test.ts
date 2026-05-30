import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyModalChange, closeAllModals, readModalGroups } from "./modal-merge";

test("applyModalChange: opening a group member closes siblings", () => {
  const groups = { g1: ["a", "b", "c"] };
  const r = applyModalChange({ a: false, b: "dismissible" }, groups, "a", true);
  assert.equal(r.a, true);
  assert.equal(r.b, false);
});

test("applyModalChange: opening a non-group modal sets only itself", () => {
  const groups = { g1: ["a", "b"] };
  const r = applyModalChange({ a: "dismissible", z: false }, groups, "z", "dismissible");
  assert.equal(r.z, "dismissible");
  assert.equal(r.a, "dismissible");
});

test("applyModalChange: falsy value closes self without touching siblings", () => {
  const groups = { g1: ["a", "b"] };
  const r = applyModalChange({ a: true, b: true }, groups, "a", false);
  assert.equal(r.a, false);
  assert.equal(r.b, true);
});

test("applyModalChange: does not mutate input", () => {
  const groups = { g1: ["a", "b"] };
  const input: Record<string, unknown> = { a: false, b: true };
  applyModalChange(input, groups, "a", true);
  assert.equal(input.a, false);
  assert.equal(input.b, true);
});

test("applyModalChange: first matching group only", () => {
  const groups = { g1: ["a", "b"], g2: ["a", "c"] };
  const r = applyModalChange({ a: false, b: true, c: true }, groups, "a", true);
  assert.equal(r.a, true);
  assert.equal(r.b, false);
  assert.equal(r.c, true);
});

test("closeAllModals: closes all except listed", () => {
  const r = closeAllModals({ a: true, b: "dismissible", c: false }, ["b"]);
  assert.equal(r.a, false);
  assert.equal(r.b, "dismissible");
  assert.equal(r.c, false);
});

test("closeAllModals: empty except closes everything", () => {
  const r = closeAllModals({ a: true, b: true });
  assert.equal(r.a, false);
  assert.equal(r.b, false);
});

test("closeAllModals: does not mutate input", () => {
  const input: Record<string, unknown> = { a: true };
  closeAllModals(input);
  assert.equal(input.a, true);
});

test("readModalGroups: reads panels.modalGroups", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modal-merge-"));
  try {
    fs.writeFileSync(path.join(dir, "layout.json"),
      JSON.stringify({ panels: { modalGroups: { g1: ["a", "b"] } } }), "utf-8");
    assert.deepEqual(readModalGroups(dir), { g1: ["a", "b"] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("readModalGroups: BOM-prefixed layout.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modal-merge-"));
  try {
    fs.writeFileSync(path.join(dir, "layout.json"),
      "﻿" + JSON.stringify({ panels: { modalGroups: { g: ["x"] } } }), "utf-8");
    assert.deepEqual(readModalGroups(dir), { g: ["x"] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("readModalGroups: missing file -> {}", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modal-merge-"));
  try { assert.deepEqual(readModalGroups(dir), {}); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("readModalGroups: broken JSON -> {}", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modal-merge-"));
  try {
    fs.writeFileSync(path.join(dir, "layout.json"), "{not json", "utf-8");
    assert.deepEqual(readModalGroups(dir), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPrimitiveObj, inspectPrimitiveObj } from "../src/core/studio/primitiveMesh";
import { ArtifactStore } from "../src/core/studio/artifactStore";

for (const [shape, vertices, triangles] of [["cube", 8, 12], ["sphere", 362, 720], ["cylinder", 50, 96]] as const) {
  test(`${shape} is a saved, independently re-parsed closed outward-facing OBJ mesh`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sara-obj-test-"));
    try {
      const bytes = createPrimitiveObj(shape, { width: 2, height: 3, depth: 4 });
      assert.deepEqual(inspectPrimitiveObj(bytes), { vertices, triangles });
      const store = new ArtifactStore(root);
      const artifact = store.save({ kind: "mesh", format: "obj", prompt: `A ${shape} for a model editor`,
        provider: "local-parametric", model: "obj-mesh-v1", bytes, estimatedCostUsd: 0 });
      assert.deepEqual(artifact.geometry, { vertices, triangles });
      assert.equal(store.read(artifact.id)?.bytes.equals(bytes), true);
      assert.match(store.read(artifact.id)?.bytes.toString() || "", /^# SARA local parametric geometry/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("invalid geometry, injection lines, malformed faces and unbounded dimensions cannot become artifacts", () => {
  assert.throws(() => createPrimitiveObj("cube", { width: Infinity, height: 1, depth: 1 }), /dimensions/);
  assert.throws(() => createPrimitiveObj("sphere", { width: 0.01, height: 1, depth: 1 }), /dimensions/);
  const valid = createPrimitiveObj("cube", { width: 1, height: 1, depth: 1 }).toString();
  assert.throws(() => inspectPrimitiveObj(Buffer.from(valid + "mtllib ../../secret.mtl\n")), /Unsupported OBJ/);
  assert.throws(() => inspectPrimitiveObj(Buffer.from(valid.replace("f 1 3 4", "f 1 1 4"))), /face index/);
  assert.throws(() => inspectPrimitiveObj(Buffer.from(valid.replace("v -0.500000", "v -500.000000"))), /vertex/);
});

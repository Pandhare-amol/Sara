import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildSaraAvatarRig, updateSaraAvatarRig, type SaraAvatarRig } from "./saraAvatarRig";

function makeRigForPoseTests(): SaraAvatarRig {
  const bone = () => new THREE.Bone();
  const group = () => new THREE.Group();
  const cheek = () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  return {
    root: group(),
    bones: {
      hips: bone(),
      spine: bone(),
      chest: bone(),
      neck: bone(),
      head: bone(),
      leftShoulder: bone(),
      rightShoulder: bone(),
      leftElbow: bone(),
      rightElbow: bone(),
      leftWrist: bone(),
      rightWrist: bone(),
      leftFingerBones: [bone(), bone()],
      rightFingerBones: [bone(), bone()],
    },
    face: {
      leftEye: group(),
      rightEye: group(),
      leftBrow: group(),
      rightBrow: group(),
      mouth: group(),
      jaw: group(),
      leftCheek: cheek(),
      rightCheek: cheek(),
    },
    motion: { smoothedMouthOpen: 0, previousHeadNod: 0 },
    dispose() {
      this.root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          const material = mesh.material;
          if (Array.isArray(material)) material.forEach((item) => item.dispose());
          else material.dispose();
        }
      });
    },
  };
}

const basePose = {
  state: "idle" as const,
  expression: "neutral" as const,
  gesture: "rest" as const,
  timeSeconds: 1,
  deltaSeconds: 1 / 30,
  speakingEnergy: 0,
  blink: 0,
  gazeX: 0,
  gazeY: 0,
};

test("procedural rig builds distinct 3D clothing, face, hair, and jewelry geometry", () => {
  const noop = () => undefined;
  const context = {
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    save: noop,
    translate: noop,
    bezierCurveTo: noop,
    arc: noop,
    fill: noop,
    restore: noop,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
  };
  const fakeCanvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => {
      assert.equal(tag, "canvas");
      return fakeCanvas;
    } },
  });

  try {
    const rig = buildSaraAvatarRig();
    const meshNames: string[] = [];
    let meshCount = 0;
    rig.root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) {
        meshCount += 1;
        if (object.name) meshNames.push(object.name);
        assert.ok(((object as THREE.Mesh).geometry.attributes.position?.count ?? 0) > 0, `${object.name || "mesh"} has geometry`);
      }
    });
    assert.ok(meshCount > 100, `expected a multipart character, got ${meshCount} meshes`);
    for (const name of ["Saree_Pleated_Skirt", "Saree_Pallu_Ribbon", "Bindi", "Hair_Cap", "Necklace_Pendant", "Earring.L", "Head"]) {
      assert.ok(rig.root.getObjectByName(name), `missing expected 3D part: ${name}`);
    }
    const bounds = new THREE.Box3().setFromObject(rig.root);
    assert.ok(bounds.max.y - bounds.min.y > 3.0, "procedural model has full-body 3D height");
    rig.dispose();
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("3D pose update drives energy-based mouth motion and relaxes on interruption", () => {
  const rig = makeRigForPoseTests();
  for (let frame = 0; frame < 8; frame += 1) {
    updateSaraAvatarRig(rig, {
      ...basePose,
      state: "speaking",
      expression: "talking",
      gesture: "explain",
      timeSeconds: frame / 30,
      speakingEnergy: 0.4,
    });
  }
  const openMouth = rig.motion.smoothedMouthOpen;
  assert.ok(openMouth > 0.25, `expected mouth opening from audio energy, got ${openMouth}`);
  assert.ok(rig.bones.rightShoulder.rotation.z > 0.4, "explain gesture should move the right shoulder");

  for (let frame = 0; frame < 12; frame += 1) {
    updateSaraAvatarRig(rig, { ...basePose, state: "listening", gesture: "listen", timeSeconds: 1 + frame / 30 });
  }
  assert.ok(rig.motion.smoothedMouthOpen < openMouth * 0.4, "mouth should settle when output speech stops");
  assert.notEqual(rig.bones.head.rotation.x, 0, "listening pose includes a gentle periodic nod");
  rig.dispose();
});

test("expression, blink, and wave pose controls are bounded and applied", () => {
  const rig = makeRigForPoseTests();
  updateSaraAvatarRig(rig, {
    ...basePose,
    expression: "surprised",
    gesture: "wave",
    timeSeconds: 0.2,
    deltaSeconds: 0.05,
    blink: 0.25,
    gazeX: 0.4,
    gazeY: -0.2,
  });
  assert.ok(rig.bones.rightShoulder.rotation.z > 1.8, "wave pose should raise the right arm");
  assert.ok(rig.face.leftEye.scale.y > 0.8 && rig.face.leftEye.scale.y < 1.2, "eye openness should combine expression and blink");
  assert.ok(Math.abs(rig.bones.head.rotation.y) > 0, "head follows bounded cursor gaze");
  assert.ok(rig.face.mouth.scale.y > 0 && rig.face.mouth.scale.y < 3, "mouth scale remains in a practical range");
  rig.dispose();
});

import * as THREE from "three";
import type { AvatarConversationState, AvatarExpression, AvatarGesture } from "./avatarState";

export interface SaraAvatarRig {
  root: THREE.Group;
  bones: {
    hips: THREE.Bone;
    spine: THREE.Bone;
    chest: THREE.Bone;
    neck: THREE.Bone;
    head: THREE.Bone;
    leftShoulder: THREE.Bone;
    rightShoulder: THREE.Bone;
    leftElbow: THREE.Bone;
    rightElbow: THREE.Bone;
    leftWrist: THREE.Bone;
    rightWrist: THREE.Bone;
    leftFingerBones: THREE.Bone[];
    rightFingerBones: THREE.Bone[];
  };
  face: {
    leftEye: THREE.Group;
    rightEye: THREE.Group;
    leftBrow: THREE.Group;
    rightBrow: THREE.Group;
    mouth: THREE.Group;
    jaw: THREE.Group;
    leftCheek: THREE.Mesh;
    rightCheek: THREE.Mesh;
  };
  motion: {
    smoothedMouthOpen: number;
    previousHeadNod: number;
  };
  dispose(): void;
}

const GOLD = 0xc99843;
const GOLD_LIGHT = 0xf4d58a;
const DEEP_BLUE = 0x071f59;
const RED_SILK = 0x9d2d24;

function standardMaterial(color: THREE.ColorRepresentation, roughness = 0.7, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function makeTextileTexture(kind: "sari" | "border"): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable for avatar textile creation.");

  const isBorder = kind === "border";
  context.fillStyle = isBorder ? "#a93626" : "#071f59";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (isBorder) {
    context.strokeStyle = "#e9bd62";
    context.lineWidth = 3;
    for (let y = 12; y < canvas.height; y += 28) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(canvas.width, y);
      context.stroke();
    }
  }

  const motifColor = isBorder ? "#f1ca73" : "#c6a354";
  const secondary = isBorder ? "#641d20" : "#8b542f";
  for (let y = 22; y < canvas.height; y += isBorder ? 48 : 86) {
    const stagger = ((Math.round(y / 40) % 2) * 24);
    for (let x = 20 + stagger; x < canvas.width; x += isBorder ? 48 : 86) {
      context.save();
      context.translate(x, y);
      context.strokeStyle = motifColor;
      context.fillStyle = secondary;
      context.lineWidth = isBorder ? 2 : 1.4;
      context.beginPath();
      context.moveTo(0, -11);
      context.bezierCurveTo(11, -2, 10, 7, 0, 12);
      context.bezierCurveTo(-10, 6, -10, -2, 0, -11);
      context.stroke();
      context.beginPath();
      context.arc(0, 0, isBorder ? 2.5 : 2, 0, Math.PI * 2);
      context.fillStyle = motifColor;
      context.fill();
      context.beginPath();
      context.arc(0, -8, 2, 0, Math.PI * 2);
      context.arc(7, 0, 2, 0, Math.PI * 2);
      context.arc(0, 8, 2, 0, Math.PI * 2);
      context.arc(-7, 0, 2, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  }

  if (isBorder) {
    context.strokeStyle = "#f5df9d";
    context.lineWidth = 5;
    context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: THREE.Vector3Tuple,
  scale?: THREE.Vector3Tuple,
  name?: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  if (scale) mesh.scale.set(...scale);
  mesh.name = name || "";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function sphere(
  parent: THREE.Object3D,
  material: THREE.Material,
  position: THREE.Vector3Tuple,
  scale: THREE.Vector3Tuple,
  name?: string,
  segments = 24,
): THREE.Mesh {
  return addMesh(parent, new THREE.SphereGeometry(1, segments, Math.max(12, Math.floor(segments * 0.66))), material, position, scale, name);
}

function tube(
  parent: THREE.Object3D,
  points: THREE.Vector3[],
  radius: number,
  material: THREE.Material,
  name = "",
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 10), radius, 8, false), material);
  mesh.name = name;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function capsule(parent: THREE.Object3D, length: number, radius: number, material: THREE.Material, name: string): THREE.Mesh {
  const geometry = new THREE.CapsuleGeometry(radius, Math.max(0.025, length - radius * 2), 4, 10);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.position.y = -length / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function buildPleatedSkirt(): THREE.BufferGeometry {
  const radialSegments = 112;
  const verticalSegments = 40;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row <= verticalSegments; row += 1) {
    const t = row / verticalSegments;
    const y = 1.48 - t * 1.32;
    const baseRadius = 0.30 + t * 0.34;
    for (let column = 0; column <= radialSegments; column += 1) {
      const u = column / radialSegments;
      const theta = u * Math.PI * 2;
      const pleat = 0.013 * Math.cos(theta * 18) + 0.004 * Math.cos(theta * 36 + t * 2);
      const sway = Math.sin(theta * 5 + t * 4) * 0.012 * t;
      const radius = baseRadius + pleat + sway;
      positions.push(Math.cos(theta) * radius, y, Math.sin(theta) * radius * 0.78);
      uvs.push(u * 2.8, 1 - t);
    }
  }

  for (let row = 0; row < verticalSegments; row += 1) {
    for (let column = 0; column < radialSegments; column += 1) {
      const a = row * (radialSegments + 1) + column;
      const b = a + radialSegments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildDrapedRibbon(points: THREE.Vector3[], halfWidth: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const curve = new THREE.CatmullRomCurve3(points);
  const segments = 48;
  const curvePoints = curve.getPoints(segments);

  for (let index = 0; index <= segments; index += 1) {
    const point = curvePoints[index];
    const tangent = curve.getTangent(index / segments).normalize();
    const widthAxis = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize();
    const drape = Math.sin((index / segments) * Math.PI * 5) * 0.014;
    const center = point.clone().add(new THREE.Vector3(0, 0, drape));
    const left = center.clone().addScaledVector(widthAxis, halfWidth);
    const right = center.clone().addScaledVector(widthAxis, -halfWidth);
    positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
    uvs.push(index / segments * 2.2, 0, index / segments * 2.2, 1);
    if (index < segments) {
      const first = index * 2;
      indices.push(first, first + 2, first + 1, first + 1, first + 2, first + 3);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addEye(parent: THREE.Object3D, x: number, skinMaterial: THREE.Material, irisMaterial: THREE.Material, pupilMaterial: THREE.Material) {
  const eye = new THREE.Group();
  eye.position.set(x, 0.345, 0.246);
  eye.name = x < 0 ? "Eye.L" : "Eye.R";
  parent.add(eye);
  sphere(eye, standardMaterial(0xfffaf1, 0.28), [0, 0, 0], [0.066, 0.044, 0.035], "eyeball", 24);
  sphere(eye, irisMaterial, [0, -0.001, 0.030], [0.030, 0.030, 0.013], "iris", 20);
  sphere(eye, pupilMaterial, [0, -0.001, 0.040], [0.014, 0.017, 0.008], "pupil", 16);
  sphere(eye, standardMaterial(0xffffff, 0.12), [-0.010, 0.011, 0.047], [0.008, 0.008, 0.004], "catchlight", 12);
  const lidMaterial = skinMaterial;
  tube(eye, [new THREE.Vector3(-0.067, 0.012, 0.018), new THREE.Vector3(-0.035, 0.044, 0.030), new THREE.Vector3(0, 0.049, 0.032), new THREE.Vector3(0.036, 0.038, 0.030), new THREE.Vector3(0.066, 0.010, 0.018)], 0.009, lidMaterial, "upper-eyelid");
  tube(eye, [new THREE.Vector3(-0.055, -0.018, 0.022), new THREE.Vector3(0, -0.040, 0.030), new THREE.Vector3(0.055, -0.018, 0.022)], 0.004, standardMaterial(0x8c5944, 0.78), "lower-eyelid");
  return eye;
}

function addBrow(parent: THREE.Object3D, x: number, side: "left" | "right", material: THREE.Material): THREE.Group {
  const brow = new THREE.Group();
  brow.position.set(x, 0.425, 0.255);
  brow.name = side === "left" ? "Brow.L" : "Brow.R";
  const sign = side === "left" ? -1 : 1;
  tube(brow, [
    new THREE.Vector3(-0.071, 0, 0),
    new THREE.Vector3(-0.035, 0.018, 0.006),
    new THREE.Vector3(0.010, 0.027, 0.006),
    new THREE.Vector3(0.070, 0.004, 0),
  ], 0.012, material, `brow-hair-${sign}`);
  parent.add(brow);
  return brow;
}

function addHand(parent: THREE.Bone, side: "left" | "right", skinMaterial: THREE.Material): THREE.Bone[] {
  const hand = new THREE.Group();
  hand.name = side === "left" ? "Hand.L" : "Hand.R";
  hand.position.y = -0.008;
  parent.add(hand);
  sphere(hand, skinMaterial, [0, -0.075, 0], [0.073, 0.092, 0.041], "palm", 18);

  const fingerBones: THREE.Bone[] = [];
  const fingerOffsets = [-0.043, -0.014, 0.016, 0.044];
  fingerOffsets.forEach((x, index) => {
    const finger = new THREE.Bone();
    finger.name = `${side}.Finger${index + 1}`;
    finger.position.set(x, -0.132, 0.003);
    hand.add(finger);
    capsule(finger, 0.079 - Math.abs(index - 1.5) * 0.006, 0.010, skinMaterial, `${side}.Finger${index + 1}.segment`);
    const tip = new THREE.Bone();
    tip.name = `${side}.Finger${index + 1}.tip`;
    tip.position.y = -0.078;
    finger.add(tip);
    sphere(tip, skinMaterial, [0, -0.004, 0], [0.010, 0.014, 0.010], "finger-tip", 12);
    fingerBones.push(finger, tip);
  });
  const thumb = new THREE.Bone();
  thumb.name = `${side}.Thumb`;
  thumb.position.set(side === "left" ? -0.064 : 0.064, -0.065, 0.008);
  thumb.rotation.z = side === "left" ? -0.55 : 0.55;
  hand.add(thumb);
  capsule(thumb, 0.067, 0.012, skinMaterial, `${side}.Thumb.segment`);
  fingerBones.push(thumb);
  return fingerBones;
}

function createArm(
  chest: THREE.Bone,
  side: "left" | "right",
  skinMaterial: THREE.Material,
  goldMaterial: THREE.Material,
): { shoulder: THREE.Bone; elbow: THREE.Bone; wrist: THREE.Bone; fingers: THREE.Bone[] } {
  const sign = side === "left" ? -1 : 1;
  const shoulder = new THREE.Bone();
  shoulder.name = side === "left" ? "Shoulder.L" : "Shoulder.R";
  shoulder.position.set(sign * 0.365, 0.345, 0.005);
  shoulder.rotation.z = sign * 0.10;
  chest.add(shoulder);
  sphere(shoulder, skinMaterial, [0, -0.018, 0], [0.135, 0.15, 0.14], `${side}.shoulder-joint`, 20);
  capsule(shoulder, 0.43, 0.086, skinMaterial, `${side}.upper-arm`);

  const elbow = new THREE.Bone();
  elbow.name = side === "left" ? "Elbow.L" : "Elbow.R";
  elbow.position.y = -0.425;
  shoulder.add(elbow);
  sphere(elbow, skinMaterial, [0, 0, 0], [0.078, 0.078, 0.078], `${side}.elbow-joint`, 16);
  capsule(elbow, 0.395, 0.064, skinMaterial, `${side}.forearm`);

  const wrist = new THREE.Bone();
  wrist.name = side === "left" ? "Wrist.L" : "Wrist.R";
  wrist.position.y = -0.39;
  elbow.add(wrist);
  const bangle = new THREE.Mesh(new THREE.TorusGeometry(0.070, 0.010, 8, 28), goldMaterial);
  bangle.rotation.x = Math.PI / 2;
  bangle.position.y = -0.025;
  bangle.name = `${side}.bangle.1`;
  wrist.add(bangle);
  const secondBangle = bangle.clone();
  secondBangle.position.y = -0.055;
  secondBangle.name = `${side}.bangle.2`;
  wrist.add(secondBangle);
  const thirdBangle = bangle.clone();
  thirdBangle.position.y = -0.085;
  thirdBangle.name = `${side}.bangle.3`;
  wrist.add(thirdBangle);
  const fingers = addHand(wrist, side, skinMaterial);
  return { shoulder, elbow, wrist, fingers };
}

function addLeg(hips: THREE.Bone, side: "left" | "right", skinMaterial: THREE.Material, goldMaterial: THREE.Material) {
  const sign = side === "left" ? -1 : 1;
  const thigh = new THREE.Bone();
  thigh.name = side === "left" ? "Thigh.L" : "Thigh.R";
  thigh.position.set(sign * 0.15, -0.03, 0);
  hips.add(thigh);
  capsule(thigh, 0.67, 0.11, skinMaterial, `${side}.thigh`);
  const shin = new THREE.Bone();
  shin.name = side === "left" ? "Shin.L" : "Shin.R";
  shin.position.y = -0.66;
  thigh.add(shin);
  capsule(shin, 0.66, 0.066, skinMaterial, `${side}.shin`);
  const ankle = new THREE.Bone();
  ankle.name = side === "left" ? "Ankle.L" : "Ankle.R";
  ankle.position.set(0, -0.64, 0);
  shin.add(ankle);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.068, 0.009, 8, 24), goldMaterial);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.02;
  ankle.add(ring);
  const foot = new THREE.Group();
  foot.name = side === "left" ? "Foot.L" : "Foot.R";
  foot.position.set(0, -0.055, 0.055);
  ankle.add(foot);
  sphere(foot, skinMaterial, [0, 0, 0.06], [0.088, 0.052, 0.16], `${side}.foot`, 18);
  for (let toe = 0; toe < 5; toe += 1) {
    const offset = (toe - 2) * 0.026;
    sphere(foot, skinMaterial, [offset, -0.004, 0.19 - Math.abs(toe - 2) * 0.013], [0.015, 0.017, 0.042 - Math.abs(toe - 2) * 0.004], `${side}.toe-${toe + 1}`, 12);
  }
}

function makeEllipse(parent: THREE.Object3D, material: THREE.Material, position: THREE.Vector3Tuple, scale: THREE.Vector3Tuple, name: string) {
  return sphere(parent, material, position, scale, name, 20);
}

export function buildSaraAvatarRig(): SaraAvatarRig {
  const root = new THREE.Group();
  root.name = "SARA_ProceduralCharacter_Root";
  const skinMaterial = new THREE.MeshPhysicalMaterial({ color: 0xc9845e, roughness: 0.73, metalness: 0, clearcoat: 0.05 });
  const skinLightMaterial = new THREE.MeshPhysicalMaterial({ color: 0xd89570, roughness: 0.68, metalness: 0, clearcoat: 0.06 });
  const hairMaterial = new THREE.MeshPhysicalMaterial({ color: 0x160e12, roughness: 0.48, metalness: 0.03, clearcoat: 0.28, clearcoatRoughness: 0.48 });
  const hairHighlightMaterial = standardMaterial(0x3d241d, 0.56);
  const irisMaterial = standardMaterial(0x5d2d1d, 0.34);
  const pupilMaterial = standardMaterial(0x140d0a, 0.22);
  const goldMaterial = new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.28, metalness: 0.78 });
  const goldLightMaterial = new THREE.MeshStandardMaterial({ color: GOLD_LIGHT, roughness: 0.25, metalness: 0.72 });
  const bindiMaterial = standardMaterial(0x8e171b, 0.32);
  const blouseMaterial = new THREE.MeshStandardMaterial({ color: 0x8b1f2d, roughness: 0.7, metalness: 0.05 });
  const blueTexture = makeTextileTexture("sari");
  const borderTexture = makeTextileTexture("border");
  const sariMaterial = new THREE.MeshStandardMaterial({ map: blueTexture, color: 0xffffff, roughness: 0.68, metalness: 0.04, side: THREE.DoubleSide });
  const borderMaterial = new THREE.MeshStandardMaterial({ map: borderTexture, color: 0xffffff, roughness: 0.5, metalness: 0.14, side: THREE.DoubleSide });
  const accentGold = new THREE.MeshStandardMaterial({ color: 0xd2a64e, roughness: 0.52, metalness: 0.28, transparent: true, opacity: 0.88 });
  const cheekMaterial = new THREE.MeshStandardMaterial({ color: 0xca675f, roughness: 0.8, transparent: true, opacity: 0.25, depthWrite: false });
  const materials: THREE.Material[] = [skinMaterial, skinLightMaterial, hairMaterial, hairHighlightMaterial, irisMaterial, pupilMaterial, goldMaterial, goldLightMaterial, bindiMaterial, blouseMaterial, sariMaterial, borderMaterial, accentGold, cheekMaterial];
  const geometries: THREE.BufferGeometry[] = [];

  const hips = new THREE.Bone();
  hips.name = "Hips";
  hips.position.set(0, 1.46, 0);
  root.add(hips);
  const spine = new THREE.Bone();
  spine.name = "Spine";
  hips.add(spine);
  const chest = new THREE.Bone();
  chest.name = "Chest";
  chest.position.y = 0.45;
  spine.add(chest);
  const neck = new THREE.Bone();
  neck.name = "Neck";
  neck.position.y = 0.48;
  chest.add(neck);
  const head = new THREE.Bone();
  head.name = "Head";
  head.position.y = 0.23;
  neck.add(head);

  // Blouse and neck are separate volume meshes attached to articulated bones.
  sphere(spine, blouseMaterial, [0, 0.27, -0.015], [0.39, 0.53, 0.235], "Blouse_Torso", 32);
  sphere(chest, blouseMaterial, [0, 0.06, -0.01], [0.42, 0.34, 0.24], "Blouse_Upper", 28);
  sphere(neck, skinLightMaterial, [0, 0.02, 0], [0.13, 0.19, 0.13], "Neck_Skin", 20);

  // Head, ears, facial planes and the gently stylized face.
  const face = new THREE.Group();
  face.name = "Face_Controls";
  face.position.set(0, 0.25, 0);
  head.add(face);
  sphere(face, skinLightMaterial, [0, 0.12, 0], [0.305, 0.415, 0.255], "Head_Skin", 40);
  sphere(face, skinMaterial, [-0.295, 0.105, -0.005], [0.061, 0.105, 0.07], "Ear.L", 20);
  sphere(face, skinMaterial, [0.295, 0.105, -0.005], [0.061, 0.105, 0.07], "Ear.R", 20);

  const leftEye = addEye(face, -0.112, skinLightMaterial, irisMaterial, pupilMaterial);
  const rightEye = addEye(face, 0.112, skinLightMaterial, irisMaterial, pupilMaterial);
  const browMaterial = standardMaterial(0x362018, 0.72);
  const leftBrow = addBrow(face, -0.115, "left", browMaterial);
  const rightBrow = addBrow(face, 0.115, "right", browMaterial);

  // The nose and the mouth are volumetric meshes, not drawn onto a portrait.
  sphere(face, skinLightMaterial, [0, 0.20, 0.255], [0.035, 0.086, 0.048], "Nose_Bridge", 20);
  sphere(face, skinLightMaterial, [0, 0.158, 0.286], [0.055, 0.040, 0.043], "Nose_Tip", 20);
  sphere(face, standardMaterial(0x6e3c2b, 0.8), [-0.024, 0.141, 0.319], [0.010, 0.006, 0.006], "Nostril.L", 10);
  sphere(face, standardMaterial(0x6e3c2b, 0.8), [0.024, 0.141, 0.319], [0.010, 0.006, 0.006], "Nostril.R", 10);

  const jaw = new THREE.Group();
  jaw.name = "Jaw_Control";
  jaw.position.set(0, -0.01, 0.07);
  face.add(jaw);
  sphere(jaw, skinLightMaterial, [0, -0.115, 0.028], [0.202, 0.18, 0.18], "Lower_Jaw", 28);
  const mouth = new THREE.Group();
  mouth.name = "Mouth_Control";
  mouth.position.set(0, 0.025, 0.204);
  jaw.add(mouth);
  sphere(mouth, standardMaterial(0x4d181d, 0.52), [0, 0, 0], [0.070, 0.018, 0.010], "Mouth_Interior", 20);
  tube(mouth, [new THREE.Vector3(-0.071, 0.006, 0.003), new THREE.Vector3(-0.035, 0.020, 0.012), new THREE.Vector3(0, 0.016, 0.013), new THREE.Vector3(0.035, 0.020, 0.012), new THREE.Vector3(0.071, 0.006, 0.003)], 0.009, standardMaterial(0x9b4c48, 0.6), "Upper_Lip");
  tube(mouth, [new THREE.Vector3(-0.064, -0.006, 0.006), new THREE.Vector3(0, -0.024, 0.014), new THREE.Vector3(0.064, -0.006, 0.006)], 0.010, standardMaterial(0xb76662, 0.58), "Lower_Lip");
  const leftCheek = sphere(face, cheekMaterial, [-0.19, 0.04, 0.174], [0.061, 0.036, 0.018], "Cheek.L", 20);
  const rightCheek = sphere(face, cheekMaterial, [0.19, 0.04, 0.174], [0.061, 0.036, 0.018], "Cheek.R", 20);
  sphere(face, bindiMaterial, [0, 0.472, 0.226], [0.018, 0.024, 0.010], "Bindi", 18);
  sphere(face, goldLightMaterial, [0.13, 0.19, 0.305], [0.010, 0.010, 0.008], "Nose_Stud", 12);

  // Dark cap and long, separate locks give the silhouette depth without a flat hair card.
  const hairCap = new THREE.Mesh(
    new THREE.SphereGeometry(1, 36, 24, 0, Math.PI * 2, 0, Math.PI * 0.61),
    hairMaterial,
  );
  hairCap.name = "Hair_Cap";
  hairCap.position.set(0, 0.205, -0.012);
  hairCap.scale.set(0.34, 0.48, 0.30);
  hairCap.castShadow = true;
  face.add(hairCap);
  const backHair = sphere(face, hairMaterial, [0, -0.18, -0.115], [0.32, 0.45, 0.20], "Hair_Back_Volume", 30);
  backHair.rotation.x = -0.15;
  for (const side of [-1, 1]) {
    const sidePath = [
      new THREE.Vector3(side * 0.23, 0.46, 0.115),
      new THREE.Vector3(side * 0.31, 0.22, 0.065),
      new THREE.Vector3(side * 0.32, -0.08, 0.015),
      new THREE.Vector3(side * 0.29, -0.35, -0.025),
      new THREE.Vector3(side * 0.24, -0.64, -0.040),
    ];
    tube(face, sidePath, 0.074, hairMaterial, side < 0 ? "Hair_Lock.L" : "Hair_Lock.R");
    const highlightPath = sidePath.map((point) => point.clone().add(new THREE.Vector3(-side * 0.028, 0, 0.030)));
    tube(face, highlightPath, 0.008, hairHighlightMaterial, side < 0 ? "Hair_Highlight.L" : "Hair_Highlight.R");
    const frontStrand = [
      new THREE.Vector3(side * 0.21, 0.42, 0.18),
      new THREE.Vector3(side * 0.24, 0.18, 0.18),
      new THREE.Vector3(side * 0.25, -0.10, 0.13),
      new THREE.Vector3(side * 0.22, -0.39, 0.07),
    ];
    tube(face, frontStrand, 0.034, hairMaterial, side < 0 ? "Hair_Front.L" : "Hair_Front.R");
  }
  // Central hair part and a few fine strands add layered highlights.
  tube(face, [new THREE.Vector3(0, 0.60, 0.10), new THREE.Vector3(0.015, 0.49, 0.20), new THREE.Vector3(0.040, 0.35, 0.23)], 0.009, hairHighlightMaterial, "Hair_Part_Highlight");

  // Earrings, necklace, pendant, armlets and bangles match the gold accents in the reference.
  for (const side of [-1, 1]) {
    const earring = new THREE.Group();
    earring.name = side < 0 ? "Earring.L" : "Earring.R";
    earring.position.set(side * 0.30, 0.10, 0.06);
    face.add(earring);
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.009, 8, 24), goldMaterial);
    hoop.position.y = -0.025;
    hoop.rotation.y = Math.PI / 2;
    earring.add(hoop);
    sphere(earring, goldLightMaterial, [0, -0.092, 0.005], [0.020, 0.032, 0.018], "earring-drop", 14);
  }

  tube(chest, [
    new THREE.Vector3(-0.22, 0.24, 0.18),
    new THREE.Vector3(-0.16, 0.05, 0.205),
    new THREE.Vector3(0, -0.04, 0.225),
    new THREE.Vector3(0.16, 0.05, 0.205),
    new THREE.Vector3(0.22, 0.24, 0.18),
  ], 0.012, goldLightMaterial, "Necklace_Chain");
  const pendant = new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 1), goldMaterial);
  pendant.name = "Necklace_Pendant";
  pendant.position.set(0, -0.035, 0.24);
  pendant.scale.set(0.68, 1.15, 0.28);
  chest.add(pendant);

  // A patterned navy skirt with hem bands and raised pleat lines.
  const skirtGeometry = buildPleatedSkirt();
  geometries.push(skirtGeometry);
  const skirt = new THREE.Mesh(skirtGeometry, sariMaterial);
  skirt.name = "Saree_Pleated_Skirt";
  skirt.castShadow = true;
  skirt.receiveShadow = true;
  root.add(skirt);
  const waistWrap = new THREE.Mesh(new THREE.CylinderGeometry(0.315, 0.33, 0.15, 96, 1, true), borderMaterial);
  waistWrap.name = "Saree_Waist_Wrap";
  waistWrap.position.y = 1.405;
  waistWrap.castShadow = true;
  root.add(waistWrap);
  for (const [radius, tubeRadius, y, material] of [
    [0.631, 0.018, 0.17, goldMaterial],
    [0.622, 0.022, 0.205, borderMaterial],
    [0.611, 0.010, 0.242, goldLightMaterial],
    [0.605, 0.012, 0.28, borderMaterial],
  ] as const) {
    const hem = new THREE.Mesh(new THREE.TorusGeometry(radius, tubeRadius, 8, 100), material);
    hem.name = "Saree_Hem_Border";
    hem.rotation.x = Math.PI / 2;
    hem.position.y = y;
    hem.castShadow = true;
    root.add(hem);
  }

  // Broad pallu sash across the front, modeled as a curved 3D ribbon with raised gold edges.
  const palluPoints = [
    new THREE.Vector3(0.29, 2.50, 0.25),
    new THREE.Vector3(0.22, 2.20, 0.285),
    new THREE.Vector3(0.08, 1.84, 0.30),
    new THREE.Vector3(-0.12, 1.50, 0.33),
    new THREE.Vector3(-0.25, 1.23, 0.34),
  ];
  const palluGeometry = buildDrapedRibbon(palluPoints, 0.205);
  geometries.push(palluGeometry);
  const pallu = new THREE.Mesh(palluGeometry, borderMaterial);
  pallu.name = "Saree_Pallu_Ribbon";
  pallu.castShadow = true;
  pallu.receiveShadow = true;
  root.add(pallu);
  const palluCurve = new THREE.CatmullRomCurve3(palluPoints);
  for (const edgeSign of [-1, 1]) {
    const edgePoints = palluCurve.getPoints(48).map((point, index, points) => {
      const tangent = palluCurve.getTangent(index / 48).normalize();
      return point.add(new THREE.Vector3(-tangent.y, tangent.x, 0).normalize().multiplyScalar(0.205 * edgeSign)).add(new THREE.Vector3(0, 0, 0.012));
    });
    tube(root, edgePoints, 0.012, goldLightMaterial, edgeSign < 0 ? "Pallu_Gold_Edge.L" : "Pallu_Gold_Edge.R");
  }
  // Small woven fold seams on the front panel; they follow the fabric rather than drawing over the camera.
  for (let fold = 0; fold < 9; fold += 1) {
    const x = -0.25 + fold * 0.062;
    tube(root, [
      new THREE.Vector3(x, 1.36, 0.33),
      new THREE.Vector3(x + 0.014, 0.98, 0.44),
      new THREE.Vector3(x + 0.018, 0.60, 0.51),
      new THREE.Vector3(x + 0.010, 0.22, 0.57),
    ], 0.004, accentGold, `Saree_Pleat_${fold + 1}`);
  }

  const leftArm = createArm(chest, "left", skinLightMaterial, goldMaterial);
  const rightArm = createArm(chest, "right", skinLightMaterial, goldMaterial);
  addLeg(hips, "left", skinLightMaterial, goldMaterial);
  addLeg(hips, "right", skinLightMaterial, goldMaterial);
  // Armlet rings are raised above the blouse sleeve edges.
  for (const side of [-1, 1]) {
    const armlet = new THREE.Mesh(new THREE.TorusGeometry(0.090, 0.010, 8, 28), goldMaterial);
    armlet.name = side < 0 ? "Armlet.L" : "Armlet.R";
    armlet.position.set(side * 0.42, 0.21, 0.005);
    armlet.rotation.x = Math.PI / 2;
    chest.add(armlet);
  }
  // A small red blouse sleeve cuff with a gold edge on each shoulder.
  for (const side of [-1, 1]) {
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.012, 8, 28), goldLightMaterial);
    cuff.name = side < 0 ? "Blouse_Cuff.L" : "Blouse_Cuff.R";
    cuff.position.set(side * 0.40, 0.31, 0);
    cuff.rotation.x = Math.PI / 2;
    chest.add(cuff);
  }

  // Soft grounding shadow and anklets.
  const groundShadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.58, 48),
    new THREE.MeshBasicMaterial({ color: 0x061027, transparent: true, opacity: 0.24, depthWrite: false }),
  );
  groundShadow.name = "Grounding_Shadow";
  groundShadow.rotation.x = -Math.PI / 2;
  groundShadow.position.set(0, 0.035, 0.06);
  root.add(groundShadow);

  const collectedGeometrySet = new Set<THREE.BufferGeometry>(geometries);
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) {
      const mesh = object as THREE.Mesh;
      collectedGeometrySet.add(mesh.geometry);
      const material = mesh.material;
      if (Array.isArray(material)) materials.push(...material);
      else if (material && !materials.includes(material)) materials.push(material);
    }
  });

  return {
    root,
    bones: {
      hips,
      spine,
      chest,
      neck,
      head,
      leftShoulder: leftArm.shoulder,
      rightShoulder: rightArm.shoulder,
      leftElbow: leftArm.elbow,
      rightElbow: rightArm.elbow,
      leftWrist: leftArm.wrist,
      rightWrist: rightArm.wrist,
      leftFingerBones: leftArm.fingers,
      rightFingerBones: rightArm.fingers,
    },
    face: { leftEye, rightEye, leftBrow, rightBrow, mouth, jaw, leftCheek, rightCheek },
    motion: { smoothedMouthOpen: 0, previousHeadNod: 0 },
    dispose() {
      collectedGeometrySet.forEach((geometry) => geometry.dispose());
      const disposed = new Set<THREE.Material>();
      materials.forEach((material) => {
        if (!disposed.has(material)) {
          disposed.add(material);
          material.dispose();
        }
      });
      blueTexture.dispose();
      borderTexture.dispose();
    },
  };
}

export interface AvatarPoseInput {
  state: AvatarConversationState;
  expression: AvatarExpression;
  gesture: AvatarGesture;
  timeSeconds: number;
  deltaSeconds: number;
  speakingEnergy: number;
  blink: number;
  gazeX: number;
  gazeY: number;
}

const EXPRESSION_POSE: Record<AvatarExpression, { smile: number; brow: number; eyeOpen: number; headTilt: number; gazeY: number }> = {
  neutral: { smile: 0.02, brow: 0, eyeOpen: 1, headTilt: 0, gazeY: 0 },
  smile: { smile: 0.58, brow: 0.04, eyeOpen: 0.97, headTilt: 0.015, gazeY: 0 },
  laugh: { smile: 0.82, brow: 0.12, eyeOpen: 0.78, headTilt: 0.04, gazeY: 0 },
  talking: { smile: 0.12, brow: 0.02, eyeOpen: 1, headTilt: 0, gazeY: 0 },
  thinking: { smile: 0, brow: 0.12, eyeOpen: 0.92, headTilt: 0.10, gazeY: 0.18 },
  curious: { smile: 0.12, brow: 0.30, eyeOpen: 1.03, headTilt: 0.12, gazeY: 0.04 },
  surprised: { smile: 0.02, brow: 0.62, eyeOpen: 1.12, headTilt: -0.02, gazeY: 0.02 },
  happy: { smile: 0.58, brow: 0.08, eyeOpen: 0.98, headTilt: 0.025, gazeY: 0 },
  concerned: { smile: -0.22, brow: 0.32, eyeOpen: 0.97, headTilt: 0.035, gazeY: -0.025 },
  angry: { smile: -0.28, brow: -0.42, eyeOpen: 0.94, headTilt: -0.015, gazeY: 0 },
  confused: { smile: -0.05, brow: 0.25, eyeOpen: 0.99, headTilt: 0.16, gazeY: 0.06 },
  reassuring: { smile: 0.30, brow: 0.14, eyeOpen: 0.98, headTilt: 0.04, gazeY: 0 },
  listening: { smile: 0.08, brow: 0.06, eyeOpen: 1, headTilt: 0.035, gazeY: 0 },
  sleepy: { smile: 0.02, brow: -0.08, eyeOpen: 0.55, headTilt: 0.045, gazeY: -0.05 },
  greeting: { smile: 0.52, brow: 0.12, eyeOpen: 1, headTilt: 0.035, gazeY: 0 },
};

export function updateSaraAvatarRig(rig: SaraAvatarRig, pose: AvatarPoseInput): void {
  const { bones, face } = rig;
  const t = pose.timeSeconds;
  const dt = Math.max(0, Math.min(0.05, pose.deltaSeconds));
  const smooth = 1 - Math.exp(-dt * 12);
  const expression = EXPRESSION_POSE[pose.expression];
  const idle = pose.state === "idle" || pose.state === "listening";
  const speechPulse = pose.state === "speaking" ? Math.sin(t * 3.2) * 0.008 : 0;

  bones.spine.scale.y = 1 + Math.sin(t * 1.05) * (idle ? 0.006 : 0.004);
  bones.spine.rotation.x = Math.sin(t * 0.62) * 0.012 + speechPulse;
  bones.chest.rotation.z = Math.sin(t * 0.47) * 0.012;
  bones.chest.rotation.x = Math.sin(t * 0.73) * 0.008;
  bones.neck.rotation.z = Math.sin(t * 0.35) * 0.009;
  bones.head.rotation.z = expression.headTilt + pose.gazeX * 0.08 + Math.sin(t * 0.43) * 0.008;
  bones.head.rotation.x = -pose.gazeY * 0.07 - expression.gazeY * 0.10 + (pose.state === "thinking" ? Math.sin(t * 0.52) * 0.012 : 0);
  bones.head.rotation.y = pose.gazeX * 0.11;

  const eyeScaleY = expression.eyeOpen * (1 - Math.min(0.97, pose.blink));
  face.leftEye.scale.y = eyeScaleY;
  face.rightEye.scale.y = eyeScaleY;
  face.leftEye.rotation.y = pose.gazeX * 0.13;
  face.rightEye.rotation.y = pose.gazeX * 0.13;
  face.leftEye.rotation.x = -pose.gazeY * 0.10 - expression.gazeY * 0.1;
  face.rightEye.rotation.x = -pose.gazeY * 0.10 - expression.gazeY * 0.1;
  face.leftBrow.position.y = 0.425 + expression.brow * 0.017;
  face.rightBrow.position.y = 0.425 + expression.brow * 0.017;
  face.leftBrow.rotation.z = expression.brow * 0.10 + (pose.expression === "confused" ? 0.12 : 0);
  face.rightBrow.rotation.z = -expression.brow * 0.10 + (pose.expression === "confused" ? -0.06 : 0);
  face.leftCheek.scale.x = 0.061 * (1 + Math.max(0, expression.smile) * 0.22);
  face.rightCheek.scale.x = 0.061 * (1 + Math.max(0, expression.smile) * 0.22);
  face.mouth.scale.x = 1 + expression.smile * 0.22;
  face.mouth.rotation.z = expression.smile * 0.10;

  const speechTarget = pose.state === "speaking" ? Math.max(0, Math.min(0.55, (pose.speakingEnergy - 0.012) * 1.65)) : 0;
  const expressionOpen = pose.expression === "laugh" ? 0.10 : pose.expression === "surprised" ? 0.045 : 0;
  const openTarget = Math.max(speechTarget, expressionOpen);
  rig.motion.smoothedMouthOpen += (openTarget - rig.motion.smoothedMouthOpen) * smooth;
  face.mouth.scale.y = 0.52 + rig.motion.smoothedMouthOpen * 3.6;
  face.jaw.rotation.x = -rig.motion.smoothedMouthOpen * 0.38;
  face.jaw.position.y = -0.01 - rig.motion.smoothedMouthOpen * 0.012;

  const leftBase = -0.10;
  const rightBase = 0.10;
  let leftShoulder = leftBase;
  let rightShoulder = rightBase;
  let leftElbow = 0.03;
  let rightElbow = -0.03;
  let leftWrist = 0;
  let rightWrist = 0;

  switch (pose.gesture) {
    case "wave":
      rightShoulder = 2.0;
      rightElbow = 0.5;
      rightWrist = Math.sin(t * 6.2) * 0.28;
      break;
    case "explain":
      leftShoulder = -0.58 + Math.sin(t * 1.2) * 0.045;
      rightShoulder = 0.58 + Math.sin(t * 1.2 + 1.2) * 0.045;
      leftElbow = -0.28;
      rightElbow = 0.28;
      leftWrist = Math.sin(t * 1.45) * 0.10;
      rightWrist = Math.sin(t * 1.45 + 0.9) * 0.10;
      break;
    case "point":
      rightShoulder = 1.32;
      rightElbow = 0.18;
      rightWrist = -0.08;
      break;
    case "think":
      rightShoulder = 2.0;
      rightElbow = 1.9;
      rightWrist = -0.22;
      break;
    case "listen":
      leftShoulder = -0.06;
      rightShoulder = 0.08;
      leftElbow = 0.06;
      rightElbow = -0.04;
      break;
    case "celebrate":
      leftShoulder = -1.8;
      rightShoulder = 1.8;
      leftElbow = -0.30;
      rightElbow = 0.30;
      leftWrist = Math.sin(t * 2.5) * 0.10;
      rightWrist = -Math.sin(t * 2.5) * 0.10;
      break;
    case "nod":
      leftShoulder = -0.11;
      rightShoulder = 0.11;
      break;
    case "rest":
    default:
      break;
  }

  bones.leftShoulder.rotation.z = leftShoulder;
  bones.rightShoulder.rotation.z = rightShoulder;
  bones.leftElbow.rotation.z = leftElbow;
  bones.rightElbow.rotation.z = rightElbow;
  bones.leftWrist.rotation.z = leftWrist;
  bones.rightWrist.rotation.z = rightWrist;
  const fingerCurl = pose.gesture === "wave" || pose.gesture === "celebrate" ? 0.10 : 0.20;
  bones.leftFingerBones.forEach((finger, index) => { finger.rotation.z = (index % 2 ? -1 : 1) * fingerCurl * 0.10; });
  bones.rightFingerBones.forEach((finger, index) => { finger.rotation.z = (index % 2 ? 1 : -1) * fingerCurl * 0.10; });

  const nod = pose.gesture === "nod" || pose.state === "listening" ? Math.sin(t * (pose.gesture === "nod" ? 4.4 : 0.8)) * 0.025 : 0;
  bones.head.rotation.x += nod;
  rig.motion.previousHeadNod = nod;
}

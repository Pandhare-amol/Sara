import type * as THREE from "three";
import type { AvatarConversationState, AvatarExpression, AvatarGesture } from "./avatarState";
import { buildSaraAvatarRig, updateSaraAvatarRig, type SaraAvatarRig } from "./saraAvatarRig";

export interface AvatarDriverPose {
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

/**
 * Replaceable boundary between the renderer and the character asset/rig.
 * Future licensed GLB/VRM assets can implement the same contract with a
 * loader, named bones/morphs, animation clips and their own disposal routine.
 */
export interface SaraAvatarDriver {
  root: THREE.Group;
  update(pose: AvatarDriverPose): void;
  dispose(): void;
}

export function createProceduralSaraAvatarDriver(): SaraAvatarDriver {
  const rig: SaraAvatarRig = buildSaraAvatarRig();
  return {
    root: rig.root,
    update: (pose) => updateSaraAvatarRig(rig, pose),
    dispose: () => rig.dispose(),
  };
}

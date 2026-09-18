export type SaraAnimationState = "idle" | "thinking" | "talking";

export interface SaraAnimationProfile {
  id: string;
  label: string;
  description: string;
}

export const SARA_ANIMATION_PROFILES: SaraAnimationProfile[] = [
  { id: "classic", label: "Classic Sara", description: "The original calm holographic presence" },
  { id: "cinematic", label: "Cinematic Sara", description: "Slower, dramatic character motion" },
  { id: "luminous", label: "Luminous Sara", description: "Bright, energetic visual presence" },
];

export function getAnimationProfile(profileId: string): SaraAnimationProfile {
  return SARA_ANIMATION_PROFILES.find((profile) => profile.id === profileId) || SARA_ANIMATION_PROFILES[0];
}

export function getAnimationPlaylist(
  themeColor: string,
  profileId: string,
  state: SaraAnimationState,
): string[] {
  const root = `/assets/ui/${themeColor}/${profileId}`;
  const legacyRoot = `/assets/ui/${themeColor}`;
  const defaultSource = `/assets/${state}.mp4`;

  return [
    `${root}/${state}-1.mp4`,
    `${root}/${state}-2.mp4`,
    `${root}/${state}.mp4`,
    `${legacyRoot}/${state}.mp4`,
    defaultSource,
  ];
}

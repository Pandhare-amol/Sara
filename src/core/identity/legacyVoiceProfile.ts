export const LEGACY_VOICE_PROFILE_STORAGE_KEY = "sara.voiceProfile.v1";

export interface VoiceProfileStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

function getBrowserStorage(): VoiceProfileStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Checks only whether the obsolete sample key exists; it never reads or parses its value. */
export function hasLegacyStoredVoiceProfile(
  storage: VoiceProfileStorage | null = getBrowserStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(LEGACY_VOICE_PROFILE_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Removes the obsolete key only after the caller has explicitly confirmed deletion. */
export function deleteLegacyStoredVoiceProfile(
  confirmed: boolean,
  storage: VoiceProfileStorage | null = getBrowserStorage(),
): boolean {
  if (!confirmed || !storage) return false;
  try {
    if (storage.getItem(LEGACY_VOICE_PROFILE_STORAGE_KEY) === null) return false;
    storage.removeItem(LEGACY_VOICE_PROFILE_STORAGE_KEY);
    return storage.getItem(LEGACY_VOICE_PROFILE_STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

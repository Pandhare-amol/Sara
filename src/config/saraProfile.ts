import * as fs from "fs";
import * as path from "path";

// A single central place for SARA's personality and voice configuration.
export const SARA_VOICE_PROFILE = {
  identity: "AI assistant",
  persona_style: "warm_feminine_companion",
  gender_style: "female",
  age_style: "fictional_adult_persona",
  fictional_persona_age: 20, // Styling only; SARA is an AI and has no literal human age.
  tone: "soft",
  warmth: "high",
  pitch: "stable",
  speaking_rate: "natural",
  expressiveness: "high",
  voiceName: "Despina" // Consistent underlying TTS voice for the selected persona style.
};

export type SaraMode = "NORMAL" | "PROFESSIONAL" | "FRIENDLY" | "COMPANION";

const PROFILE_STORE_PATH = path.join(process.cwd(), "data", "sara_profile.json");

export function getSaraMode(): SaraMode {
  try {
    if (fs.existsSync(PROFILE_STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(PROFILE_STORE_PATH, "utf-8"));
      if (data && data.mode) {
        return data.mode as SaraMode;
      }
    }
  } catch (e) {
    // Return default
  }
  return "NORMAL";
}

export function setSaraMode(mode: SaraMode): void {
  try {
    const data = { mode };
    fs.writeFileSync(PROFILE_STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save SARA mode:", e);
  }
}

export function getModeInstructions(): string {
  const currentMode = getSaraMode();
  return `\nCURRENT SARA MODE: ${currentMode}\nYou must strictly adhere to the behavioral rules defined for ${currentMode} mode in your system prompt.\n`;
}

import type { SingerMood, SingerStyle, SongDuration, SongPlan, SupportedSingerLanguage } from "./SingerTypes";

const MOOD_DEFAULTS: Record<SingerMood, Omit<SongPlan, "language" | "duration">> = {
  HAPPY: { mood: "HAPPY", style: "POP", tempoBpm: 112, energy: 0.75, vocalStyle: "bright and warmly expressive", instrumentalProfile: "light pop rhythm and acoustic accents", sections: [] },
  CALM: { mood: "CALM", style: "PIANO", tempoBpm: 68, energy: 0.25, vocalStyle: "soft and intimate", instrumentalProfile: "felt piano with sparse ambient texture", sections: [] },
  ROMANTIC: { mood: "ROMANTIC", style: "SOFT_ACOUSTIC", tempoBpm: 78, energy: 0.35, vocalStyle: "tender and emotionally responsive", instrumentalProfile: "fingerpicked acoustic guitar and gentle pads", sections: [] },
  SAD: { mood: "SAD", style: "SOFT_ACOUSTIC", tempoBpm: 66, energy: 0.2, vocalStyle: "restrained and vulnerable", instrumentalProfile: "minimal piano and warm strings", sections: [] },
  MOTIVATIONAL: { mood: "MOTIVATIONAL", style: "INDIAN_FUSION", tempoBpm: 108, energy: 0.82, vocalStyle: "clear, confident, and naturally powerful", instrumentalProfile: "cinematic pop pulse with Indian melodic color", sections: [] },
  ENERGETIC: { mood: "ENERGETIC", style: "POP", tempoBpm: 124, energy: 0.95, vocalStyle: "rhythmic and lively", instrumentalProfile: "dance-pop drums and bright synths", sections: [] },
  RELAXING: { mood: "RELAXING", style: "LOFI", tempoBpm: 72, energy: 0.18, vocalStyle: "breathy, soft, and unhurried", instrumentalProfile: "lofi percussion, piano, and low ambient bed", sections: [] },
  EMOTIONAL: { mood: "EMOTIONAL", style: "ORCHESTRAL", tempoBpm: 82, energy: 0.55, vocalStyle: "expressive with controlled dynamics", instrumentalProfile: "restrained strings and piano", sections: [] },
  DEVOTIONAL: { mood: "DEVOTIONAL", style: "INDIAN_FUSION", tempoBpm: 76, energy: 0.38, vocalStyle: "clear, reverent, and gentle", instrumentalProfile: "tanpura-inspired drone with soft percussion", sections: [] },
  CINEMATIC: { mood: "CINEMATIC", style: "ORCHESTRAL", tempoBpm: 92, energy: 0.65, vocalStyle: "open and emotionally expansive", instrumentalProfile: "orchestral rise with piano foundation", sections: [] },
};

export class MusicStyleEngine {
  createPlan(input: { language: SupportedSingerLanguage; mood?: SingerMood; style?: SingerStyle; duration?: SongDuration }): SongPlan {
    const mood = input.mood || "CALM";
    const base = MOOD_DEFAULTS[mood];
    const style = input.style || base.style;
    const duration = input.duration || "SHORT";
    const sections = duration === "SHORT" ? ["Intro", "Verse 1", "Chorus", "Outro"] : duration === "MEDIUM" ? ["Intro", "Verse 1", "Pre-Chorus", "Chorus", "Verse 2", "Final Chorus", "Outro"] : ["Intro", "Verse 1", "Pre-Chorus", "Chorus", "Verse 2", "Chorus", "Bridge", "Final Chorus", "Outro"];
    return { ...base, style, duration, language: input.language, sections };
  }
}

export const musicStyleEngine = new MusicStyleEngine();

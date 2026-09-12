import type { LyricsDocument, SongPlan, SupportedSingerLanguage } from "./SingerTypes";

export class LyricsManager {
  validateUserLyrics(text: string, language: SupportedSingerLanguage): LyricsDocument {
    const normalized = text.trim();
    if (!normalized) throw new Error("LYRICS_EMPTY: Please provide lyrics for SARA to sing.");
    if (normalized.length > 12000) throw new Error("LYRICS_TOO_LONG: User-provided lyrics exceed the supported length.");
    return { source: "USER_PROVIDED", language, text: normalized, sections: this.splitSections(normalized) };
  }

  createOriginalPlan(plan: SongPlan, theme: string): { plan: SongPlan; prompt: string } {
    return { plan, prompt: `Create original ${plan.language} lyrics about ${theme || "the user's request"}. Use only these sections: ${plan.sections.join(", ")}. Keep a ${plan.duration.toLowerCase()} song length. Do not imitate any real singer or copyrighted song.` };
  }

  fromGeneratedText(text: string, plan: SongPlan): LyricsDocument {
    const normalized = text.trim();
    if (!normalized) throw new Error("LYRICS_GENERATION_EMPTY: The lyrics service returned no lyrics.");
    return { source: "ORIGINAL", language: plan.language, text: normalized, sections: this.splitSections(normalized) };
  }

  private splitSections(text: string): Array<{ name: string; text: string }> {
    const matches = [...text.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)];
    if (!matches.length) return [{ name: "Lyrics", text }];
    return matches.map((match, index) => ({ name: match[1].trim(), text: text.slice(match.index! + match[0].length, matches[index + 1]?.index ?? text.length).trim() }));
  }
}

export const lyricsManager = new LyricsManager();

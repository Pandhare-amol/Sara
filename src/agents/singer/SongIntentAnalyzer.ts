import type { SingerIntentResult, SingerIntent, SupportedSingerLanguage, SingerMood, SingerStyle, SongDuration } from "./SingerTypes";

const singingPattern = /\b(sing|singing|song|melody|melodic|lyrics|गाना|गाओ|गाऊ|गायन|गाणे|गा)\b/i;
const controlPatterns: Array<[SingerIntent, RegExp]> = [
  ["STOP_SINGING", /\b(stop|cancel|end)\b.*\b(sing|song|music|audio)|\b(stop singing)\b/i],
  ["PAUSE_SINGING", /\b(pause|hold)\b.*\b(sing|song|music)|\bpause\b/i],
  ["RESUME_SINGING", /\b(resume|continue)\b.*\b(sing|song|music)|\bcontinue singing\b/i],
  ["CHANGE_STYLE", /\b(change|make|switch)\b.*\b(style|genre|instrument|acoustic|lofi|rock|pop)\b/i],
  ["CHANGE_MOOD", /\b(make|change)\b.*\b(mood|energetic|calm|relaxing|romantic|sad)\b/i],
];

function detectLanguage(text: string): SupportedSingerLanguage {
  if (/\b(marathi|मराठी)\b/i.test(text)) return "mr";
  if (/\b(hindi|हिंदी)\b/i.test(text)) return "hi";
  if (/[\u0900-\u097F]/.test(text)) return /\b(मराठी|marathi)\b/i.test(text) ? "mr" : "hi";
  return "en";
}
function detectMood(text: string): SingerMood | undefined {
  const moods: Array<[SingerMood, RegExp]> = [["MOTIVATIONAL", /motiv|achiev|goal|success|प्रेरणा/i], ["CALM", /calm|peace|शांत/i], ["RELAXING", /relax|sleep|soothing/i], ["ROMANTIC", /romantic|love|प्रेम/i], ["SAD", /sad|heartbreak/i], ["ENERGETIC", /energetic|energy|dance/i], ["DEVOTIONAL", /devotional|भक्ति|भजन/i], ["CINEMATIC", /cinematic|epic/i]];
  return moods.find(([, pattern]) => pattern.test(text))?.[0];
}
function detectStyle(text: string): SingerStyle | undefined {
  const styles: Array<[SingerStyle, RegExp]> = [["LOFI", /lofi|lo-fi/i], ["SOFT_ACOUSTIC", /acoustic|soft/i], ["PIANO", /piano/i], ["ORCHESTRAL", /orchestra/i], ["INDIAN_FUSION", /indian|भारतीय/i], ["POP", /pop/i], ["ROCK", /rock/i], ["AMBIENT", /ambient/i]];
  return styles.find(([, pattern]) => pattern.test(text))?.[0];
}
function detectDuration(text: string): SongDuration {
  if (/full|complete|long|2\s*(-|to)\s*4\s*minute/i.test(text)) return "FULL";
  if (/medium|1\s*minute|90\s*second/i.test(text)) return "MEDIUM";
  return "SHORT";
}

export class SongIntentAnalyzer {
  analyze(request: string): SingerIntentResult {
    const text = request.trim();
    for (const [intent, pattern] of controlPatterns) if (pattern.test(text)) return { intent, confidence: 0.98, language: detectLanguage(text), duration: "SHORT", request: text };
    if (!singingPattern.test(text)) return { intent: "NONE", confidence: 0.99, language: detectLanguage(text), duration: "SHORT", request: text };
    const userLyrics = /\b(these lyrics|my lyrics|provided lyrics|lyrics below)\b/i.test(text) ? text.replace(/.*?\b(?:these lyrics|my lyrics|provided lyrics|lyrics below)\b[:\s]*/i, "").trim() : undefined;
    const intent: SingerIntent = userLyrics ? "SING_USER_LYRICS" : /\b(create|generate|original|make)\b/i.test(text) ? "GENERATE_SONG" : /\b(play)\b/i.test(text) ? "PLAY_EXISTING_AUDIO" : "SING_ORIGINAL";
    return { intent, confidence: 0.92, language: detectLanguage(text), mood: detectMood(text), style: detectStyle(text), duration: detectDuration(text), userLyrics, request: text };
  }
}

export const songIntentAnalyzer = new SongIntentAnalyzer();

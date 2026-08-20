import { getMemoryRepository, type MemoryRecord } from "./MemoryRepository";

export interface LocalMemoryCommandResult {
  handled: boolean;
  memory?: MemoryRecord;
  response?: string;
  forgotten?: boolean;
}

const EXPLICIT_MEMORY_PATTERNS: Array<{
  category: string;
  key: string;
  pattern: RegExp;
  valueIndex: number;
}> = [
  { category: "identity", key: "name", pattern: /\b(?:remember\s+)?my\s+name\s+is\s+(.+?)[.!?]?$/i, valueIndex: 1 },
  { category: "identity", key: "age", pattern: /\b(?:remember\s+)?i\s+am\s+(\d{1,3})\s+years?\s+old[.!?]?$/i, valueIndex: 1 },
  { category: "identity", key: "city", pattern: /\b(?:remember\s+)?i\s+(?:live|stay)\s+in\s+(.+?)[.!?]?$/i, valueIndex: 1 },
  { category: "preference", key: "preference", pattern: /\b(?:remember\s+)?i\s+(?:prefer|like|love)\s+(.+?)[.!?]?$/i, valueIndex: 1 },
  { category: "project", key: "project", pattern: /\b(?:remember\s+)?(?:my|the)\s+project\s+is\s+(.+?)[.!?]?$/i, valueIndex: 1 },
];

function cleanValue(value: string): string {
  return value.trim().replace(/[.!?]+$/, "").trim();
}

export async function handleLocalMemoryCommand(text: string): Promise<LocalMemoryCommandResult> {
  const normalized = text.trim();
  if (!normalized) return { handled: false };

  const forgetMatch = normalized.match(/\bforget\s+(?:that\s+)?(?:my\s+)?(name|age|city|preference|project)\b/i);
  if (forgetMatch) {
    const key = forgetMatch[1].toLowerCase();
    const matches = await getMemoryRepository().searchMemory(key, 20);
    const candidates = matches.filter((memory) => memory.key === key || memory.category === key);
    await Promise.all(candidates.map((memory) => getMemoryRepository().deleteMemory(memory.id)));
    return {
      handled: true,
      forgotten: true,
      response: candidates.length ? `Understood. I forgot that ${key} information.` : `I don't have a saved ${key} memory to forget.`,
    };
  }

  for (const rule of EXPLICIT_MEMORY_PATTERNS) {
    const match = normalized.match(rule.pattern);
    if (!match) continue;
    const value = cleanValue(match[rule.valueIndex]);
    if (!value) return { handled: false };

    const existing = (await getMemoryRepository().searchMemory(`${rule.key} ${value}`, 20))
      .find((memory) => memory.key === rule.key || memory.category === rule.category);
    const memory = await getMemoryRepository().saveMemory({
      id: existing?.id,
      category: rule.category,
      key: rule.key,
      value,
      importance: 9,
      confidence: 1,
      source: "explicit_user_instruction",
      metadata: {
        userConfirmed: true,
        offline: true,
      },
    });
    return {
      handled: true,
      memory,
      response: `Got it. I'll remember that your ${rule.key} is ${value}.`,
    };
  }

  return { handled: false };
}

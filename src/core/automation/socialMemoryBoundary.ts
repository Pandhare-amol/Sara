/**
 * The legacy Python social store has no owner-approval bit. Its retrievals
 * cannot become Live context, even when its local ranking calls them relevant.
 * Only approved server_memory records are used in the Live system prompt.
 */
const UNSCOPED_MEMORY_FIELDS = new Set([
  "relevant_memory", "relevant_memories", "approved_memories", "memory", "suggested_prompt",
]);

export function stripUnscopedSocialMemory(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnscopedSocialMemory);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !UNSCOPED_MEMORY_FIELDS.has(key.toLowerCase()))
    .map(([key, nested]) => [key, stripUnscopedSocialMemory(nested)]));
}

/** Never let unapproved Python recall participate in an idle check-in. */
export function withoutLegacySocialRecall(args: Record<string, unknown>): Record<string, unknown> {
  const context = args.context && typeof args.context === "object" && !Array.isArray(args.context)
    ? args.context as Record<string, unknown> : {};
  const { relevant_memory: _memory, ...otherContext } = context;
  return { ...args, context: { ...otherContext, do_not_store: true, privacy_level: "DO_NOT_STORE" } };
}

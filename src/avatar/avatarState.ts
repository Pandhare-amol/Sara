export type SaraEmotion =
  | "idle"
  | "happy"
  | "excited"
  | "curious"
  | "thinking"
  | "proud"
  | "sad"
  | "confused"
  | "surprised"
  | "embarrassed"
  | "playful";

export type AvatarExpression =
  | "neutral"
  | "smile"
  | "laugh"
  | "talking"
  | "thinking"
  | "curious"
  | "surprised"
  | "happy"
  | "concerned"
  | "angry"
  | "confused"
  | "reassuring"
  | "listening"
  | "sleepy"
  | "greeting";

export type AvatarExpressionChoice = "auto" | AvatarExpression;
export type AvatarGesture = "rest" | "wave" | "explain" | "point" | "think" | "listen" | "celebrate" | "nod";
export type AvatarGestureChoice = "auto" | AvatarGesture;
export type AvatarConversationState = "idle" | "listening" | "thinking" | "speaking";
export type AvatarLiveState = "disconnected" | "connecting" | "listening" | "speaking";
export type AvatarCharacterState = "idle" | "thinking" | "talking";

export interface AvatarPresentation {
  state: AvatarConversationState;
  expression: AvatarExpression;
  gesture: AvatarGesture;
}

const EXPRESSION_FOR_EMOTION: Record<SaraEmotion, AvatarExpression> = {
  idle: "neutral",
  happy: "happy",
  excited: "happy",
  curious: "curious",
  thinking: "thinking",
  proud: "smile",
  sad: "concerned",
  confused: "confused",
  surprised: "surprised",
  embarrassed: "smile",
  playful: "laugh",
};

/**
 * Map existing conversation signals to presentation only. It does not inspect
 * the user's face, voice identity, or private environment.
 */
export function resolveAvatarPresentation(
  liveState: AvatarLiveState,
  characterState: AvatarCharacterState,
  activeEmotion: SaraEmotion,
  expressionChoice: AvatarExpressionChoice = "auto",
  gestureChoice: AvatarGestureChoice = "auto",
): AvatarPresentation {
  const state: AvatarConversationState = liveState === "speaking" || characterState === "talking"
    ? "speaking"
    : liveState === "connecting" || characterState === "thinking"
      ? "thinking"
      : liveState === "listening"
        ? "listening"
        : "idle";

  const expression = expressionChoice !== "auto"
    ? expressionChoice
    : state === "thinking"
      ? "thinking"
      : state === "listening"
        ? "listening"
        : EXPRESSION_FOR_EMOTION[activeEmotion] || "neutral";

  const automaticGesture: AvatarGesture = expression === "greeting"
    ? "wave"
    : expression === "laugh"
      ? "celebrate"
      : state === "thinking"
        ? "think"
        : state === "listening"
          ? "listen"
          : state === "speaking"
            ? "explain"
            : "rest";

  return {
    state,
    expression,
    gesture: gestureChoice === "auto" ? automaticGesture : gestureChoice,
  };
}

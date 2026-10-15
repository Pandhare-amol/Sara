const NON_RETRYABLE_TOOLS = new Set([
  "deleteFile",
  "deleteFilePermanent",
  "requestPowerAction",
  "executePowerAction",
  "closeAllApplications",
  "whatsapp_send",
  "whatsappSend",
  "whatsapp_reply",
  "whatsappReply",
  "whatsapp_group_send",
  "whatsapp_send_media",
  "email_send",
  "emailSend",
  "youtube_upload",
  "youtubeUpload",
]);

export interface RetryDecision {
  allowed: boolean;
  reason?: string;
}

export function evaluateRetryPolicy(
  tool: string,
  explicitlyConfirmed = false,
): RetryDecision {
  if (!NON_RETRYABLE_TOOLS.has(tool)) {
    return { allowed: true };
  }

  if (explicitlyConfirmed) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Retrying '${tool}' is blocked because the operation may be destructive or externally visible. Explicit confirmation is required.`,
  };
}

export function isNonRetryableTool(tool: string): boolean {
  return NON_RETRYABLE_TOOLS.has(tool);
}

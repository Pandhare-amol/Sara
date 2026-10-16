/** Small transport receipt only: not a claim that any UI action succeeded. */
export function validSharedJpeg(frame: unknown): frame is string {
  if (typeof frame !== "string" || frame.length < 16 || frame.length > 1_500_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame)) return false;
  const jpeg = Buffer.from(frame, "base64");
  return jpeg.length >= 10 && jpeg.length <= 1_100_000 && jpeg[0] === 0xff && jpeg[1] === 0xd8 &&
    jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9;
}

export function sharedScreenStatus(lastReceivedAt: number, now = Date.now()): {
  frame_received: boolean; fresh_frame: boolean; frame_age_ms: number | null; basis: string;
} {
  const age = lastReceivedAt > 0 ? Math.max(0, now - lastReceivedAt) : null;
  return { frame_received: age !== null, fresh_frame: age !== null && age < 6_000,
    frame_age_ms: age, basis: "authorized_client_frame_transport_only_not_action_verification" };
}

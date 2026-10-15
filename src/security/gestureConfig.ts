const CONFIG_KEYS = new Set(["min_confidence", "frames_required", "calibration"]);
const CALIBRATION_KEYS = new Set([
  "camera_center",
  "camera_top_left",
  "camera_top_right",
  "camera_bottom_left",
  "camera_bottom_right",
  "screen_top_left",
  "screen_top_right",
  "screen_bottom_left",
  "screen_bottom_right",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validate the small, supported gesture configuration surface before it reaches a desktop agent. */
export function sanitizeGestureConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Gesture config must be a JSON object.");
  const unknownKeys = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) throw new Error(`Unsupported gesture config field: ${unknownKeys[0]}.`);

  const config: Record<string, unknown> = {};
  if (Object.hasOwn(value, "min_confidence")) {
    const confidence = value.min_confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("min_confidence must be a number between 0 and 1.");
    }
    config.min_confidence = confidence;
  }

  if (Object.hasOwn(value, "frames_required")) {
    const frames = value.frames_required;
    if (typeof frames !== "number" || !Number.isInteger(frames) || frames < 1 || frames > 60) {
      throw new Error("frames_required must be an integer between 1 and 60.");
    }
    config.frames_required = frames;
  }

  if (Object.hasOwn(value, "calibration")) {
    const calibration = value.calibration;
    if (!isRecord(calibration)) throw new Error("calibration must be a JSON object.");
    const sanitizedCalibration: Record<string, [number, number]> = {};
    for (const [key, point] of Object.entries(calibration)) {
      if (!CALIBRATION_KEYS.has(key)) throw new Error(`Unsupported calibration point: ${key}.`);
      if (!Array.isArray(point) || point.length !== 2 || point.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) {
        throw new Error(`Calibration point '${key}' must contain exactly two finite numbers.`);
      }
      const [x, y] = point as [number, number];
      const maximum = key.startsWith("camera_") ? 1 : 16_384;
      if (x < 0 || x > maximum || y < 0 || y > maximum) {
        throw new Error(`Calibration point '${key}' is outside its supported coordinate range.`);
      }
      sanitizedCalibration[key] = [x, y];
    }
    if (Object.keys(sanitizedCalibration).length === 0) throw new Error("calibration must include at least one named point.");
    config.calibration = sanitizedCalibration;
  }

  if (Object.keys(config).length === 0) throw new Error("Gesture config must include at least one supported setting.");
  return config;
}

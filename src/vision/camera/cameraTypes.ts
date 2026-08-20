export type CameraStatus =
  | "CAMERA_UNAVAILABLE"
  | "CAMERA_PERMISSION_REQUIRED"
  | "CAMERA_READY"
  | "CAMERA_STARTING"
  | "CAMERA_ACTIVE"
  | "CAMERA_STOPPING"
  | "CAMERA_ERROR"
  | "CAMERA_DISCONNECTED";

export interface CameraDevice {
  id: string;
  label: string;
}

export interface CameraSnapshot {
  status: CameraStatus;
  deviceId?: string;
  error?: string;
}

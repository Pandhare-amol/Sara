import type { CameraDevice, CameraSnapshot, CameraStatus } from "./cameraTypes";

export class CameraManager {
  private stream: MediaStream | null = null;
  private snapshot: CameraSnapshot = { status: "CAMERA_READY" };
  onStatusChange?: (snapshot: CameraSnapshot) => void;

  get status(): CameraSnapshot {
    return { ...this.snapshot };
  }

  async listDevices(): Promise<CameraDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      this.setStatus("CAMERA_UNAVAILABLE", "Camera API is unavailable.");
      return [];
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "videoinput")
      .map((device) => ({ id: device.deviceId, label: device.label || device.deviceId }));
  }

  async start(deviceId?: string): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setStatus("CAMERA_UNAVAILABLE", "Camera API is unavailable.");
      throw new Error(this.snapshot.error);
    }

    this.setStatus("CAMERA_STARTING");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      track.onended = () => {
        this.stream = null;
        this.setStatus("CAMERA_DISCONNECTED", "The camera was disconnected.");
      };
      this.setStatus("CAMERA_ACTIVE", undefined, track.getSettings().deviceId || deviceId);
      return stream;
    } catch (error: any) {
      const permissionDenied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      this.setStatus(
        permissionDenied ? "CAMERA_PERMISSION_REQUIRED" : "CAMERA_ERROR",
        permissionDenied ? "Camera permission was denied." : error?.message || String(error),
      );
      throw error;
    }
  }

  stop(): void {
    if (!this.stream) {
      this.setStatus("CAMERA_READY");
      return;
    }
    this.setStatus("CAMERA_STOPPING");
    this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.setStatus("CAMERA_READY");
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  private setStatus(status: CameraStatus, error?: string, deviceId?: string): void {
    this.snapshot = { status, error, deviceId };
    this.onStatusChange?.(this.status);
  }
}

/**
 * Audio handling utility for Sara Live API Voice stream.
 * Handles:
 * - 16kHz layout sampling for microphone stream.
 * - Raw Little Endian Int16 PCM translation.
 * - 24kHz layout output sampling for model voice playback.
 * - Gapless double-buffer queue scheduler.
 * - Interrupt signal immediate stop.
 * - Input & Output AnalyserNodes for real-time waveform visuals.
 */

import { VoiceActivityGate } from "./voiceActivityGate";
import { VoicePlaybackPolicy, playbackIsStale } from "./voicePlaybackPolicy";

export type LiveState = "disconnected" | "connecting" | "listening" | "speaking";

// PCM Conversion Helper: converts Float32Array [-1.0, 1.0] to signed Int16 Raw PCM Little Endian
function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

// Float conversion helper: converts signed Int16 array buffer to Float32Array [-1.0, 1.0]
function pcm16ToFloats(uint8Array: Uint8Array): Float32Array {
  const int16 = new Int16Array(
    uint8Array.buffer,
    uint8Array.byteOffset,
    uint8Array.byteLength / 2
  );
  const floats = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    floats[i] = int16[i] / 32768.0;
  }
  return floats;
}

// Convert ArrayBuffer to Base64 String
function base64ArrayBuffer(arrayBuffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Convert Base64 string to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function buildLiveConnectionQuery(
  conversationId?: string | null,
  speakerProfile?: { userId?: string; displayName?: string } | null,
  voicePreferences?: { assistantVoiceGender?: "female" | "male"; relationshipStyle?: string } | null,
): string {
  const params = new URLSearchParams();
  if (conversationId) params.set("conversationId", conversationId);
  if (speakerProfile && (speakerProfile.userId || speakerProfile.displayName)) {
    params.set("speakerProfile", JSON.stringify({
      userId: speakerProfile.userId || "local-user",
      displayName: speakerProfile.displayName || "Local User",
    }));
  }
  if (voicePreferences) {
    params.set("voicePreferences", JSON.stringify({
      assistantVoiceGender: voicePreferences.assistantVoiceGender === "male" ? "male" : "female",
      relationshipStyle: typeof voicePreferences.relationshipStyle === "string" ? voicePreferences.relationshipStyle.slice(0, 32) : "friend",
    }));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const LIVE_RECONNECT_MAX_ATTEMPTS = 5;

export function getLiveReconnectDelay(attempt: number, random = Math.random): number {
  const boundedAttempt = Math.max(1, Math.min(30, Math.floor(Number(attempt) || 1)));
  const baseDelay = Math.min(1000 * 2 ** (boundedAttempt - 1), 16_000);
  const jitter = Math.floor(Math.max(0, Math.min(0.999, random())) * 250);
  return baseDelay + jitter;
}

export class SaraAudioSession {
  private ws: WebSocket | null = null;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private stableSessionTimer: number | null = null;
  private lastConversationId: string | null = null;
  
  // Audios contexts (separate to match exact required sample rates)
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  
  // Audio sources & processors
  private micStream: MediaStream | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micProcessorNode: ScriptProcessorNode | null = null;
  private micSilenceGainNode: GainNode | null = null;
  private readonly voiceActivityGate = new VoiceActivityGate({ sensitivity: 55, attackFrames: 2, hangoverFrames: 18 });
  
  // Visualisers
  public inputAnalyser: AnalyserNode | null = null;
  public outputAnalyser: AnalyserNode | null = null;
  private outputGainNode: GainNode | null = null;
  
  // Buffering / Playback details
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private readonly playbackPolicy = new VoicePlaybackPolicy();
  
  // State Callbacks
  private onStateChange: (state: LiveState) => void;
  private onTranscription: (role: "user" | "model", text: string) => void;
  private onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
  private onError: (error: string) => void;
  private onMemorySync?: (memories: any[]) => void;
  private onDesktopEvent?: (event: any) => void;
  private onAutomationEvent?: (event: any) => void;
  private onWake?: (info: { phrase?: string; confidence?: number } ) => void;
  private onTurnComplete?: () => void;
  
  private currentState: LiveState = "disconnected";
  private isActivated = false;
  private muted: boolean = false;

  constructor(handlers: {
    onStateChange: (state: LiveState) => void;
    onTranscription: (role: "user" | "model", text: string) => void;
    onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
    onError: (error: string) => void;
    onMemorySync?: (memories: any[]) => void;
    onDesktopEvent?: (event: any) => void;
    onAutomationEvent?: (event: any) => void;
    onWake?: (info: { phrase?: string; confidence?: number }) => void;
    onTurnComplete?: () => void;
  }) {
    this.onStateChange = handlers.onStateChange;
    this.onTranscription = handlers.onTranscription;
    this.onToolCall = handlers.onToolCall;
    this.onError = handlers.onError;
    this.onMemorySync = handlers.onMemorySync;
    this.onDesktopEvent = handlers.onDesktopEvent;
    this.onAutomationEvent = handlers.onAutomationEvent;
    this.onWake = handlers.onWake;
    this.onTurnComplete = handlers.onTurnComplete;
  }

  private setState(state: LiveState) {
    this.currentState = state;
    this.onStateChange(state);
  }

  public setMuted(v: boolean) {
    this.muted = v;
    this.voiceActivityGate.reset();
    this.micStream?.getAudioTracks().forEach((track) => { track.enabled = !v; });
  }

  public toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public getState(): LiveState {
    return this.currentState;
  }

  /**
   * Pushes a compressed JPEG base64 screenshot frame directly to the live WebSocket server.
   */
  public sendVideoFrame(base64Data: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== "disconnected") {
      this.ws.send(JSON.stringify({ type: "video", video: base64Data }));
    }
  }

  public screenShareStopped() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "screen_share_stopped" }));
  }

  // Requests microphone and creates connections.
  public async connect(conversationId?: string | null) {
    if (this.isActivated) return;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    if (this.stableSessionTimer !== null) {
      window.clearTimeout(this.stableSessionTimer);
      this.stableSessionTimer = null;
    }
    this.lastConversationId = conversationId ?? null;
    this.playbackPolicy.reset();
    await this.openConnection();
  }

  private async openConnection() {
    if (!this.shouldReconnect || this.isActivated) return;
    this.isActivated = true;
    this.setState("connecting");

    try {
      // 1. Establish custom WebSocket server bridge
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const storedConv = this.lastConversationId ?? window.localStorage.getItem("sara.conversationId");
      let voicePreferences: { assistantVoiceGender?: "female" | "male"; relationshipStyle?: string } = {};
      try {
        const settingsRaw = window.localStorage.getItem("sara.settings.v2");
        const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
        voicePreferences = {
          assistantVoiceGender: settings?.assistantVoiceGender === "male" ? "male" : "female",
          relationshipStyle: typeof settings?.relationshipStyle === "string" ? settings.relationshipStyle : "friend",
        };
      } catch {
        voicePreferences = { assistantVoiceGender: "female", relationshipStyle: "friend" };
      }
      const wsQuery = buildLiveConnectionQuery(storedConv, null, voicePreferences);
      const socket = new WebSocket(`${protocol}//${window.location.host}/live${wsQuery}`);
      this.ws = socket;
      socket.binaryType = "blob";

      socket.onopen = async () => {
        console.log("[Sara] Connected to server side WS bridge");
        try {
          // Guard against a user disconnect or a newer retry while audio setup awaits permissions.
          if (!this.isActivated || this.ws !== socket) return;

          // Safe, cross-browser AudioContext initialization
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          if (!AudioContextClass) {
            throw new Error("Holographic audio link unsupported: Web Audio API missing in browser.");
          }

          this.inputAudioCtx = new AudioContextClass({ sampleRate: 16000, latencyHint: 'interactive' });
          this.outputAudioCtx = new AudioContextClass({ sampleRate: 24000, latencyHint: 'interactive' });

          // Ensure Audio Contexts are active and resumed to bypass browser security blocks
          if (this.inputAudioCtx.state === "suspended") {
            await this.inputAudioCtx.resume().catch(() => {});
          }
          if (this.outputAudioCtx.state === "suspended") {
            await this.outputAudioCtx.resume().catch(() => {});
          }
          
          // Setup custom output Analyser & Volume Gains
          this.outputGainNode = this.outputAudioCtx.createGain();
          this.outputAnalyser = this.outputAudioCtx.createAnalyser();
          this.outputAnalyser.fftSize = 256;
          this.outputAnalyser.smoothingTimeConstant = 0.8;
          
          this.outputGainNode.connect(this.outputAnalyser);
          this.outputAnalyser.connect(this.outputAudioCtx.destination);
          
          // Obtain User Microphone layout
          let preferredMicId = "";
          try {
            const settingsRaw = window.localStorage.getItem("sara.settings.v2");
            preferredMicId = settingsRaw ? String(JSON.parse(settingsRaw)?.micDeviceId || "") : "";
          } catch {
            preferredMicId = "";
          }
          const audioConstraints: MediaTrackConstraints = {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(preferredMicId ? { deviceId: { exact: preferredMicId } } : {}),
          };
          let stream: MediaStream;
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
          } catch (error) {
            // A previously selected device may have been unplugged or its ID
            // may have changed. Keep voice usable by falling back to default.
            if (!preferredMicId) throw error;
            stream = await navigator.mediaDevices.getUserMedia({
              audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            this.onError("The selected microphone is unavailable; using the system default.");
          }

          // Safeguard: Check if we disconnected while waiting for user to grant mic permissions
          if (!this.isActivated || this.ws !== socket || !this.inputAudioCtx || !this.outputAudioCtx) {
            stream.getTracks().forEach((track) => {
              try {
                track.stop();
              } catch (e) {}
            });
            return;
          }

          this.micStream = stream;
          stream.getAudioTracks().forEach((track) => { track.enabled = !this.muted; });

          // Setup custom input Analyser
          this.inputAnalyser = this.inputAudioCtx.createAnalyser();
          this.inputAnalyser.fftSize = 256;
          
          this.micSourceNode = this.inputAudioCtx.createMediaStreamSource(this.micStream);
          this.micSourceNode.connect(this.inputAnalyser);

          // 256 samples @ 16 kHz is about 16 ms of audio per chunk. Smaller
          // chunks reduce capture latency while the local VAD suppresses noise.
          this.micProcessorNode = this.inputAudioCtx.createScriptProcessor(256, 1, 1);
          this.micSilenceGainNode = this.inputAudioCtx.createGain();
          this.micSilenceGainNode.gain.value = 0;
          this.micSourceNode.connect(this.micProcessorNode);
          this.micProcessorNode.connect(this.micSilenceGainNode);
          this.micSilenceGainNode.connect(this.inputAudioCtx.destination);
          this.voiceActivityGate.reset();

          this.micProcessorNode.onaudioprocess = (e) => {
            if (this.currentState === "disconnected" || this.currentState === "connecting") return;
            if (this.muted) return;
            const channelData = e.inputBuffer.getChannelData(0);
            const gated = this.voiceActivityGate.process(channelData);
            if (gated.started && this.currentState === "speaking") this.stopSpeaking();
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

            // Preserve the live stream's silence timing with zeroed PCM frames;
            // background sound below the speech threshold is never forwarded.
            for (const frame of gated.frames) {
              const pcmBuffer = floatTo16BitPCM(frame);
              this.ws.send(JSON.stringify({ audio: base64ArrayBuffer(pcmBuffer) }));
            }
          };

          // Sound setups are fully functional
          this.setState("listening");

        } catch (audioError: any) {
          console.error("Audio Context or Microphone Initialization Failed:", audioError);
          this.onError(`Permission error: ${audioError.message || "Microphone required for holographic Live link."}`);
          this.disconnect();
        }
      };

      socket.onmessage = async (event) => {
        if (this.ws !== socket) return;
        try {
          const data = JSON.parse(event.data);

          if (data.type === "security_alert") {
            window.dispatchEvent(new CustomEvent("sara.securityAlert", { detail: {
              message: String(data.message || "Repeated invalid admin authentication attempts detected."),
              severity: String(data.severity || "WARNING"),
            } }));
            return;
          }

          if (data.type === "confirmation_required") {
            window.dispatchEvent(new CustomEvent("sara.confirmationRequired", { detail: data }));
            return;
          }

          if (data.type === "global_notification") {
            window.dispatchEvent(new CustomEvent("sara.globalNotification", { detail: { ...data, source: data.source || "automation" } }));
            return;
          }

          // Root Error Handler message
          if (data.type === "error") {
            this.onError(data.error);
            this.disconnect();
            return;
          }

          // Wake event from server: notify app to start capture/play ack
          if (data.type === 'wake') {
            try {
              if (this.onWake) this.onWake({ phrase: data.phrase, confidence: data.confidence });
            } catch (e) {}
            return;
          }

          if (data.type === "singer:control") {
            window.dispatchEvent(new CustomEvent("sara.singerControl", { detail: data }));
            return;
          }

          // Handle server-side states
          if (data.type === "status") {
            console.log("[Sara WS Status]:", data.status);
            // Persist conversation id sent by server for future reconnect attempts
            if (data.conversationId) {
              try { window.localStorage.setItem("sara.conversationId", String(data.conversationId)); } catch {}
            }
            if (data.status === "connecting_gemini") {
              // Wait for Gemini Live connection
            } else if (data.status === "connected") {
              if (this.stableSessionTimer !== null) window.clearTimeout(this.stableSessionTimer);
              this.stableSessionTimer = window.setTimeout(() => {
                this.reconnectAttempts = 0;
                this.stableSessionTimer = null;
              }, 30_000);
              this.onError("");
              this.setState("listening");
            } else if (data.status === "session_closed") {
              this.scheduleReconnect(socket, "The live session closed unexpectedly.");
            }
            return;
          }

          // Handle audio payload (24kHzPCM model response)
          if (data.type === "audio" && data.audio && this.playbackPolicy.shouldPlay(data.turn)) {
            this.playAudioPCMChunk(data.audio);
          }

          // Handle interruption signal (e.g. user talked over Sara)
          if ((data.type === "interrupted" || data.type === "stop_speaking") &&
              this.playbackPolicy.shouldInterrupt(data.turn)) {
            this.playbackPolicy.observeUserTurn(data.turn);
            this.handleInterruption();
          }

          // Turn complete
          if (data.type === "turnComplete" && this.playbackPolicy.shouldInterrupt(data.turn)) {
            this.onTurnComplete?.();
            // Once Sara completes speaking, change visual state back to listening
            setTimeout(() => {
              if (this.activeSources.length === 0 && this.currentState === "speaking") {
                this.setState("listening");
              }
            }, 100);
          }

          // Handle live captions transcription
          if (data.type === "transcription") {
            if (data.role === "user") this.playbackPolicy.observeUserTurn(data.turn);
            this.onTranscription(data.role, data.text);
          }

          // Handle memory synchronization
          if (data.type === "memory_sync" && data.memories) {
            if (this.onMemorySync) {
              this.onMemorySync(data.memories);
            }
          }

          if (data.type === "desktopEvent" && this.onDesktopEvent) {
            this.onDesktopEvent(data);
          }

          if (typeof data.type === "string" &&
              (data.type.startsWith("automation:") || data.type === "RECOVERY_PAUSED") && this.onAutomationEvent) {
            this.onAutomationEvent(data);
          }
          if (data.type === "task:completed" && this.onAutomationEvent) {
            this.onAutomationEvent({ type: "automation:completed", task: data.task });
          }

          if (data.type === "vision_action") {
            window.dispatchEvent(new CustomEvent("sara-camera-action", {
              detail: {
                action: data.action === "start" ? "startCamera" : data.action === "stop" ? "stopCamera" : data.action === "analyze" ? "analyzeVision" : "statusVision",
                question: data.question,
              },
            }));
          }

          // Handle Tool Calling
          if (data.type === "toolCall") {
            const { callId, name, args } = data;
            this.onToolCall(name, args, (result) => {
              // Send back execution result to server bridge
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                  type: "toolResponse",
                  id: callId,
                  name: name,
                  output: result
                }));
              }
            });
          }

        } catch (parseError) {
          console.error("Error reading server packet:", parseError);
        }
      };

      socket.onerror = (wsError) => {
        console.error("WebSocket transport error:", wsError);
        this.scheduleReconnect(socket, "Voice connection was interrupted.");
      };

      socket.onclose = () => {
        console.log("WebSocket connection closed");
        this.scheduleReconnect(socket, "Voice connection was interrupted.");
      };

    } catch (e: any) {
      console.error("Connection establish sequence failed:", e);
      this.onError(e.message || "Failed to initialize active channel.");
      this.disconnect();
    }
  }

  /** Stop speech only. No task is cancelled and the microphone remains in its chosen state. */
  public stopSpeaking(): boolean {
    if (this.currentState !== "speaking" && !this.activeSources.length) return false;
    this.stopCurrentPlayback();
    return true;
  }

  private handleInterruption(): void {
    this.stopCurrentPlayback();
  }

  private stopCurrentPlayback(): void {
    const turn = this.playbackPolicy.stop();
    for (const source of this.activeSources) {
      try { source.stop(); } catch { /* already ended */ }
    }
    this.activeSources = [];
    this.nextStartTime = 0;
    if (this.currentState !== "disconnected") this.setState("listening");
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "stop_speaking", turn }));
  }

  // Direct raw PCM chunk scheduled playback at 24kHz
  private playAudioPCMChunk(base64Audio: string) {
    if (!this.outputAudioCtx || !this.outputGainNode) return;
    if (playbackIsStale(this.nextStartTime - this.outputAudioCtx.currentTime, this.activeSources.length)) {
      this.stopCurrentPlayback();
      this.onError("Speech playback fell behind and this turn was stopped rather than speaking stale audio. Ask SARA to repeat it.");
      return;
    }

    try {
      this.setState("speaking");
      const uint8Array = base64ToUint8Array(base64Audio);
      const floats = pcm16ToFloats(uint8Array);

      // Create AudioBuffer of 24000Hz (the exact playback sample rate of Gemini outputs)
      const buffer = this.outputAudioCtx.createBuffer(1, floats.length, 24000);
      buffer.getChannelData(0).set(floats);

      // Create Buffer source
      const source = this.outputAudioCtx.createBufferSource();
      source.buffer = buffer;

      // Connect source to gain which is routed to analyser & speakers
      source.connect(this.outputGainNode);

      const currentTime = this.outputAudioCtx.currentTime;
      
      // Gapless scheduler sync
      if (this.nextStartTime < currentTime) {
        // Start fresh: 5ms ahead to minimize first-chunk latency (was 30ms)
        this.nextStartTime = currentTime + 0.005;
      }

      source.start(this.nextStartTime);
      this.nextStartTime += buffer.duration;

      // Keep reference to handle real-time interruptions
      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index > -1) {
          this.activeSources.splice(index, 1);
        }
        
        // If there are no more active play nodes, revert state back to listening
        if (this.activeSources.length === 0 && this.currentState === "speaking") {
          this.setState("listening");
        }
      };

      this.activeSources.push(source);

    } catch (playbackError) {
      console.error("PCM Chunk buffering/playback failed:", playbackError);
    }
  }

  private scheduleReconnect(socket: WebSocket, reason: string) {
    if (!this.shouldReconnect || this.ws !== socket || this.reconnectTimer !== null) return;

    this.ws = null;
    this.isActivated = false;
    if (this.stableSessionTimer !== null) {
      window.clearTimeout(this.stableSessionTimer);
      this.stableSessionTimer = null;
    }
    try { if (socket.readyState < WebSocket.CLOSING) socket.close(); } catch {}
    this.releaseAudioResources();

    if (this.reconnectAttempts >= LIVE_RECONNECT_MAX_ATTEMPTS) {
      this.shouldReconnect = false;
      this.setState("disconnected");
      this.onError(`${reason} Automatic retry stopped after ${LIVE_RECONNECT_MAX_ATTEMPTS} attempts. Reconnect manually when ready.`);
      return;
    }

    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    const delay = getLiveReconnectDelay(attempt);
    this.onError(`${reason} Reconnecting (${attempt}/${LIVE_RECONNECT_MAX_ATTEMPTS})…`);
    this.setState("connecting");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openConnection();
    }, delay);
  }

  private releaseAudioResources() {
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => {
        try { track.stop(); } catch {}
      });
      this.micStream = null;
    }
    if (this.micProcessorNode) {
      try { this.micProcessorNode.disconnect(); } catch {}
      this.micProcessorNode = null;
    }
    if (this.micSourceNode) {
      try { this.micSourceNode.disconnect(); } catch {}
      this.micSourceNode = null;
    }
    if (this.micSilenceGainNode) {
      try { this.micSilenceGainNode.disconnect(); } catch {}
      this.micSilenceGainNode = null;
    }
    this.voiceActivityGate.reset();
    if (this.inputAudioCtx) {
      try { void this.inputAudioCtx.close(); } catch {}
      this.inputAudioCtx = null;
    }
    if (this.outputAudioCtx) {
      try { void this.outputAudioCtx.close(); } catch {}
      this.outputAudioCtx = null;
    }
    this.activeSources = [];
    this.nextStartTime = 0;
    this.playbackPolicy.reset();
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.outputGainNode = null;
  }

  /** Explicit user disconnect: stop the retry loop and release all device resources. */
  public disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stableSessionTimer !== null) {
      window.clearTimeout(this.stableSessionTimer);
      this.stableSessionTimer = null;
    }
    this.isActivated = false;
    const socket = this.ws;
    this.ws = null;
    try { socket?.close(); } catch {}
    this.releaseAudioResources();
    this.setState("disconnected");
  }
}


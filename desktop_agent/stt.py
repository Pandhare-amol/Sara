"""STT provider abstractions for the SARA desktop agent.

This module provides a simple pluggable interface and lightweight
local providers that will be used by the agent to transcribe audio.

Providers:
- LocalWhisperSTT: uses `whisper` (openai-whisper) if available.
- LocalVoskSTT: uses `vosk` if available.

Implementations are best-effort: they attempt to import optional
dependencies and raise a clear error if none are available.
"""
from __future__ import annotations
import os
from typing import Optional

class STTProvider:
    """Abstract STT provider."""
    def transcribe_file(self, path: str) -> str:
        raise NotImplementedError()


class LocalWhisperSTT(STTProvider):
    def __init__(self, model: str = "small"):
        try:
            import whisper  # type: ignore
        except Exception as e:
            raise RuntimeError("openai-whisper is not installed") from e
        self._whisper = whisper
        self.model_name = model
        self.model = None

    def _ensure_model(self):
        if self.model is None:
            self.model = self._whisper.load_model(self.model_name)

    def transcribe_file(self, path: str) -> str:
        self._ensure_model()
        res = self.model.transcribe(path)
        return res.get("text", "") if isinstance(res, dict) else str(res)


class LocalVoskSTT(STTProvider):
    def __init__(self, model_path: Optional[str] = None):
        try:
            from vosk import Model, KaldiRecognizer  # type: ignore
            import wave
        except Exception as e:
            raise RuntimeError("vosk is not installed") from e
        self.Model = Model
        self.KaldiRecognizer = KaldiRecognizer
        self.wave = wave
        self.model_path = model_path
        if self.model_path and not os.path.exists(self.model_path):
            raise RuntimeError(f"Vosk model path not found: {self.model_path}")

    def transcribe_file(self, path: str) -> str:
        wf = self.wave.open(path, "rb")
        if wf.getnchannels() != 1 or wf.getsampwidth() != 2:
            raise RuntimeError("Vosk requires mono 16-bit WAV input")
        model = self.Model(self.model_path) if self.model_path else self.Model("model")
        rec = self.KaldiRecognizer(model, wf.getframerate())
        results = []
        while True:
            data = wf.readframes(4000)
            if len(data) == 0:
                break
            if rec.AcceptWaveform(data):
                import json
                r = json.loads(rec.Result())
                results.append(r.get("text", ""))
        # final
        try:
            import json
            fr = json.loads(rec.FinalResult())
            results.append(fr.get("text", ""))
        except Exception:
            pass
        return " ".join([r for r in results if r])


def detect_provider() -> STTProvider:
    """Return the first-available provider instance (best-effort)."""
    # Prefer whisper if available
    try:
        p = LocalWhisperSTT(model=os.environ.get("SARA_WHISPER_MODEL", "small"))
        return p
    except Exception:
        pass
    try:
        # Allow env var to specify VOSK_MODEL_PATH
        p = LocalVoskSTT(model_path=os.environ.get("SARA_VOSK_MODEL_PATH"))
        return p
    except Exception:
        pass
    raise RuntimeError("No local STT provider is available. Install openai-whisper or vosk.")


if __name__ == "__main__":
    # Simple CLI test runner: python -m desktop_agent.stt path/to/file.wav
    import sys
    if len(sys.argv) < 2:
        print("Usage: python -m desktop_agent.stt /path/to/file.wav")
        sys.exit(2)
    p = None
    try:
        p = detect_provider()
    except Exception as e:
        print("No provider available:", e)
        sys.exit(3)
    path = sys.argv[1]
    print("Transcribing:", path)
    try:
        print(p.transcribe_file(path))
    except Exception as e:
        print("Transcription failed:", e)
        raise

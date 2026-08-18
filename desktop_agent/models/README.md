STT model assets
----------------

Place local STT model files (e.g., Vosk model folders or Whisper extracted
weights) under this directory if you want the PyInstaller bundle to
include them. For Vosk, store the model directory and set
`SARA_VOSK_MODEL_PATH` to the bundled path at runtime.

Example:

- `desktop_agent/models/vosk-en-us-0.22`
- `desktop_agent/models/whisper-small`

Packaging note: including large model files increases the installer size.
Prefer offering model download during installer or first-run provisioning.

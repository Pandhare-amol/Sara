"""E2E test helper: POST a WAV to the agent STT endpoint and print the result.

Usage:
  python tests/e2e/test_stt_transcribe.py /path/to/sample.wav

The test will exit 0 on success (agent returns ok:true), non-zero otherwise.
"""
import sys
import requests
import os

def main():
    if len(sys.argv) < 2:
        print("Usage: python tests/e2e/test_stt_transcribe.py /path/to/sample.wav")
        sys.exit(2)
    path = sys.argv[1]
    if not os.path.exists(path):
        print("File not found:", path)
        sys.exit(3)
    url = os.environ.get("SARA_AGENT_URL", "http://127.0.0.1:8765/stt/transcribe")
    with open(path, "rb") as f:
        files = {"file": (os.path.basename(path), f, "audio/wav")}
        try:
            r = requests.post(url, files=files, timeout=60)
        except Exception as e:
            print("Request failed:", e)
            sys.exit(4)
    try:
        j = r.json()
    except Exception:
        print("Invalid JSON response", r.status_code, r.text[:400])
        sys.exit(5)
    print("Response:", j)
    if j.get("ok"):
        print("Transcript:", j.get("result", {}).get("transcript"))
        sys.exit(0)
    else:
        print("STT error:", j.get("error"))
        sys.exit(6)

if __name__ == "__main__":
    main()

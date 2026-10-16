"""E2E test helper: POST a WAV to the agent STT endpoint and print the result.

Usage:
  python tests/e2e/test_stt_transcribe.py /path/to/sample.wav

The test will exit 0 on success (agent returns ok:true), non-zero otherwise.
"""
import sys
import requests
import os
from urllib.parse import urlparse

def main():
    if len(sys.argv) < 2:
        print("Usage: python tests/e2e/test_stt_transcribe.py /path/to/sample.wav")
        sys.exit(2)
    path = sys.argv[1]
    if not os.path.exists(path):
        print("File not found:", path)
        sys.exit(3)
    url = os.environ.get("SARA_AGENT_URL", "http://127.0.0.1:8765/stt/transcribe")
    parsed = urlparse(url)
    is_loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if not is_loopback and parsed.scheme != "https":
        print("Remote agent URLs must use HTTPS.")
        sys.exit(7)
    token = os.environ.get("SARA_AGENT_INTERNAL_TOKEN", "") if is_loopback else os.environ.get("SARA_AGENT_ACCESS_TOKEN", os.environ.get("SARA_REMOTE_ACCESS_TOKEN", ""))
    if len(token.encode("utf-8")) < 32:
        print("Set the matching SARA_AGENT_INTERNAL_TOKEN (or remote SARA_AGENT_ACCESS_TOKEN) before running this test.")
        sys.exit(7)
    headers = {"X-SARA-Agent-Token": token}
    with open(path, "rb") as f:
        files = {"file": (os.path.basename(path), f, "audio/wav")}
        try:
            r = requests.post(url, files=files, headers=headers, timeout=60)
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

Porcupine keyword files
-----------------------

Place Picovoice/Porcupine `.ppn` keyword files in this folder to enable
the `PorcupineWake` listener. Porcupine keywords are licensed artifacts —
you must obtain them from Picovoice (https://picovoice.ai) or build your
own via their tooling.

Recommended steps:

1. Obtain a keyword `.ppn` file for your target platform and language.
2. Copy the keyword file to `data/porcupine/keyword.ppn` (or update
   `server` settings to point to a custom path).
3. Optionally provide a model file and set `modelPath` in wake settings.

Automated provisioning (best-effort):

- Optionally set the environment variable `PORCUPINE_KEYWORD_URL` to a
  direct URL (HTTPS) pointing at a `.ppn` file. Then run
  `scripts/provision-porcupine.ps1` to download it.

Security note: treat keyword files as licensed assets; do not commit
private/company keywords to source control.

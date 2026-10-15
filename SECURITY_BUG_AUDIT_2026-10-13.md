# SARA repository audit — 2026-10-13

## Executive summary

The repository has several release-blocking security and correctness issues. The most urgent are: (1) an unauthenticated backend that listens on all interfaces and exposes desktop-control and private-data routes; (2) a same-origin HTML proxy that can load attacker-controlled script into an unsandboxed SARA iframe, alongside an SSRF path; and (3) tracked runtime credentials and private application state. The first-run API-key form is also wired to a handler that never saves the key.

The advertised closed-loop desktop automation is not implemented by the planner, while acceptance tests permit a planning-only result and mark unexecuted desktop checks as passed. The persistence tests also write into the repository's normal memory directory and, in the run performed for this audit, deleted two tracked backups before cleanup restored them.

No source-code fixes were made. Test-generated tracked changes and data artifacts were restored/removed; the audit report is the only intended new repository file. Secret values were not printed or copied into this report.

### Severity and confidence

- **Critical / P0:** unauthenticated control or code execution with potentially severe impact, assuming the service is reachable.
- **High / P1:** serious security exposure or core product behavior is broken/misrepresented.
- **Medium / P2:** significant reliability, data-integrity, or feature defect.
- **Low / P3:** documentation or maintenance issue.

“Confirmed” means the behavior is evident in checked-in code, configuration, or a local test run. It does not mean a remote exploit was executed. Deployment reachability, credential validity, dependency exploitability, and Windows installer behavior still need verification where noted.

## Findings

### SARA-01 — Critical: unauthenticated backend control plane is bound to all interfaces

**Status:** Confirmed in code. Impact depends on network reachability and deployment firewalling.

`server_full.ts` is the active backend (`package.json` uses it for `dev`, `build`, and `start`) and listens on `0.0.0.0` (`server_full.ts:4788`). There is no global authentication middleware. Examples of exposed routes include settings read/write (`server_full.ts:974–990`), shutdown (`1455–1469`), companion pairing (`2029–2050`), confirmation request/verification (`2137–2180`), and admin audit/statistics (`1401–1425`). The `/live` WebSocket upgrade accepts connections by path without an origin or identity check (`3312–3324`).

The confirmation flow is not a trusted approval boundary: an unauthenticated caller can submit arbitrary `action`/`args`, receive the newly minted confirmation token in the response, then submit that token to `/api/confirm/verify`, which dispatches the stored action to `callDesktopAgent` (`2137–2180`). Admin checks also fail open when no admin token is configured (`1401–1419`, `3255–3266`); the helper returns `true` if no key exists and also returns `true` on exceptions.

**Impact:** Any client that can reach the service may read or change application state, access private content, trigger available desktop actions, create confirmations for its own actions, or stop the backend. The exact reachable operations depend on the configured tools and secrets, but the lack of an authentication boundary is confirmed.

**Recommended action:** Bind to loopback by default. Add authentication and authorization to every API and WebSocket route, including “admin” routes; fail closed when credentials are missing or validation errors occur. Add CSRF/origin protections for browser-facing state changes, rate limits, and explicit trusted-user confirmation for consequential actions. Do not rely on CORS as authentication.

### SARA-02 — Critical: web proxy combines SSRF with same-origin script execution

**Status:** Code-level issue confirmed; exploit chain not dynamically tested.

`GET /api/proxy` fetches the caller-supplied URL without visible private/loopback address filtering (`server_full.ts:2825–2838`). `/api/web-proxy` performs only protocol/hostname-format checks; a dotted private IP passes that check, and the fetch follows redirects without revalidating the destination (`2915–2953`). It returns remote HTML from the SARA origin, injects a script, and removes Content-Security-Policy and X-Frame-Options (`3029–3046`). The corresponding `BrowserAgent` iframe has no `sandbox` attribute (`src/components/BrowserAgent.tsx:1049–1055`). Its parent also accepts `NAVIGATE` messages without validating `event.origin` or `event.source` (`271–277`).

**Impact:** A malicious page loaded through the proxy can execute as same-origin SARA content and make same-origin requests to the unauthenticated API. Separately, the server can be induced to fetch internal/private network URLs, creating an SSRF path. The reach and impact depend on what networks the host can access and whether a user opens attacker-controlled content.

**Recommended action:** Remove or tightly constrain server-side fetching; reject loopback, private, link-local, and reserved IPs after DNS resolution and on every redirect; cap response size/time and restrict content types. Isolate proxied browsing on a separate origin and use a restrictive iframe sandbox that does not grant same-origin privileges. Validate both origin and source for every `postMessage` handler.

### SARA-03 — High: tracked credentials and private runtime data

**Status:** Tracked artifacts confirmed. Whether each credential/session is still valid is unverified.

The repository tracks `logs/android_devices.json` with 19 plaintext device-token fields; a comparison found all 19 fields share the same non-empty token (value deliberately not shown). Tracked key files include `data/.sara_vault.key`, `logs/.sara_vault.key`, and `logs/.android_companion.key` (44 bytes each). A tracked Chromium profile includes a Cookies SQLite database with 11 rows and about 199 profile files (~21 MB). Runtime databases/logs are tracked as well; for example, `data.db` contains conversation, memory, and tool-call records. Their contents were not reproduced in this report.

**Impact:** Anyone with access to the repository or a distributed clone may obtain credential material or private application state. Removing files from the current tree alone would not remove them from Git history or already distributed copies.

**Recommended action:** Revoke/reissue companion tokens, rotate the tracked keys, and invalidate browser sessions where applicable. Move runtime state into a per-user, ignored data directory; remove these artifacts from Git and assess history/distribution. Add secret scanning and a repository test that rejects committed runtime databases, browser profiles, and keys. Treat the values as exposed until their validity is checked.

### SARA-04 — High: API-key onboarding ignores the submitted key and returns conversation data

**Status:** Confirmed in code.

The active `POST /api/config/apikey` handler (`server_full.ts:1245–1279`) never reads `req.body.apiKey` and never calls `setGeminiApiKey`. Instead, it reads and returns the desktop or mobile conversations file (`1270–1274`). The active `ApiKeyGate` submits the key and considers any successful response setup success (`src/components/ApiKeyGate.tsx:48–56`).

**Impact:** A clean install cannot configure its Gemini key through the first-run UI; the gate may appear to complete until reload, while the backend remains unconfigured. The route also returns conversation data to its caller rather than a key-save status. This is especially serious because the route has no authentication.

**Recommended action:** Implement a dedicated key-save path that validates and securely persists the key, returns only a minimal status, and never returns conversation data. Add an integration test proving the stored-key status changes after submission and remains true after restart.

### SARA-05 — High: “closed-loop” planner is a placeholder and acceptance tests pass without execution

**Status:** Confirmed in source and local test output.

`ClosedLoopExecutor.planTask()` always returns a plan with `subgoals: []` (`src/services/ClosedLoopExecutor.ts:559–573`), and `attemptFinalRecovery()` unconditionally returns `true` as a placeholder (`548–553`). The acceptance test treats `PLANNING` as a pass (`tests/real-desktop/closed-loop-acceptance.ts:280–285`). In the test run for this audit, the closed-loop case reported `PLANNING`, zero actions, and zero observations while passing. The real Notepad test says the automation “would execute here” and returns passed without opening or verifying anything (`411–427`); default-disabled real-desktop checks are also counted as passed.

**Impact:** Green acceptance results do not demonstrate task execution or verification. Product/readiness claims for autonomous desktop control are not supported by these checks.

**Recommended action:** Implement planning and recovery or explicitly label them experimental. Require an actual verified terminal state for success. Represent skipped tests as `SKIPPED`, not passed, and make real-desktop tests perform observable actions and assertions before reporting success.

### SARA-06 — High: dependency audit reports vulnerabilities in production dependencies

**Status:** Confirmed by `npm audit`; exploitability in this application was not assessed.

The full lockfile audit reported **30 vulnerabilities** (2 critical, 11 high, 16 moderate, 1 low). The production-only audit reported **13** (2 critical, 4 high, 6 moderate, 1 low). The reported affected dependency set includes `@capacitor/android` (critical advisory), `electron` (high), `nodemailer` (high), `express`, `node-notifier`, and the production transitive dependency `proxy-addr` (critical advisory). Locked versions observed include `@capacitor/android` 8.5.0, Electron 43.1.0, Nodemailer 9.0.5, and Express 4.22.2. No dependency fixes were applied during the audit.

**Recommended action:** Triage the advisories against the exact locked versions and reachable features, upgrade affected packages/lockfile, then rerun the full and production audits plus desktop/mobile builds. Avoid force-updating without testing breaking changes.

### SARA-07 — Medium/High: persistence tests write into normal application data and rotate real backups

**Status:** Confirmed in code and observed in the local test run.

`tests/persistence-learning.test.ts` constructs a test persistence service with `test_data/memories`, but the `LearningWorkflowCoordinator` is constructed without the persistence config (`34–42`). The coordinator constructs its own `MemoryPersistenceService` (`src/services/LearningWorkflowCoordinator.ts:51–60`), whose default data directory is `process.cwd()/data/memories` (`src/services/MemoryPersistenceService.ts:59–70`). Backup rotation deletes older files beyond the default ten-backup limit (`434–446`); test cleanup removes only `test_data` (`45–50`).

Running `npm run test:all` wrote runtime snapshots/exports/backups under `data/memories/` and deleted two tracked backups: `memories-1787190744846.json` and `memories-1787190744856.json`. Those effects were restored/removed after the run; the working tree was clean before creating this report.

**Impact:** Running the test suite against a developer checkout can alter or delete real memory data and backups.

**Recommended action:** Inject a temporary directory into every persistence service/coordinator used by tests. Assert the path is under the test temp directory, and fail tests if they touch repository `data/`.

### SARA-08 — Medium: camera/vision UI is out of sync with the active server; large video uploads fail

**Status:** Confirmed in code.

The active frontend (`main.tsx` renders `src/App.tsx`) calls `/api/vision/enable`, `/api/vision/disable`, and `/api/vision/state` from `src/components/CameraPanel.tsx:265–295, 370–380`. Those routes exist in legacy `server.ts`, but not in active `server_full.ts` (which defines screen-capture/analyze routes instead). The enable handler also marks local vision state enabled whenever `fetch()` resolves, even for an HTTP 404.

Additionally, `server_full.ts:828` uses Express’s default JSON-body size limit, while the camera UI base64-encodes complete video blobs into JSON (`CameraPanel.tsx:182–205`). Ordinary recordings can exceed the default 100 KB request limit; the spread into `String.fromCharCode(...bytes)` can also exceed argument limits for large recordings.

**Impact:** Gesture/continuous-vision state polling is nonfunctional against the active backend, and video saves can fail on larger recordings.

**Recommended action:** Port or remove the stale vision routes and check `response.ok` before changing UI state. Upload media as multipart/streamed binary with an explicit bounded size limit; avoid spreading a large typed array into a function call.

### SARA-09 — Medium: companion pairing uses incompatible token formats/registries

**Status:** Confirmed in code; end-to-end mobile behavior not run.

The Node pairing endpoint stores only a scrypt hash and salt in `data/companions.json` (`server_full.ts:2029–2047`). However, `/api/conversations?source=mobile` and `/api/mobile/upload-image` compare `c.token === token` (`2660–2668`, `2561–2565`), so a newly paired hashed record cannot satisfy those checks. The Python companion manager is a separate registry under `logs/` and stores plaintext tokens (`desktop_agent/android_companion.py:28–41, 67–70`); the Node pairing handler does not register the device there. The Python pairing endpoint also supplies a shared default token when one is omitted (`desktop_agent/main.py:337–341`).

**Impact:** Newly paired devices are likely to fail mobile conversation/image flows and may not be known to the Python command service. The default token is unsafe if that pairing endpoint is reachable.

**Recommended action:** Use one registry and one token-verification helper across all companion routes. Store only salted hashes, remove the shared default, require an authenticated pairing ceremony, and test pair → sync → upload → command end to end.

### SARA-10 — Medium: Electron and Python-agent packaging paths/names disagree

**Status:** Path/name mismatch confirmed; installer outcome not verified because a Windows package build was not run.

The checked-in executable is `agent_dist/myraa-agent/myraa-agent.exe`. Electron expects `agent_dist/sara-agent/sara-agent.exe` in development and `resources/agent/sara-agent.exe` when packaged (`electron/main.cjs:182–199`); `electron-builder.yml:22–25` copies `agent_dist/sara-agent`. The PowerShell build helper invokes PyInstaller on `desktop_agent/main.py` without `--name sara-agent` and does not use `desktop_agent.spec` (`scripts/build-windows-agent.ps1:38–51`). The spec itself declares the name `sara-agent` (`desktop_agent.spec:125–150`), but the helper does not invoke it.

**Impact:** The build may place `main.exe` in the expected directory while the runtime looks for `sara-agent.exe`; the packaged desktop agent may therefore be absent and desktop automation may not start.

**Recommended action:** Choose one executable name/path, use the spec or pass an explicit PyInstaller name, and add a packaging smoke test that inspects the installer resources and starts the bundled executable.

### SARA-11 — Medium: lint does not type-check the active backend

**Status:** Confirmed in config and source.

`npm run lint` runs `tsc --noEmit`, but `tsconfig.json` includes `server.ts` and omits `server_full.ts`. The active app scripts use `server_full.ts` (`package.json:9–11, 19`). The build's esbuild step transpiles/bundles that file but is not a TypeScript type-check. For example, `appendLog` requires two arguments (`server_full.ts:116`) but is called with one at `450`; the intended forensic payload logging therefore cannot work as written, and the type error is not caught by the current lint command.

`npm test` only runs the AGI suite (19 tests). `npm run test:all` runs only the autonomous acceptance and persistence suites, not every repository test. This leaves important backend and packaging paths outside the normal quality gate.

**Recommended action:** Add `server_full.ts` to a dedicated backend TypeScript check and make that check mandatory in lint/build. Correct the malformed logging call, and define a test command that covers the actual active backend and package contracts.

### SARA-12 — Medium: confirmation-list route is registered only after posting a memory

**Status:** Confirmed in code.

`GET /api/confirm/list` is declared inside the `POST /api/memories` handler (`server_full.ts:909–936`). Express therefore does not register it at startup; it becomes available only after a memory POST, and is re-registered on subsequent posts. `ConfirmationPanel` requests it on load (`src/components/ConfirmationPanel.tsx:12`).

**Impact:** The confirmation panel can receive a 404 on a fresh session or before any memory is added.

**Recommended action:** Move the route declaration to the top-level route registration block and add a startup-level route test.

### SARA-13 — Low: README install/build instructions describe missing or stale commands

**Status:** Confirmed against the checkout.

The README uses a placeholder clone URL and then changes into a nested path that is not this repository (`README.md:96–107`). It tells users to install root `requirements.txt`, but only `desktop_agent/requirements.txt` exists. It also documents `npm run generate-integrity-manifest` (`219`, `287`), which is not a `package.json` script; the active server returns 501 for the related integrity verification/baseline endpoints (`server_full.ts:1393–1399`).

**Recommended action:** Update the setup path, Python requirements path, and script table to match working commands; either restore the integrity workflow or remove claims/instructions for it.

## Validation performed

| Check | Result | Qualification |
|---|---|---|
| `npm ci --ignore-scripts --no-audit --fund=false` | Passed | Installed 550 packages; install scripts were intentionally disabled. |
| `npm run lint` | Passed | Does not include active `server_full.ts`; see SARA-11. |
| `npm test` | Passed, 19/19 | AGI suite only. |
| `npm run test:all` | Passed, 8/8 acceptance + 18/18 persistence | Three real-desktop checks were skipped but counted as passes; test also modified normal memory data. |
| `npm run build` | Passed | Vite warned that the minified UI chunk (526.92 kB) exceeds the 500 kB warning threshold; server bundle was 564.0 kB. |
| `npm audit --audit-level=high` | Reported 30 vulnerabilities | Exit status 1 reflects audit findings. Production-only audit reports 13. |
| `python -m compileall -q desktop_agent src tests` | Passed syntax compilation | Python runtime/unit tests were not run: system interpreter lacks `pytest`, `fastapi`, `pydantic`, `cryptography`, and `uvicorn`. |

## Risks that still need verification

1. **Network exposure:** Confirm actual firewall, bind address, and deployment topology. Code binds to all interfaces, but remote reachability depends on host/network controls.
2. **Credential status and history:** Confirm whether tracked keys/tokens/cookies are live and whether Git history or distributed releases contain additional sensitive artifacts. Treat as exposed until rotated.
3. **Proxy exploitability:** No live SSRF or browser-XSS test was performed. The dangerous code path is present; validate in an isolated test environment after remediation.
4. **Dependency reachability:** `npm audit` confirms advisories for locked packages, not that each vulnerable code path is reachable in this app.
5. **Windows packaging:** The installer and bundled Python executable were not built or launched on Windows; SARA-10 is a strong configuration mismatch, not an observed failed installer.
6. **Shell/path handling:** `desktop_agent/tools_files.py:188–199` passes a request-derived folder path into a Windows shell command with `shell=True` and does not call `_ensure_safe`. I did not prove a usable Windows command-injection path (the directory must exist and Windows path-character rules constrain quoting); use an argument-list launch and validate the path rather than treating this as a confirmed exploit.

## Suggested remediation order

1. **Immediately:** bind the backend to loopback; enforce fail-closed authentication/authorization across HTTP and WebSocket routes; remove self-issued confirmation; rotate tracked credentials and invalidate sessions.
2. **Before external or shared-network use:** isolate proxied browsing, sandbox the iframe, and enforce strict SSRF destination/redirect controls.
3. **Before calling the app production-ready:** fix API-key onboarding, implement or clearly disable placeholder automation, correct persistence-test isolation, and restore the missing active vision routes.
4. **Before release:** remediate production dependency advisories, align Electron/PyInstaller paths, and make active-backend type-checking plus real packaging tests part of CI.

## Follow-up remediation status (working tree, 2026-10-15)

This section maps the original findings to the current working tree. Statements above such as “No source-code fixes were made” describe the original 2026-10-13 audit snapshot, not the current remediation state.

| Finding | Current status | Evidence / remaining qualification |
|---|---|---|
| SARA-01 | **Remote exposure mitigated in code; deployment still unverified** | Backend defaults to loopback; non-loopback binds require a 32-character token and TLS; `/api` checks Host/Origin and requires the remote token; `/live` accepts loopback clients only; admin confirmation/list routes fail closed. Actual firewall, reverse-proxy, and network reachability are not verified here. |
| SARA-02 | **Code remediation present; no live exploit test** | Both proxy routes use DNS-validated, address-pinned `fetchPublicUrl` with bounded bytes/time and redirect revalidation. The preview iframe has an opaque-origin sandbox; message handling checks source and origin. Unit tests cover private/reserved addresses and mixed DNS answers. |
| SARA-03 | **Unresolved; approval needed for repository cleanup** | `.gitignore` now excludes runtime directories for future additions, but the current Git index still tracks private runtime artifacts, including key files, a Chromium profile/cookies, databases, companion-token records, conversations, and logs. Existing files were not removed or rotated. The hygiene test intentionally blocks while these paths remain tracked. Credential validity and Git-history exposure remain unverified; rotate/invalidate affected credentials and sessions. |
| SARA-04 | **Fixed in code** | API-key onboarding validates the submitted value with Google, stores it through the private `secrets.json` path, and returns status only. Storage/permissions are covered by `tests/api/gemini-key-storage.test.ts`. |
| SARA-05 | **False-success behavior fixed; planner capability remains unavailable** | The general closed-loop planner throws before desktop actions; final recovery cannot claim success without verification. Acceptance checks now report opt-in desktop tests as `SKIPPED`, not passed. This does not implement a general planner. |
| SARA-06 | **Dependency audit currently clear** | `npm audit --audit-level=high` reported 0 vulnerabilities for the current lockfile. |
| SARA-07 | **Fixed in tests** | Persistence coordinators receive temporary data roots, and the suite asserts those roots are isolated from repository `data/`. `npm run test:persistence` passed 19/19 in the current run. |
| SARA-08 | **Large-upload fix and safe UI contract fixed; gesture capability remains unavailable** | Active `server_full.ts` contains the vision and bounded raw-WebM routes; the camera and gesture panels check HTTP/application failures and do not report failed config saves as success. Gesture config/mapping writes are narrowly routed and admin-authorized. The checked-in Python agent has no `gestureControl*` or `getVisionState` handlers, so gesture operations fail closed until that capability is implemented; no live camera/device was exercised. |
| SARA-09 | **Active registry/token mismatch fixed; mobile end-to-end unverified** | Node and Python use the shared `SARA_DATA_DIR/companions.json` registry and compatible salted scrypt hashes; routes use the verifier and no shared default pairing token is supplied. Pair/sync/upload/command was not exercised on a real mobile device. The old tracked plaintext registry remains part of SARA-03. |
| SARA-10 | **Path contract fixed; Windows package not executed** | Electron, builder config, PyInstaller spec/helper use `sara-agent`; a static package contract and Windows smoke-test script exist. The installer/agent smoke test still needs a Windows build environment. |
| SARA-11 | **Active backend type-check fixed** | `npm run lint` includes `tsconfig.backend.json` for `server_full.ts`; lint and the production build passed. The normal suite now includes security/API/voice/closed-loop/persistence categories, but it does not execute every test file in the repository. |
| SARA-12 | **Fixed and startup-tested** | `/api/confirm/list` is registered at startup. `tests/security/confirmation-route.test.ts` passed, including checks for unauthenticated listing and removal of the self-issued token endpoint. |
| SARA-13 | **Documentation corrected** | Setup paths, Python requirements path, available integrity script, and the fact that runtime integrity enforcement is disabled now match the checkout. |

### Follow-up validation

- `npm run lint` and `npm run build` passed; Vite still reports the existing >500 kB UI chunk-size warning.
- Focused security/project/gesture tests passed 27/27; the confirmation startup integration test passed 1/1; closed-loop tests passed 9/9; persistence tests passed 19/19.
- `npm audit --audit-level=high` reported 0 vulnerabilities.
- `tests/security/tracked-runtime-data.test.ts` remains a deliberate failing repository-hygiene gate until SARA-03 is approved and addressed. The outstanding remediation is to remove sensitive runtime artifacts from the index while preserving local copies, then handle already-exposed credentials and Git history separately.
- In addition, corrupted or unsupported `general-projects.json` files now fail closed; project/task mutations leave the source file byte-for-byte unchanged on parse/schema errors. `src/services/LocalProjectManager.test.ts` passed 4/4.

The audit did not establish a confirmed command-injection exploit in `desktop_agent/tools_files.py`; its Windows shell/path concern remains an unverified lead, not a confirmed finding.

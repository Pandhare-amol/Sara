# SARA interactive 3D companion

## What is implemented

The main visualizer now defaults to a browser-rendered Three.js character built from separate 3D meshes and an articulated hierarchy. It is a procedural, stylized approximation of the supplied visual direction: navy patterned saree, red-orange/gold edging, jewelry, long dark hair, bindi, and a gentle facial shape. The existing chat, voice session, and MP4 files remain in place. **The MP4 clips are only an optional legacy fallback; they are not a 3D model.** The portrait PNG is not used as the 3D character.

The current procedural character is an early visual prototype, not a production character asset. Body parts are mostly rigid mesh segments attached to named bones; there is no skinned mesh with painted weights, professional facial rig, cloth simulation, or externally-authored animation. Expression controls adjust the available geometry and facial groups. Do not describe this as a completed production rig.

## State, interaction, and voice

- `src/avatar/avatarState.ts` maps the existing live/character state and emotion into a presentation state. The existing user-initiated SARA voice flow is unchanged.
- The character has idle sway, periodic blinking, pointer-following gaze, camera orbit/zoom, state-based expression/gesture poses, and on-screen expression/gesture selectors. It does not inspect a camera feed or infer the user's identity/emotion.
- For SARA speech, the renderer reads only the already-created `SaraAudioSession.outputAnalyser`. An RMS amplitude estimate drives a smoothed mouth-opening amount. This is **audio-energy approximation**, not word-, phoneme-, or viseme-level lip-sync. No new microphone is opened by the avatar. Listening/input analyser data is not used to animate the mouth.
- When the existing live state stops being `speaking` (including an interruption), the mouth target returns toward closed. The voice session remains the authority for playback and interruption.
- `SaraAvatar3D` owns its WebGL renderer, `ResizeObserver`, camera controls, animation loop, and GPU resource cleanup. Pixel ratio is capped for mobile-class devices. Browsers without WebGL can use the visible “Existing video fallback” control.
- The fallback shows the original `/assets/idle.mp4`, `thinking.mp4`, and `talking.mp4`; these remain optional video media and do not satisfy the 3D model/rig requirement.

## Replaceable character asset boundary

`src/avatar/avatarDriver.ts` defines `SaraAvatarDriver` (`root`, `update(pose)`, and `dispose()`). `createProceduralSaraAvatarDriver()` is the current implementation. This keeps the Three.js stage and UI independent from a future authored character, while making clear that an external asset adapter is not yet supplied.

A future licensed model can be added in a separate increment:

1. Obtain or commission a SARA-compatible character with explicit usage rights. Review the source/license before adding it; no third-party character asset is bundled here.
2. Author/export a GLB from Blender (or an equivalent DCC tool) with applied transforms, feet at the origin, a documented forward axis, sensible scale, and optimized texture sizes. Keep the model under `public/models/sara/` only after its provenance and license are recorded.
3. For full behavior, include a documented humanoid skeleton and facial morph targets (at minimum `mouthOpen`, `smile`, and `blink`). Optional authored clips should have stable names for idle, thinking/listening, speaking, wave, and explanation gestures.
4. Implement a separate GLTF-backed `SaraAvatarDriver` using Three.js `GLTFLoader` and, where present, `AnimationMixer`, named bones, and morph-target lookup. Map the current `AvatarDriverPose` fields to those controls; gracefully fall back when a model does not contain a requested clip or morph.
5. Add asset-specific tests and browser/device checks (including mobile WebGL memory, animation transitions, interruption, and disposal) before switching the default factory away from the procedural driver.

Adding a GLB alone will not create a rig or lip-sync: the source model must contain the required skeleton, weights, facial targets and/or authored clips, and the adapter must map them. Phoneme-level lip-sync additionally needs timestamped viseme/phoneme data from the speech service or a separately reviewed speech-analysis component; the current voice API exposes no such data. Clothing simulation and professional animation require separate art/animation work.

## Verification

Avatar unit tests: `npm run test:avatar`. Project TypeScript checks: `npm run lint`. The component needs a WebGL-capable browser for a visual review; automated tests of pose/state logic do not prove cross-device rendering or production model quality.

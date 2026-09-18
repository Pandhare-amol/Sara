# SARA themed character videos

Each animation profile can provide multiple MP4 files for each character state:

- `assets/ui/<theme>/<profile>/idle-1.mp4`
- `assets/ui/<theme>/<profile>/idle-2.mp4`
- `assets/ui/<theme>/<profile>/thinking-1.mp4`
- `assets/ui/<theme>/<profile>/thinking-2.mp4`
- `assets/ui/<theme>/<profile>/talking-1.mp4`
- `assets/ui/<theme>/<profile>/talking-2.mp4`

The `-2` files are optional. The runtime rotates the playlist when a video
finishes and skips files that are unavailable. It then falls back to
`assets/ui/<theme>/<state>.mp4` and finally the default file in `assets/`.

Supported themes are `charcoal`, `celestial`, `violet`, `emerald`, `crimson`, `rose`, and `gold`.
Supported profiles are `classic`, `cinematic`, and `luminous`.

Keep the files muted-friendly and preferably with the same aspect ratio for clean crossfades.

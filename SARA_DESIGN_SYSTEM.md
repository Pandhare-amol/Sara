# SARA Design System Baseline

Date: 2026-08-22
Purpose: preserve the existing SARA identity while adapting layout for mobile. This is an audit specification, not a UI redesign.

## Existing Visual Sources

- Global tokens and fonts: `src/index.css`.
- Primary composition: `src/App.tsx`.
- Core visualizer: `src/components/SaraCoreVisualizer.tsx`.
- Chat: `src/components/DesktopChatPanel.tsx` and `src/components/DesktopConversationsPanel.tsx`.
- Feature panels: memory, settings, browser, camera, gesture, confirmation, WhatsApp, and security components under `src/components/`.
- Icons: `lucide-react`; animation: `motion`.

## Current Tokens

- Display font: Space Grotesk.
- Body font: Inter.
- Monospace font: JetBrains Mono.
- Tailwind CSS theme is imported from `src/index.css`.
- Existing motion includes soft transitions and a restrained floating visualizer animation.
- Existing UI uses a dark, high-contrast technical visual language with luminous accents. Mobile must preserve this hierarchy rather than introduce a generic Android material theme.

## Mobile Preservation Rules

1. Keep the SARA core visualizer, chat language, icon family, status vocabulary, and confirmation patterns.
2. Convert multi-column desktop compositions into a single primary column with bottom sheets or stacked panels only where required by screen width.
3. Preserve readable contrast, focus states, loading/error states, and visible task progress.
4. Keep controls icon-led where the desktop UI already uses icons; retain accessible labels/tooltips for unfamiliar actions.
5. Keep voice state visible as `disconnected`, `connecting`, `listening`, and `speaking`.
6. Never hide confirmation, permission, authentication, or failed-verification states to make the mobile flow look simpler.
7. Do not copy Electron APIs into mobile components. Put platform operations behind services/adapters.
8. Use responsive CSS and shared component contracts before creating mobile-only visual variants.

## Responsive Layout Contract

- Home/core: visualizer remains the primary signal; chat and active task status remain reachable without deep navigation.
- Chat: messages use the existing SARA bubble hierarchy; composer and microphone action remain thumb-accessible.
- Tasks: show status, current step, and truthful result/error; long tasks must remain observable after navigation.
- Camera/vision: permission state, preview, sampling state, and stop control are explicit.
- Settings/profile/memory: preserve existing information architecture and labels; use scrollable sections rather than shrinking text.
- Browser: mobile browser is a separate capability surface; desktop browser tasks must show the target device.

## Accessibility and Device Constraints

- Respect safe areas, keyboard resize, orientation, reduced motion, font scaling, and screen reader labels.
- Use minimum touch targets appropriate to Android platform guidance without changing the visual language.
- Do not use screen width to scale font size continuously; use responsive breakpoints and stable control dimensions.
- Permission prompts must be preceded by concise in-app context and must distinguish denied from permanently denied.

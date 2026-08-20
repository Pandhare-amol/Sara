# SARA Android Companion

This folder contains the Android companion implementation for the SARA desktop agent.

## What is included
- A Kotlin-based companion app with pairing and command exchange with the desktop agent
- A foreground service that can execute queued mobile commands
- Real device helpers for flashlight, brightness, volume, and vibration
- Local-first companion state management with encrypted storage for sensitive data
- Integration into SARA’s mobile-control agent flow through the desktop agent API

## Supported capabilities
- Pairing and device registration
- Queued command execution from SARA
- Flashlight control
- Brightness control
- Volume control
- Vibration feedback
- Local storage of companion state and encrypted secrets

## Current limitations
- Deep SMS, calls, contacts, WhatsApp, Instagram, Telegram, gallery, and file-manager automation require additional Android permissions and, in some cases, platform restrictions or user consent before they can be executed safely.
- The app uses the supported Android APIs available in the current project scope and avoids pretending unsupported automation is available.

## Structure
- core: shared configuration and constants
- communication: API client helpers and command exchange
- features: device control and notification helpers
- MainActivity: connection and status UI
- AutomationService: foreground service for background automation

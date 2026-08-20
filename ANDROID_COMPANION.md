# Android Companion Architecture

## Overview
SARA now includes a modular Android companion layer that can pair with a phone, queue automation commands, and expose a simple command API through the existing desktop agent.

## Modules
- desktop_agent/android_companion.py — device registry and command queue manager
- desktop_agent/android_tools.py — tool handlers registered with the desktop agent
- android_app/ — Android project scaffold with a foreground service and main activity

## Supported command intents
- flashlight
- brightness
- notifications
- sms
- camera

## Next implementation milestones
1. Add authenticated WebSocket transport between SARA and the Android app.
2. Expand the command set to cover calls, contacts, files, and screen automation.
3. Add permission handling, encryption, and audit logging.
4. Build and test the Android app on real hardware.

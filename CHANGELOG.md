# Changelog

## 1.0.2 — 2026-11-05

### Fixed

- **macOS camera/microphone permissions no longer re-prompt on every call.** The main process now asks only while macOS reports `not-determined`; concurrent requests are coalesced, and the renderer caches the result. The macOS build is ad-hoc signed with the unique identifier `com.yaolin.connectall` instead of the generic `Electron` identity, so TCC can remember the app.
- **Mac-to-Mac camera could fail while Mac-to-Windows worked.** Camera and microphone are now requested separately when the combined request fails, so a microphone/device error no longer silently downgrades the call to audio-only. Camera candidates are tried in order, preferring the built-in FaceTime camera and avoiding an iPhone Continuity Camera that another Mac may already be using. A failed camera can be retried with the camera button.
- **Desktop calendar widget could not be closed directly.** The close box was inside the draggable title bar without `-webkit-app-region: no-drag`; the click was swallowed by window dragging. The close box is now a real button and sets `calendar.widget.visible=false`.
- **Language switch appeared to do nothing.** The renderer's `will-navigate` guard blocked `location.reload()`. Reload now goes through a main-process IPC, preserves the active app, reloads the widget/server windows, and applies the language immediately.

### Notes

- The macOS app is ad-hoc signed, not Developer ID signed; Gatekeeper still asks for right-click → Open on first launch.
- If macOS previously remembered the old generic `Electron` permission, remove the old Connect All entry under **System Settings → Privacy & Security → Camera/Microphone** once, then allow 1.0.2 when prompted. Both Macs should run 1.0.2.
- Windows/Linux packages are unchanged in protocol; update both ends for language/widget fixes.

## 1.0.0 — 2026-11-04

Initial public release.

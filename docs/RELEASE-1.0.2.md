# Connect All 1.0.2

Fixes reported on macOS and in the desktop widget / language switch.

## Fixed

- macOS no longer repeatedly asks for camera/microphone permission. Permission is requested only while macOS reports it as undetermined; the build is ad-hoc signed with a stable `com.yaolin.connectall` identity.
- Mac-to-Mac calls no longer lose one camera. Camera and microphone are acquired independently when needed, microphone failure no longer drops video, the built-in camera is preferred over a shared iPhone Continuity Camera, and alternate cameras are tried in order.
- The floating calendar widget's close box now closes it directly.
- The 中文 / English switch now reloads immediately through the main process; active app is preserved, and the widget/server windows update too.

## Install

| Platform | Asset |
|---|---|
| macOS (universal) | `ConnectAll-1.0.2-mac-universal.zip` — unzip, drag to Applications |
| Windows x64 | `ConnectAll-Setup-1.0.2.exe` (or `ConnectAll-Portable-1.0.2.exe`) |
| Linux x64 | `ConnectAll-1.0.2-x86_64.AppImage` (or `.tar.gz`) |

macOS is ad-hoc signed (not notarized); right-click → Open on first launch. If camera/mic permission was previously granted to the old generic `Electron` signature, remove the old entry in **System Settings → Privacy & Security → Camera/Microphone** once, then allow the new app.

Both Macs must run 1.0.2 to get the Mac-to-Mac camera fix. Windows/Linux users should update too for the language/widget fixes.

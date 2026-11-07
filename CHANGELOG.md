# Changelog

## 1.0.3 — 2026-11-05

### Added

- **Embedded bilingual connection guide** in Settings: same Wi-Fi / LAN, different networks over a VPN mesh, and a public VPS. Includes host/guest instructions, firewall notes, pairing recap, and TURN/video caveats.
- **Network inspector** lists every IPv4 interface with a copyable `http://<address>:8787` URL and classifies LAN, bridge and VPN addresses (`utun`, WireGuard, Tailscale, ZeroTier, campus VPN). The guide refreshes automatically and switches to the VPN path when a VPN address is present.
- **One-click relay mode** in the VPN guide, so cross-network links do not waste time on LAN discovery that cannot cross the VPN.
- **Macintosh startup animation**: a 1-bit startup window with a pixel Mac face, segmented progress bar and pinstripe title bar. Click/Escape skips it; `prefers-reduced-motion` is respected; it is CSS-only and removed after boot.

### Fixed

- **Callee could connect but send no microphone/camera tracks.** If the offer arrived while the camera/mic permission prompt or device acquisition was still pending, the transceivers were bound before tracks existed and were never filled. Tracks are now attached after acquisition, so both Macs send audio/video. This is the likely root cause of the “one Mac camera cannot open” report.

### Notes

- A VPN (Tailscale / ZeroTier / campus VPN) makes the two devices reachable but does not guarantee WebRTC traversal. If video is black while chat works, add a TURN server (see the public-server guide).
- Campus VPNs often isolate clients; if two devices on campus VPN still cannot reach each other, use Tailscale, ZeroTier, or a public relay.
- Includes all 1.0.2 fixes: macOS permission prompt behavior, Mac-to-Mac camera fallback, widget close button, and language switching.

## 1.0.2 — 2026-11-05
 — 2026-11-05

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

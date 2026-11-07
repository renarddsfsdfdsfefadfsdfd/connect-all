# Connect All 1.0.3

This release adds a built-in, bilingual way to connect two devices that are on **different networks** through a VPN mesh, plus a Macintosh-style startup animation.

## Added

### Connection guide (Settings → Connection guide)

Three embedded, bilingual paths:

- **Same Wi-Fi / LAN** — one host runs the local relay, the other enters its LAN address.
- **Different networks + VPN** — install Tailscale (same account) or ZeroTier (same network) on both devices, run the relay on the host, and give the guest the host's VPN address. Campus VPNs often isolate clients; use Tailscale/ZeroTier or a public server if peer-to-peer traffic is blocked.
- **Public server** — a VPS with relay + Caddy HTTPS + coturn for fully independent remote operation.

The guide also includes:

- a live **network inspector** with LAN/bridge/VPN IPv4 addresses and copyable `http://…:8787` URLs;
- **Test local relay** / **Test current server**;
- a one-click **relay mode** switch for VPN links;
- firewall notes, pairing recap, and the TURN caveat for black video.

### Macintosh startup

A CSS-only 1-bit startup window with a pixel Mac face, pinstripe title bar, segmented progress bar and dithered desktop. It can be skipped with a click or Escape, respects `prefers-reduced-motion`, and is removed once the renderer is ready.

## Fixed in 1.0.3

- **Callee media race:** if the WebRTC offer was processed while the camera/microphone permission or device acquisition was still pending, the callee bound transceivers before local tracks existed and then sent no audio/video. Local tracks are now attached after acquisition as well as in the offer handler. This is the likely root cause of the Mac-to-Mac “one camera cannot open” symptom.

## Included fixes from 1.0.2

- macOS asks for camera/microphone permission only while undetermined; the build is ad-hoc signed with the stable `com.yaolin.connectall` identity.
- Mac-to-Mac camera failures are handled by acquiring camera/mic separately, preferring the built-in camera over iPhone Continuity Camera, trying alternate cameras, and offering a camera retry.
- The floating calendar widget closes directly from its close box.
- 中文 / English switching reloads through the main process and preserves the active page.

## Install

| Platform | Asset |
|---|---|
| macOS (universal) | `ConnectAll-1.0.3-mac-universal.zip` — unzip, drag to Applications |
| Windows x64 | `ConnectAll-Setup-1.0.3.exe` (or `ConnectAll-Portable-1.0.3.exe`) |
| Linux x64 | `ConnectAll-1.0.3-x86_64.AppImage` (or `.tar.gz`) |

The macOS app is ad-hoc signed, not notarized. Right-click → Open on first launch. Both Macs should run 1.0.3 for the Mac-to-Mac camera fix.

## VPN notes

A VPN only makes the two devices reachable. Video still needs a viable WebRTC path; if chat works but video is black, deploy coturn (or use the public-server path). Do not expose the relay's port 8787 directly to the internet; use Caddy HTTPS or keep it on a private VPN.

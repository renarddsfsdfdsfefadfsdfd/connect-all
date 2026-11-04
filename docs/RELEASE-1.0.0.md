# Connect All 1.0.0

A private desktop hub for long-distance couples, for macOS, Windows and Linux.

## Four apps in one

- **Connect Chat** — end-to-end encrypted messages over LAN or your own relay; offline queue, delivery states, search, unread markers, export.
- **Connect Video** — WebRTC calls; a 1:4 split for watching a movie together; a synced local music player. Media is peer-to-peer; the relay carries signalling only.
- **Connect Calendar** — ICS import (file, URL, paste) with time zones, RRULE, EXDATE and overrides; partner schedule overlay; a floating desktop widget.
- **Connect Intelligence** — opt-in hourly recaps that surface unanswered questions, promises and plans. DeepSeek/Doubao via user-supplied API keys, or a fully local heuristic with no key. Memories stay on your computers.

Also included: a zero-dependency private relay + encrypted backup vault (`server/`) and a separate server-assistant window.

## Install

| Platform | Asset |
|---|---|
| macOS (universal) | `ConnectAll-1.0.0-mac-universal.zip` — unzip, drag to Applications |
| Windows x64 | `ConnectAll-Setup-1.0.0.exe` (or `ConnectAll-Portable-1.0.0.exe`) |
| Linux x64 | `ConnectAll-1.0.0-x86_64.AppImage` (or `.tar.gz`) |

Builds are **unsigned**. macOS: right-click → Open on first launch. Windows: SmartScreen → More info → Run anyway. Linux AppImage: `chmod +x` then run.

The macOS DMG target is kept in the build config but was not built in the sandboxed release environment; use the zip, or run `pnpm dist:dmg` on a normal Mac.

## Verification

- 23/23 core tests (`node test/run.js`): X25519/HKDF/AES-GCM, ICS recurrence/DST, chat store, relay/backup, CI fallback, dual-Session pairing/chat/calendar/backup, offline invitations.
- Two-instance Electron E2E (`node tools/e2e.js`): pairing → encrypted chat → bidirectional WebRTC frames → 1:4 split sync → music layout → hangup → incoming-call auto-open → LAN-only direct chat. The final packaged `.app` passed the same E2E.
- The relay starts from inside the packaged asar and passes `/api/health`.

## Privacy

The relay sees room ids, device names, ciphertext sizes and opaque backup blobs. It does not see messages, calendar data, CI memories or API keys. See `docs/PRIVACY.md` for the threat model and the limits (metadata, local plaintext history, TURN requirements).

## Known limitations

- Unsigned builds; no auto-update.
- Cross-NAT video may need a TURN server (coturn). The relay does not forward media.
- System-audio sharing depends on OS loopback support; the music mode expects both sides to open the same local file.
- No iOS/Android client; one paired device per side.
- The calendar is read-only (ICS import).

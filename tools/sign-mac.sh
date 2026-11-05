#!/bin/bash
# Ad-hoc sign a local Connect All build. This gives macOS TCC a stable bundle
# identity (com.yaolin.connectall) instead of the generic "Electron" identifier,
# so camera/microphone permission is remembered for the build.
set -euo pipefail
APP="${1:-dist/mac-universal/Connect All.app}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENT="$ROOT/build/entitlements.mac.plist"
[ -d "$APP" ] || { echo "app not found: $APP" >&2; exit 1; }
codesign --force --deep --sign - \
  --identifier com.yaolin.connectall \
  --entitlements "$ENT" \
  "$APP"
codesign --verify --deep --strict "$APP"
codesign -dv "$APP" 2>&1 | grep -E "Identifier=|Signature=|Format="

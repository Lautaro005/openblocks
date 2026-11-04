#!/bin/sh
# OpenBlocks installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Lautaro005/openblocks/main/install.sh | sh
#
# Options (after `sh -s --`)
#   --user        macOS: install into ~/Applications instead of /Applications
#   --build       build from source instead of downloading a release (needs git, node, cargo)
#   --restart     open the app when done (used by the in-app update button)
#   --uninstall   remove OpenBlocks (your vaults and ~/.openblocks stay)
#
# What it does
#   macOS  /Applications/OpenBlocks.app (or ~/Applications) + `openblocks` command
#   Linux  ~/.local/opt/openblocks/OpenBlocks.AppImage + app menu entry + `openblocks` command
set -eu

REPO="${OPENBLOCKS_REPO:-Lautaro005/openblocks}"
BRANCH="${OPENBLOCKS_BRANCH:-main}"
BIN_DIR="${OPENBLOCKS_BIN_DIR:-$HOME/.local/bin}"
APP_NAME="OpenBlocks"
OS="$(uname -s)"
ARCH="$(uname -m)"
USER_ONLY=0
BUILD=0
RESTART=0
UNINSTALL=0

c_ink='\033[1m'; c_gold='\033[38;2;232;176;74m'; c_ok='\033[38;2;47;125;70m'; c_dim='\033[2m'; c_off='\033[0m'
say()  { printf "${c_gold}▸${c_off} %s\n" "$1"; }
ok()   { printf "${c_ok}✓${c_off} %s\n" "$1"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_ONLY=1 ;;
    --build) BUILD=1 ;;
    --restart) RESTART=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,16p' "$0" 2>/dev/null || true; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done

case "$OS" in
  Darwin)
    if [ "$USER_ONLY" = 0 ] && [ -w /Applications ]; then APP_DIR="/Applications"; else APP_DIR="$HOME/Applications"; fi
    APP="$APP_DIR/$APP_NAME.app"
    ;;
  Linux)
    APP_DIR="$HOME/.local/opt/openblocks"
    APP="$APP_DIR/OpenBlocks.AppImage"
    DESKTOP_FILE="$HOME/.local/share/applications/openblocks.desktop"
    ICON="$HOME/.local/share/icons/hicolor/512x512/apps/openblocks.png"
    ;;
  *) fail "this script supports macOS and Linux. On Windows run: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" ;;
esac

if [ "$UNINSTALL" = 1 ]; then
  say "Removing $APP_NAME"
  pkill -x openblocks 2>/dev/null || true
  rm -rf "/Applications/$APP_NAME.app" "$HOME/Applications/$APP_NAME.app" 2>/dev/null || true
  rm -f "$BIN_DIR/openblocks"
  if [ "$OS" = "Linux" ]; then rm -rf "$APP_DIR" "$DESKTOP_FILE" "$ICON"; fi
  ok "Done. Your vaults were not touched; settings stay in ~/.openblocks (delete it to start fresh)."
  exit 0
fi

printf "\n  ${c_ink}OpenBlocks${c_off} ${c_dim}— block notes, in your own folder${c_off}\n\n"
need curl

TMP="$(mktemp -d)"
cleanup() {
  if [ -n "${MNT:-}" ]; then hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

install_bundle_mac() { # $1 = folder that contains OpenBlocks.app
  [ -d "$1/$APP_NAME.app" ] || fail "unexpected download contents"
  mkdir -p "$APP_DIR"
  # Quit a running copy so the bundle can be replaced.
  pkill -x openblocks 2>/dev/null && sleep 1 || true
  rm -rf "$APP"
  cp -R "$1/$APP_NAME.app" "$APP"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
}

if [ "$BUILD" = 1 ]; then
  need git; need node; need npm; need cargo
  say "Building from source ($REPO@$BRANCH) — this takes a few minutes"
  git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$TMP/src" >/dev/null 2>&1 || fail "could not clone $REPO"
  (cd "$TMP/src/apps/desktop" && npm ci --silent) || fail "npm ci failed"
  if [ "$OS" = "Darwin" ]; then
    # Signed ad hoc, so macOS can remember what you allow (a vault on a USB drive, say).
    (cd "$TMP/src/apps/desktop" && APPLE_SIGNING_IDENTITY=- npx tauri build --bundles app) || fail "build failed"
    install_bundle_mac "$TMP/src/target/release/bundle/macos"
  else
    (cd "$TMP/src/apps/desktop" && npx tauri build --bundles appimage) || fail "build failed"
    mkdir -p "$APP_DIR"
    cp "$(ls "$TMP"/src/target/release/bundle/appimage/*.AppImage | head -n1)" "$APP"
    chmod +x "$APP"
  fi
  TAG="source ($BRANCH)"
else
  say "Looking up the latest release"
  JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest")" \
    || fail "no release found for $REPO yet. Build it instead: add -s -- --build"
  TAG="$(printf '%s' "$JSON" | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')"
  URLS="$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"$/\1/')"
  if [ "$OS" = "Darwin" ]; then
    URL="$(printf '%s\n' "$URLS" | grep '\.dmg$' | head -n1)"
  else
    case "$ARCH" in x86_64|amd64) ;; *) fail "no Linux build for $ARCH yet; use --build" ;; esac
    URL="$(printf '%s\n' "$URLS" | grep -i 'amd64\.AppImage$' | head -n1)"
  fi
  [ -n "$URL" ] || fail "release $TAG has no download for $OS yet; use --build"
  say "Downloading $APP_NAME $TAG"
  curl -fL --progress-bar "$URL" -o "$TMP/download" || fail "download failed"
  if [ "$OS" = "Darwin" ]; then
    MNT="$TMP/mnt"
    mkdir -p "$MNT"
    hdiutil attach "$TMP/download" -nobrowse -readonly -mountpoint "$MNT" -quiet || fail "could not open the disk image"
    install_bundle_mac "$MNT"
    hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true
    MNT=""
  else
    mkdir -p "$APP_DIR"
    pkill -x openblocks 2>/dev/null || true
    mv "$TMP/download" "$APP"
    chmod +x "$APP"
  fi
fi

mkdir -p "$BIN_DIR"
if [ "$OS" = "Darwin" ]; then
  cat > "$BIN_DIR/openblocks" <<WRAP
#!/bin/sh
# Installed by the OpenBlocks installer (github.com/$REPO)
case "\${1:-}" in
  "") exec open "$APP" ;;
  *) exec "$APP/Contents/MacOS/openblocks" "\$@" ;;
esac
WRAP
else
  cat > "$BIN_DIR/openblocks" <<WRAP
#!/bin/sh
# Installed by the OpenBlocks installer (github.com/$REPO)
APP="$APP"
if ! { [ -e /dev/fuse ] && { ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; }; }; then
  export APPIMAGE_EXTRACT_AND_RUN=1
fi
case "\${1:-}" in
  "") nohup "\$APP" >/dev/null 2>&1 & exit 0 ;;
  *) exec "\$APP" "\$@" ;;
esac
WRAP
  mkdir -p "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON")"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/main/apps/desktop/src-tauri/icons/icon.png" -o "$ICON" 2>/dev/null || true
  cat > "$DESKTOP_FILE" <<ENTRY
[Desktop Entry]
Type=Application
Name=OpenBlocks
Comment=Block notes, in your own folder
Exec=$BIN_DIR/openblocks
Icon=openblocks
Categories=Office;Utility;TextEditor;
Terminal=false
StartupWMClass=OpenBlocks
ENTRY
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true
fi
chmod +x "$BIN_DIR/openblocks"
ok "Installed $APP_NAME $TAG → $APP"

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "Open it from your apps or run: openblocks" ;;
  *)
    say "Add $BIN_DIR to your PATH to use the openblocks command:"
    printf '    echo '\''export PATH="%s:$PATH"'\'' >> ~/.%src && exec $SHELL\n' "$BIN_DIR" "$(basename "${SHELL:-sh}")"
    ;;
esac
if [ -z "${OPENBLOCKS_NO_OPEN:-}" ]; then
  if [ "$OS" = "Darwin" ]; then open "$APP" 2>/dev/null || true
  elif [ "$RESTART" = 1 ]; then "$BIN_DIR/openblocks" || true
  fi
fi

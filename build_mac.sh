#!/bin/bash
set -euo pipefail

APP_NAME="MD-Memo"
BUNDLE_DIR="$APP_NAME.app"
CONTENTS_DIR="$BUNDLE_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
MIN_OS_VERSION="10.15"

echo "Building $APP_NAME for macOS..."

# Clean previous build
rm -rf "$BUNDLE_DIR"
rm -rf AppIcon.iconset AppIcon.icns

# Generate high-res app.png if not present
if [ ! -f "app.png" ]; then
    go run tools/makeicon.go
fi

# Create macOS icns file
mkdir -p AppIcon.iconset
sips -z 16 16     app.png --out AppIcon.iconset/icon_16x16.png > /dev/null
sips -z 32 32     app.png --out AppIcon.iconset/icon_16x16@2x.png > /dev/null
sips -z 32 32     app.png --out AppIcon.iconset/icon_32x32.png > /dev/null
sips -z 64 64     app.png --out AppIcon.iconset/icon_32x32@2x.png > /dev/null
sips -z 128 128   app.png --out AppIcon.iconset/icon_128x128.png > /dev/null
sips -z 256 256   app.png --out AppIcon.iconset/icon_128x128@2x.png > /dev/null
sips -z 256 256   app.png --out AppIcon.iconset/icon_256x256.png > /dev/null
sips -z 512 512   app.png --out AppIcon.iconset/icon_256x256@2x.png > /dev/null
sips -z 512 512   app.png --out AppIcon.iconset/icon_512x512.png > /dev/null
sips -z 1024 1024 app.png --out AppIcon.iconset/icon_512x512@2x.png > /dev/null

iconutil -c icns AppIcon.iconset -o AppIcon.icns
rm -rf AppIcon.iconset

# --- Windows resource file safety net -------------------------------------
# Go's build constraints already exclude any "*_windows_amd64.syso" file from
# darwin builds by filename alone, so the repo's checked-in resource file
# (rsrc_windows_amd64.syso) never needs to be renamed out of the way for this
# script to build cleanly on macOS. This is only a one-time recovery for a
# checkout left in a bad state by an older version of this script, which used
# to rename it to the GOOS-less "rsrc.syso" after every run.
if [ -f "rsrc.syso" ] && [ ! -f "rsrc_windows_amd64.syso" ]; then
    echo "Found stray rsrc.syso (no GOOS suffix); restoring it to rsrc_windows_amd64.syso"
    mv rsrc.syso rsrc_windows_amd64.syso
fi

# --- Resolve the app version from Go source (single source of truth) ------
APP_VERSION="$(grep -oE 'AppVersion[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' app.go | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
if [ -z "$APP_VERSION" ]; then
    echo "ERROR: could not parse the AppVersion constant from app.go" >&2
    exit 1
fi
echo "App version: $APP_VERSION"

# --- Build the binary (universal by default; native-arch on request) ------
export CGO_ENABLED=1
export MACOSX_DEPLOYMENT_TARGET="$MIN_OS_VERSION"

NATIVE_UNAME_ARCH="$(uname -m)"
case "$NATIVE_UNAME_ARCH" in
    arm64)
        NATIVE_GOARCH="arm64"; NATIVE_CFLAGS="-arch arm64"
        OTHER_GOARCH="amd64";  OTHER_CFLAGS="-arch x86_64"
        ;;
    x86_64)
        NATIVE_GOARCH="amd64"; NATIVE_CFLAGS="-arch x86_64"
        OTHER_GOARCH="arm64";  OTHER_CFLAGS="-arch arm64"
        ;;
    *)
        echo "WARNING: unrecognized host architecture '$NATIVE_UNAME_ARCH'; defaulting to amd64" >&2
        NATIVE_GOARCH="amd64"; NATIVE_CFLAGS="-arch x86_64"
        OTHER_GOARCH="arm64";  OTHER_CFLAGS="-arch arm64"
        ;;
esac

echo "Building native slice ($NATIVE_GOARCH)..."
CGO_CFLAGS="$NATIVE_CFLAGS" CGO_LDFLAGS="$NATIVE_CFLAGS" GOOS=darwin GOARCH="$NATIVE_GOARCH" \
    go build -ldflags="-s -w" -trimpath -o "$APP_NAME-$NATIVE_GOARCH" .

IS_UNIVERSAL=0
if [ "${MDMEMO_NATIVE_ONLY:-0}" = "1" ]; then
    echo "MDMEMO_NATIVE_ONLY=1: skipping the universal build; shipping native arch ($NATIVE_GOARCH) only."
    mv "$APP_NAME-$NATIVE_GOARCH" "$APP_NAME"
else
    echo "Building other slice ($OTHER_GOARCH) for a universal binary..."
    if CGO_CFLAGS="$OTHER_CFLAGS" CGO_LDFLAGS="$OTHER_CFLAGS" GOOS=darwin GOARCH="$OTHER_GOARCH" \
        go build -ldflags="-s -w" -trimpath -o "$APP_NAME-$OTHER_GOARCH" . ; then
        echo "Combining slices into a universal binary with lipo..."
        lipo -create -output "$APP_NAME" "$APP_NAME-$NATIVE_GOARCH" "$APP_NAME-$OTHER_GOARCH"
        rm -f "$APP_NAME-$NATIVE_GOARCH" "$APP_NAME-$OTHER_GOARCH"
        IS_UNIVERSAL=1
    else
        echo "WARNING: failed to build the $OTHER_GOARCH slice; shipping the native-arch ($NATIVE_GOARCH) binary only." >&2
        rm -f "$APP_NAME-$OTHER_GOARCH"
        mv "$APP_NAME-$NATIVE_GOARCH" "$APP_NAME"
    fi
fi

# --- Create .app bundle structure ------------------------------------------
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"

mv "$APP_NAME" "$MACOS_DIR/$APP_NAME"
cp AppIcon.icns "$RESOURCES_DIR/AppIcon.icns"

# Create Info.plist
cat <<EOF > "$CONTENTS_DIR/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>com.youshinh.md-memo</string>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$APP_VERSION</string>
    <key>CFBundleVersion</key>
    <string>$APP_VERSION</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>$MIN_OS_VERSION</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
    <key>NSMicrophoneUsageDescription</key>
    <string>MD-Memo uses the microphone only when you start voice input (Cmd+Shift+R) to transcribe your note.</string>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key>
            <string>Markdown Document</string>
            <key>CFBundleTypeRole</key>
            <string>Editor</string>
            <key>CFBundleTypeExtensions</key>
            <array>
                <string>md</string>
                <string>markdown</string>
            </array>
            <key>LSItemContentTypes</key>
            <array>
                <string>net.daringfireball.markdown</string>
            </array>
        </dict>
        <dict>
            <key>CFBundleTypeName</key>
            <string>Plain Text Document</string>
            <key>CFBundleTypeRole</key>
            <string>Editor</string>
            <key>CFBundleTypeExtensions</key>
            <array>
                <string>txt</string>
            </array>
            <key>LSItemContentTypes</key>
            <array>
                <string>public.plain-text</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
EOF

touch "$BUNDLE_DIR"

# --- Ad-hoc code signing ----------------------------------------------------
# Required after `lipo -create` on Apple Silicon (an unsigned/mis-signed
# multi-arch binary will refuse to launch). This is a best-effort step: it
# never fails the build, since an unsigned bundle still runs via right-click >
# Open or after clearing the quarantine attribute.
if command -v codesign > /dev/null 2>&1; then
    echo "Ad-hoc signing $BUNDLE_DIR..."
    if codesign --force --deep --sign - "$BUNDLE_DIR" && codesign --verify --deep --strict "$BUNDLE_DIR"; then
        echo "Code signing verified."
    else
        echo "WARNING: codesign step failed; continuing with an unsigned/unverified bundle." >&2
    fi
else
    echo "WARNING: codesign not found on PATH; skipping ad-hoc signing." >&2
fi

echo "Successfully built $BUNDLE_DIR (version $APP_VERSION)"
if [ "$IS_UNIVERSAL" = "1" ]; then
    echo "Universal binary: arm64 + x86_64."
else
    echo "Native-arch binary only: $NATIVE_GOARCH."
fi
echo "Run it with: open \"$BUNDLE_DIR\""

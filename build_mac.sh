#!/bin/bash
set -e

APP_NAME="MD-Memo"
BUNDLE_DIR="$APP_NAME.app"
CONTENTS_DIR="$BUNDLE_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

echo "🔨 Building $APP_NAME for macOS..."

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

# Build binary (exclude Windows syso from macOS build)
if [ -f "rsrc.syso" ]; then
    mv rsrc.syso rsrc_windows_amd64.syso
fi
go build -ldflags="-s -w" -trimpath -o "$APP_NAME" .
if [ -f "rsrc_windows_amd64.syso" ]; then
    mv rsrc_windows_amd64.syso rsrc.syso
fi

# Create .app bundle structure
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
    <string>com.mdnotepad.app</string>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
</dict>
</plist>
EOF

touch "$BUNDLE_DIR"

echo "✅ Successfully built $BUNDLE_DIR with icon!"
echo "👉 You can run it with: open \"$BUNDLE_DIR\""

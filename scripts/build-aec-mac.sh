#!/bin/bash
# Build Second's echo-cancellation stack on macOS, from scratch:
#   1. webrtc-audio-processing v1.3 (static)  -> src/native/aec/deps
#   2. GStreamer webrtcdsp/webrtcechoprobe plugin (Homebrew doesn't ship it)
#   3. second-aec.node for the project's Electron version
#
# Prerequisites: brew install gstreamer meson ninja abseil cmake pkg-config
# Same recipe as .github/workflows/release-macos.yml. Safe to re-run.
set -euo pipefail

PROJ_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AEC_DIR="$PROJ_DIR/src/native/aec"
DEPS_DIR="$AEC_DIR/deps"
# pkg-config output breaks on paths with spaces, so stage in a temp prefix.
WORK="$(mktemp -d /tmp/second-aec-build.XXXXXX)"
STAGE="$WORK/prefix"
trap 'rm -rf "$WORK"' EXIT

for tool in pkg-config meson ninja cmake; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Run: brew install gstreamer meson ninja abseil cmake pkg-config"; exit 1; }
done
export PKG_CONFIG_PATH="$STAGE/lib/pkgconfig:/opt/homebrew/lib/pkgconfig:/usr/local/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
for pc in gstreamer-1.0 gstreamer-app-1.0 gstreamer-audio-1.0 gstreamer-bad-audio-1.0; do
  pkg-config --exists "$pc" || { echo "Missing $pc. Run: brew install gstreamer"; exit 1; }
done
GST_VERSION=$(pkg-config --modversion gstreamer-1.0)
echo "=== GStreamer $GST_VERSION ==="

echo "=== 1/3 webrtc-audio-processing v1.3 ==="
git clone -q --depth 1 --branch v1.3 https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing.git "$WORK/wap" 2>/dev/null
meson setup "$WORK/wap-build" "$WORK/wap" --prefix="$STAGE" --default-library=static --buildtype=release -Dc_args=-fPIC -Dcpp_args=-fPIC >/dev/null
ninja -C "$WORK/wap-build" >/dev/null
ninja -C "$WORK/wap-build" install >/dev/null
mkdir -p "$DEPS_DIR"
cp -R "$STAGE/lib" "$STAGE/include" "$DEPS_DIR/"

echo "=== 2/3 webrtcdsp GStreamer plugin ==="
git clone -q --depth 1 --filter=blob:none --sparse --branch "$GST_VERSION" https://gitlab.freedesktop.org/gstreamer/gstreamer.git "$WORK/gst" 2>/dev/null
git -C "$WORK/gst" sparse-checkout set subprojects/gst-plugins-bad/ext/webrtcdsp >/dev/null 2>&1
SRC="$WORK/gst/subprojects/gst-plugins-bad/ext/webrtcdsp"
cat > "$WORK/config.h" <<EOF
#ifndef __GST_WEBRTCDSP_CONFIG_H__
#define __GST_WEBRTCDSP_CONFIG_H__
#define HAVE_WEBRTC1 1
#define PACKAGE "gst-plugins-bad"
#define VERSION "$GST_VERSION"
#define GST_LICENSE "LGPL"
#define GST_PACKAGE_NAME "GStreamer Bad Plug-ins"
#define GST_PACKAGE_ORIGIN "https://gstreamer.freedesktop.org"
#endif
EOF
# shellcheck disable=SC2046
c++ -std=c++17 -shared -fPIC -DHAVE_CONFIG_H -I"$WORK" \
  $(pkg-config --cflags webrtc-audio-processing-1 gstreamer-1.0 gstreamer-base-1.0 gstreamer-audio-1.0 gstreamer-bad-audio-1.0) \
  -I/opt/homebrew/include \
  "$SRC/gstwebrtcdsp.cpp" "$SRC/gstwebrtcechoprobe.cpp" "$SRC/gstwebrtcdspplugin.cpp" \
  -o "$WORK/libgstwebrtcdsp.dylib" \
  $(pkg-config --libs gstreamer-1.0 gstreamer-base-1.0 gstreamer-audio-1.0 gstreamer-bad-audio-1.0) \
  $(pkg-config --libs --static webrtc-audio-processing-1) \
  -framework Foundation -framework CoreFoundation
mkdir -p "$DEPS_DIR/lib/gstreamer-1.0"
cp "$WORK/libgstwebrtcdsp.dylib" "$DEPS_DIR/lib/gstreamer-1.0/"
for el in webrtcdsp webrtcechoprobe; do
  GST_PLUGIN_PATH="$DEPS_DIR/lib/gstreamer-1.0" gst-inspect-1.0 "$el" >/dev/null 2>&1 \
    && echo "  $el loads OK" || { echo "  $el failed to load"; exit 1; }
done

echo "=== 3/3 second-aec.node for Electron ==="
cd "$PROJ_DIR"
ELECTRON_VERSION=$(node -p "require('./node_modules/electron/package.json').version")
cd "$AEC_DIR"
npm install --no-audit --no-fund >/dev/null
npx cmake-js compile --runtime electron --runtime-version "$ELECTRON_VERSION" >/dev/null
ls -la "$AEC_DIR/build/Release/second-aec.node"
echo "=== Echo cancellation built ==="

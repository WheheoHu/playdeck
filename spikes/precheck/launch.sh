#!/usr/bin/env bash
# Precheck before S1: does mpv in Gaming Mode get an HDR10 swapchain from the gamescope WSI layer?
# Plays a synthetic test pattern tagged as PQ/BT.2020 for 20 seconds. The colors will look wrong;
# only the negotiated swapchain format matters here.
set -u

exec flatpak run io.mpv.Mpv \
  --no-config \
  --fs \
  --vo=gpu-next \
  --gpu-api=vulkan \
  --target-colorspace-hint=yes \
  --hwdec=no \
  --end=20 \
  --vf=format=colormatrix=bt.2020-ncl:primaries=bt.2020:gamma=pq \
  --log-file="$PLAYDECK_LOG_DIR/mpv.log" \
  --msg-level=all=v \
  'av://lavfi:testsrc2=size=1920x1080:rate=24,format=yuv420p10le'

# Offline tests: Mesa's software rasteriser (llvmpipe) through EGL's surfaceless platform.
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        gcc libc6-dev make libwayland-dev libegl-dev libgles-dev libegl-mesa0 libgl1-mesa-dri python3 nodejs \
    && rm -rf /var/lib/apt/lists/*

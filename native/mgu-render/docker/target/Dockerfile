# The head unit's userland: glibc 2.27, loader /lib/ld-linux-x86-64.so.2 (also in Ubuntu 18.04),
# libwayland-client/-egl, libEGL, libGLESv2 from the system.
FROM ubuntu:18.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        gcc libc6-dev make binutils libwayland-dev libegl1-mesa-dev libgles2-mesa-dev \
    && rm -rf /var/lib/apt/lists/*

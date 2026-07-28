# Local fallback for the formal native comparison. GitHub Actions installs the
# same tools directly on its Ubuntu runner; this image keeps the comparison
# runnable on developer machines that do not have autotools installed.
FROM emscripten/emsdk:3.1.74

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        autoconf \
        automake \
        build-essential \
        git \
        libtool \
        pkg-config \
        xa65 \
    && rm -rf /var/lib/apt/lists/*

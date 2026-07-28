FROM emscripten/emsdk:3.1.74

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    python3 \
    ca-certificates \
    curl \
    pkg-config \
    autoconf \
    automake \
    libtool \
    patch \
    ninja-build \
    cmake \
    xa65 \
    unzip \
    xz-utils \
    rsync \
    && rm -rf /var/lib/apt/lists/*

RUN emcc --version

COPY src/bindings/bindings.cpp /opt/libsidplayfp-wasm/src/bindings/bindings.cpp
# The artifact's type surface and README are checked-in sources, not heredocs in
# entrypoint.sh, so bindings.cpp and the .d.ts can be reviewed side by side.
COPY src/libsidplayfp.d.ts /opt/libsidplayfp-wasm/src/libsidplayfp.d.ts
COPY src/bindings/ARTIFACT.md /opt/libsidplayfp-wasm/src/bindings/ARTIFACT.md
COPY package.json /opt/libsidplayfp-wasm/package.json
# Licensing artifacts are copied beside every built .wasm, so an artifact taken
# out of the package on its own still carries its notices.
COPY THIRD-PARTY-NOTICES.md /opt/libsidplayfp-wasm/THIRD-PARTY-NOTICES.md
COPY MODIFICATIONS.md /opt/libsidplayfp-wasm/MODIFICATIONS.md
COPY upstream.json /opt/libsidplayfp-wasm/upstream.json
COPY docker/entrypoint.sh /opt/libsidplayfp-wasm/entrypoint.sh
COPY scripts/upstream.mjs /opt/libsidplayfp-wasm/scripts/upstream.mjs
COPY scripts/apply-thread-guards.py /opt/libsidplayfp-wasm/scripts/apply-thread-guards.py
COPY scripts/apply-sid-write-hook.py /opt/libsidplayfp-wasm/scripts/apply-sid-write-hook.py
COPY scripts/smoke-render.mjs /opt/libsidplayfp-wasm/scripts/smoke-render.mjs
COPY test/fixtures/test-tone-c4.sid /opt/libsidplayfp-wasm/test-tone-c4.sid

RUN chmod +x /opt/libsidplayfp-wasm/entrypoint.sh

WORKDIR /opt/libsidplayfp-wasm

ENTRYPOINT ["/opt/libsidplayfp-wasm/entrypoint.sh"]

# Orthanc + the REST-based Worklists plugin (workstream M3.2 live MWL; M3.5
# lifecycle). This derived image pins a versioned Orthanc release and builds
# the Worklists plugin FROM SOURCE so the SAME Dockerfile produces amd64 and
# arm64 images (the plugin's prebuilt release binaries are Ubuntu x86_64 only,
# and the jodogne/orthanc base is amd64-only — orthancteam/orthanc ships both
# arches; plan §13.16, M3.5/C5).
#
# AGPL boundary (§7.5.5): Orthanc and its plugins stay ADJACENT, SEPARATE
# processes the hub drives over REST — never embedded, linked, or vendored
# into hub code. The source build here compiles the worklists plugin against
# the SAME Ubuntu base the runtime uses (so shared-library versions match,
# e.g. libjsoncpp), then the build toolchain is discarded; nothing of the
# build enters hub code.
#
# Upgrade path: bump ORTHANC_BASE_IMAGE / WORKLISTS_VERSION below and rebuild
# (`docker compose build orthanc`). The plugin SDK fetched during the build is
# pinned by the plugin release's CMake (framework source "web").

# ── Version pins (the ONE place to bump for an Orthanc upgrade) ──────────
# Runtime base: multi-arch (amd64+arm64) ops image from the Orthanc team.
#   https://book.orthanc-server.com/users/docker.html
ARG ORTHANC_BASE_IMAGE=orthancteam/orthanc:26.8.2
# Worklists plugin release to build from source (git tag; AGPLv3+).
ARG WORKLISTS_VERSION=0.9.2

# ── Build the Worklists plugin from source (arch-native) ─────────────────
# Same base as the runtime so the .so links the runtime's exact lib versions.
FROM ${ORTHANC_BASE_IMAGE} AS worklists-builder
ARG WORKLISTS_VERSION
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates curl unzip python3 \
      libcurl4-openssl-dev libjsoncpp-dev libboost-dev libboost-filesystem-dev \
      libboost-regex-dev libboost-thread-dev libboost-system-dev libboost-locale-dev \
      libboost-iostreams-dev libboost-date-time-dev libssl-dev \
      zlib1g-dev libsqlite3-dev libpugixml-dev uuid-dev liblzma-dev libdcmtk-dev && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch ${WORKLISTS_VERSION} \
      https://github.com/orthanc-server/orthanc-worklists.git
WORKDIR /src/orthanc-worklists/build
RUN cmake .. -DORTHANC_PLUGIN_VERSION=${WORKLISTS_VERSION} \
      -DCMAKE_BUILD_TYPE=Release \
      -DALLOW_DOWNLOADS=ON \
      -DUSE_SYSTEM_ORTHANC_SDK=OFF \
      # STATIC_BUILD: the plugin .so embeds the framework's own DCMTK +
      # jsoncpp, so it is self-contained and never conflicts with the
      # runtime image's shared-library versions (e.g. libjsoncpp / libofstd).
      -DSTATIC_BUILD=ON && \
    make -j"$(nproc)"

# ── Runtime: pinned Orthanc + the freshly built plugin ───────────────────
FROM ${ORTHANC_BASE_IMAGE}
ARG WORKLISTS_VERSION
# The orthancteam image loads plugins from /usr/share/orthanc/plugins (the
# Debian/Ubuntu layout, unlike the jodogne image's /usr/local/share path).
COPY --from=worklists-builder /src/orthanc-worklists/build/libOrthancWorklists.so \
     /usr/share/orthanc/plugins/libOrthancWorklists.so

# Drop the stock legacy sample worklist plugin if present: both plugins read
# the same "Worklists" config section and the legacy one (folder-based, no
# REST) fails once that section carries the new plugin's keys. The new plugin
# supersedes it (worklists-plugin docs).
RUN rm -f /usr/share/orthanc/plugins/libModalityWorklists.so

# Enable the plugin + store REST-created items in the Orthanc DB. The
# orthancteam image loads /etc/orthanc/*.json in folder mode, so worklists.json
# merges with the base configuration (environment-variable style config also
# works — see the Orthanc Book docker page).
COPY worklists.json /etc/orthanc/worklists.json

# Orthanc 1.13+ refuses to start with remote access + HTTP auth enabled but no
# user declared. Keep the classic orthanc/orthanc dev credentials (the compose
# demos + the hub's default ORTHANC_USER/ORTHANC_PASSWORD rely on them).
ENV ORTHANC_PASSWORD=orthanc
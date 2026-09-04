# Orthanc + the new REST-based Worklists plugin (workstream M3.2 live MWL).
#
# Orthanc itself is an ADJACENT, SEPARATE process the hub drives over REST —
# never embedded or linked (plan §3.2 decision matrix, §7.5.5 AGPL boundary).
# This derived image only drops an extra plugin shared library next to the
# stock ones; the AGPL boundary is unchanged (both binaries run inside the
# Orthanc container, nothing is linked into hub code).
#
# The Worklists plugin (github.com/orthanc-server/orthanc-worklists, AGPLv3+)
# supersedes the legacy folder-based sample: it serves worklists from the
# Orthanc DB and exposes the REST API the hub's WorklistService targets
# (POST /worklists/create, GET/DELETE /worklists/{id}). Prebuilt release
# binaries are published for Ubuntu x86_64 only — the jodogne/orthanc image
# this machine runs is amd64, so the pinned 0.9.2 asset matches. ARM64
# deployments need a source build of the plugin (tracked under M3.5/C5).
FROM jodogne/orthanc:latest

ADD https://github.com/orthanc-server/orthanc-worklists/releases/download/0.9.2/libOrthancWorklists-ubuntu.so \
    /usr/local/share/orthanc/plugins/libOrthancWorklists.so

# Drop the stock legacy sample worklist plugin: both plugins read the same
# "Worklists" config section and the legacy one (folder-based, no REST)
# fails once that section carries the new plugin's keys. The new plugin
# supersedes it (worklists-plugin docs).
RUN rm /usr/local/share/orthanc/plugins/libModalityWorklists.so

# Enable the plugin + store REST-created items in the Orthanc DB. The image
# starts `Orthanc /etc/orthanc/` in folder mode, so every *.json there is
# loaded and merged — worklists.json lands alongside orthanc.json/advanced.json.
COPY worklists.json /etc/orthanc/worklists.json

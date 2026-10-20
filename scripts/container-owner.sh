#!/usr/bin/env bash
# Print the UID:GID a container must use so that files it writes to a bind mount
# are owned by the invoking host user.
#
# Rootful Docker has no user namespace, so container IDs equal host IDs and the
# answer is the invoking user's own `id -u`:`id -g`. A rootless daemon runs
# containers in a user namespace in which container root (0:0) is the invoking
# host user and every other container ID maps to a subordinate host ID. Using
# the invoking user's numeric IDs there would hand the files to an unrelated
# subordinate UID, so the answer is 0:0.
#
# Usage: container-owner.sh   (prints, for example, 1000:1000 or 0:0)
#   or source it and call container_owner.
set -euo pipefail

container_owner() {
    local security_options
    security_options=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null) || {
        echo "container-owner: 'docker info' failed; assuming a rootful daemon" >&2
        security_options=""
    }
    if [[ "${security_options}" == *"name=rootless"* ]]; then
        echo "0:0"
    else
        echo "$(id -u):$(id -g)"
    fi
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    container_owner
fi

#!/usr/bin/env bash
set -euo pipefail

version=$1
expected_commit=$2
require_tag=${3:-false}
tag_ref="refs/tags/v${version}"

set +e
tag_output=$(git ls-remote --exit-code --tags origin "$tag_ref" 2>&1)
tag_status=$?
set -e

if [[ "$tag_status" -eq 2 ]]; then
    if [[ "$require_tag" == "true" ]]; then
        echo "::error::Tag v$version does not exist"
        exit 1
    fi
    exit 0
fi

if [[ "$tag_status" -ne 0 ]]; then
    printf '%s\n' "$tag_output"
    echo "::error::Could not inspect tag v$version"
    exit 1
fi

git fetch --force origin "$tag_ref:$tag_ref"
tag_commit=$(git rev-parse "${tag_ref}^{commit}")
if [[ "$tag_commit" != "$expected_commit" ]]; then
    echo "::error::Tag v$version points to $tag_commit instead of $expected_commit"
    exit 1
fi

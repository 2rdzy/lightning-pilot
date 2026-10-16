#!/usr/bin/env bash
# Visual snapshots (tools/e2e/visual.spec.ts) inside the Playwright image that matches the locked @playwright/test,
# pinned by digest, so fonts and rendering are the same here and in CI. Build the web app first (pnpm build:web).
#   tools/e2e/visual.sh                        compare with the committed baselines
#   tools/e2e/visual.sh --update-snapshots     write new baselines (review the images before committing them)
# The repository is mounted as it is (node_modules included; the image has Node 24 and the browsers), and the
# container runs as the calling user so the files it writes stay owned by them.
set -euo pipefail
IMAGE='mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
exec docker run --rm --ipc=host --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e E2E_VISUAL=1 -e CI="${CI:-}" \
  -v "$ROOT:/work" -w /work "$IMAGE" \
  node node_modules/@playwright/test/cli.js test tools/e2e/visual.spec.ts "$@"

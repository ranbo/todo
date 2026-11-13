#!/bin/sh
# Publish public/ to a Google Cloud Storage location served as a website, using your gcloud login.
# Settings come from deploy.config (copy deploy.config.example). Extra arguments go to gcloud, e.g. --dry-run.
# Bump CACHE in public/sw.js when files change, so installed copies refresh promptly.
set -e
cd "$(dirname "$0")"
[ -f deploy.config ] || { echo "Missing deploy.config — copy deploy.config.example and edit it." >&2; exit 1; }
. ./deploy.config
[ -n "$DEPLOY_TARGET" ] || { echo "Set DEPLOY_TARGET in deploy.config." >&2; exit 1; }
[ -f public/firebase-config.js ] || { echo "Missing public/firebase-config.js — copy firebase-config.example.js." >&2; exit 1; }

gcloud storage rsync public "$DEPLOY_TARGET" --recursive --delete-unmatched-destination-objects \
  --exclude='(.*/)?\.DS_Store|firebase-config\.example\.js' --cache-control=no-cache "$@"
case " $* " in *" --dry-run "*) exit 0 ;; esac
# gcloud doesn't know the .webmanifest type.
gcloud storage objects update "$DEPLOY_TARGET/manifest.webmanifest" --content-type=application/manifest+json >/dev/null
echo "Deployed${SITE_URL:+: $SITE_URL}"

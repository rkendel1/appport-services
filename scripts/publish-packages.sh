#!/bin/sh

set -eu

npm run test

publish_args="--access public"

if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi

if [ -n "${NPM_OTP:-}" ]; then
  publish_args="$publish_args --otp=$NPM_OTP"
fi

if [ -n "${NPM_TOKEN:-}" ]; then
  npm_userconfig="$(mktemp "${TMPDIR:-/tmp}/appport-npmrc.XXXXXX")"
  trap 'rm -f "$npm_userconfig"' EXIT HUP INT TERM
  chmod 600 "$npm_userconfig"
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$npm_userconfig"
  NPM_CONFIG_USERCONFIG="$npm_userconfig" npm publish $publish_args
  NPM_CONFIG_USERCONFIG="$npm_userconfig" npm publish ./packages/runtime $publish_args
else
  npm publish $publish_args
  npm publish ./packages/runtime $publish_args
fi

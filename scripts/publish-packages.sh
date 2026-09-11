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

publish_package() {
  package_dir="$1"
  package_name="$(node -p "require('$package_dir/package.json').name")"
  package_version="$(node -p "require('$package_dir/package.json').version")"

  if npm view "$package_name@$package_version" version >/dev/null 2>&1; then
    printf '%s@%s is already published; skipping.\n' "$package_name" "$package_version"
    return
  fi

  npm publish "$package_dir" $publish_args
}

if [ -n "${NPM_TOKEN:-}" ]; then
  npm_userconfig="$(mktemp "${TMPDIR:-/tmp}/appport-npmrc.XXXXXX")"
  trap 'rm -f "$npm_userconfig"' EXIT HUP INT TERM
  chmod 600 "$npm_userconfig"
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$npm_userconfig"
  export NPM_CONFIG_USERCONFIG="$npm_userconfig"
  publish_package .
  publish_package ./packages/runtime
else
  publish_package .
  publish_package ./packages/runtime
fi

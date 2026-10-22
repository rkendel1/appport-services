#!/bin/sh
# Concurrency sweep against the real, unmodified bridge. Every run gets its own
# fresh state directory (the bridge stores at "<path>.appport-services").
set -eu
here=$(cd "$(dirname "$0")" && pwd)
H="$here/../../rust-interop/target/bridge/release/bridge-harness"
state="${STATE_ROOT:?}/load-$(date +%s)"
export AUTHBOUNDRY_NODE="$(command -v node)" AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE="$here/${BRIDGE_ENV:-env-045-lock}/appport-services.cjs" FELTDB_URL= FELTDB_ENDPOINT=
for rep in 1 2 3; do
  for t in 1 4 16 32; do
    for spec in snapshot:64 configuration.create_variable:128; do
      op=${spec%%:*}; n=${spec##*:}
      dir="$state/r$rep-t$t-$op"; mkdir -p "$dir"
      AUTHBOUNDRY_FELTDB_PATH="$dir/db" timeout 900 "$H" load "$op" "$t" $((n / t)) | grep '"load"' | sed "s/^{/{\"rep\":$rep,/"
    done
  done
done

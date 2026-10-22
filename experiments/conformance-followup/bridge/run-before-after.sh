#!/bin/sh
# Before/after for the bridge hardening (authboundry branch bridge-hardening).
# before: original client (authboundry 02191c3 appport_services.rs via ../harness) + original bridge script (env-045-lock copy)
# after:  hardened client (worktree, public API via ../harness-after) + hardened bridge script (worktree)
# Same npm tree for both: @appport/services 0.4.5 + @feltdb/core 0.11.7 (authboundry's lock).
set -eu
i=0
here=$(cd "$(dirname "$0")" && pwd)
T=$here/../../rust-interop/target
BEFORE=$T/bridge/release/bridge-harness
AFTER=$T/bridge-after/release/bridge-harness-after
WT=/home/user/authboundry-bridge
state="${STATE_ROOT:?}/ba-$(date +%s)"
out=$here/../results/hardening
mkdir -p "$out"
export AUTHBOUNDRY_NODE="$(command -v node)" FELTDB_URL= FELTDB_ENDPOINT=
run() { # variant op threads per
  v=$1; i=$((i + 1)); dir="$state/$v-$2-$3-$i-$(date +%s%N)"; mkdir -p "$dir"
  if [ "$v" = before ]; then
    AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE=$here/env-045-lock/appport-services.cjs AUTHBOUNDRY_FELTDB_PATH=$dir/db timeout 900 "$BEFORE" load "$2" "$3" "$4" | grep '"load"'
  else
    AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE=$WT/bridge/appport-services.cjs AUTHBOUNDRY_FELTDB_PATH=$dir/db timeout 900 "$AFTER" load "$2" "$3" "$4" | grep '"load"'
  fi
}
: > "$out/load.jsonl"
for rep in 1 2; do
  for t in 1 4 16 32; do
    for spec in snapshot:64 configuration.create_variable:128; do
      op=${spec%%:*}; n=${spec##*:}
      for v in before after; do
        run $v $op $t $((n / t)) | sed "s/^{/{\"variant\":\"$v\",\"rep\":$rep,/" >> "$out/load.jsonl"
      done
    done
  done
done
# Application churn: 400 distinct applications, child RSS after every 50.
for v in before after; do
  dir="$state/mem-$v"; mkdir -p "$dir"
  if [ "$v" = before ]; then
    AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE=$here/env-045-lock/appport-services.cjs AUTHBOUNDRY_FELTDB_PATH=$dir/db timeout 1500 "$BEFORE" memory snapshot 8 50 distinct
  else
    AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE=$WT/bridge/appport-services.cjs AUTHBOUNDRY_FELTDB_PATH=$dir/db timeout 1500 "$AFTER" memory snapshot 8 50 distinct
  fi | sed "s/^{/{\"variant\":\"$v\",/"
done > "$out/memory.jsonl"
# Faults, after only (before: ../../results/bridge-faults.jsonl), against the test fake.
FAKE=$WT/crates/server/tests/fixtures/fake-appport-bridge.cjs
AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE=$FAKE AUTHBOUNDRY_APPPORT_SERVICES_TIMEOUT_MS=2000 timeout 120 "$AFTER" faults > "$out/faults-after.jsonl"
mkdir -p "$state/missing"
AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE=$state/missing/bridge.cjs FIXED_BRIDGE=$FAKE timeout 60 "$AFTER" missing >> "$out/faults-after.jsonl"
echo done

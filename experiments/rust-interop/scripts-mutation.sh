#!/bin/sh
# Mutation check: each plausible porting mistake must make the corpus test fail.
# Runs on a scratch copy; the experiment sources are not modified.
set -u
root=$(cd "$(dirname "$0")" && pwd)
work="${TMPDIR:-/tmp}/ui-contract-mutation"
run() {
  label="$1"; from="$2"; to="$3"
  rm -rf "$work"; mkdir -p "$work"; cp -r "$root/crates" "$root/Cargo.toml" "$root/fixtures" "$work/"
  python3 - "$work/crates/ui-contract/src/lib.rs" "$from" "$to" <<'PY'
import sys; p, a, b = sys.argv[1:]; s = open(p).read()
assert a in s, a; open(p, 'w').write(s.replace(a, b, 1))
PY
  if ! (cd "$work" && CARGO_TARGET_DIR="$root/target/mutation" cargo build --release -q -p appport-ui-contract --tests >/dev/null 2>&1); then
    echo "NO-BUILD  $label"; return
  fi
  if (cd "$work" && CARGO_TARGET_DIR="$root/target/mutation" cargo test --release -q -p appport-ui-contract >/dev/null 2>&1); then
    echo "SURVIVED  $label"
  else
    echo "caught    $label"
  fi
}
run "count chars, not UTF-16 units (Compute's choice)" 'text.encode_utf16().count()' 'text.chars().count()'
run "integer means i64 (Compute's choice)" 'float.is_finite() && float.trunc() == float' 'number.as_i64().is_some()'
run "no reserved transport segments" '&& !segments.iter().any(|segment| RESERVED_NAME_SEGMENTS.contains(segment))' ''
run "allow '://' in routes" '|| route.contains("://")' ''
run "check label before order" 'if !is_integer(item.get("order")) {' 'let _ = non_empty(item.get("label"), &format!("navigation[{index}].label"))?; if !is_integer(item.get("order")) {'
run "unsorted filtered capabilities" 'capabilities.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));' ''
run "no JS number respelling" 'js_numbers(&mut value);' ''
run "String(object) without TypeError" 'return Err(Failure::Internal("TypeError"));' ''
run "drop details.field" 'details: field.map(' 'details: field.and(None::<&str>).map('
run "max length 512 -> 511" '<= 512' '< 512'

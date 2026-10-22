// The two Rust bindings behind one JS-shaped call: object in, object out, the
// same contract as the TypeScript functions (throws AppPortError on refusal).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AppPortError } from '@appport/protocol';

const build = new URL('../build/', import.meta.url);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Instantiate the raw-ABI module. No imports: it can reach nothing on the host. */
export function loadWasm(bytes = readFileSync(new URL('ui-contract.wasm', build))) {
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  return function handle(requestJson) {
    const input = encoder.encode(requestJson);
    const ptr = exports.ui_alloc(input.length);
    new Uint8Array(exports.memory.buffer, ptr, input.length).set(input);
    const packed = exports.ui_handle(ptr, input.length);
    exports.ui_free(ptr, input.length);
    const outPtr = Number(packed >> 32n);
    const outLen = Number(packed & 0xffffffffn);
    const text = decoder.decode(new Uint8Array(exports.memory.buffer, outPtr, outLen));
    exports.ui_free(outPtr, outLen);
    return text;
  };
}

export function loadNapi(file = 'ui-contract.linux-x64-gnu.node') {
  return createRequire(import.meta.url)(new URL(file, build).pathname).handle;
}

/** Wrap a JSON-string handler as drop-in validateUiContribution/filterUiContribution. */
export function asProtocolFunctions(handle) {
  const unwrap = (text) => {
    const envelope = JSON.parse(text);
    if (envelope.ok) return envelope.value;
    if (envelope.error) {
      const { code, message, details } = envelope.error;
      throw new AppPortError(code, message, { details });
    }
    // The TS function raises a JS TypeError here; reproduce the category.
    throw new TypeError(`ui-contract: ${envelope.internal}`);
  };
  return {
    validateUiContribution: (value) => unwrap(handle(`{"op":"validate","value":${JSON.stringify(value) ?? 'null'}}`)),
    // The filter re-validates the already validated input: the boundary has
    // no handle to a previously validated object.
    filterUiContribution: (contribution, available) =>
      unwrap(handle(`{"op":"filter","value":${JSON.stringify(contribution)},"available":${JSON.stringify([...available])}}`)),
  };
}

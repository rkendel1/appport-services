// Node module hook: @appport/services' compiled runtime/ui.js imports
// '@appport/protocol'; redirect that one import to a shim whose
// validateUiContribution/filterUiContribution are the Rust binding named by
// APPPORT_UI_RUST=wasm|napi. Everything else in the protocol is untouched.
// Production files are not modified. Usage: node --import ./node/swap-register.mjs ...
const shim = new URL('./protocol-shim.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === '@appport/protocol' && context.parentURL?.endsWith('/dist/src/runtime/ui.js')) {
    return { url: shim, shortCircuit: true };
  }
  return next(specifier, context);
}

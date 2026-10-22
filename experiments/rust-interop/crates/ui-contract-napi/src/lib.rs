//! EXPERIMENT. The same JSON-string boundary as the WASM build, through
//! Node-API: `handle(requestJson: string): string`.

use napi_derive::napi;

#[napi]
pub fn handle(request: String) -> String {
    appport_ui_contract::handle_json(request.as_bytes())
}

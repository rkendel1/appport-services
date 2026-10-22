// Re-exports the real protocol; the two UI functions come from Rust instead.
import { appendFileSync } from 'node:fs';
import { asProtocolFunctions, loadNapi, loadWasm } from './bindings.mjs';
export * from '@appport/protocol';

const variant = process.env.APPPORT_UI_RUST;
if (variant !== 'wasm' && variant !== 'napi') throw new Error('APPPORT_UI_RUST must be wasm or napi');
const rust = asProtocolFunctions(variant === 'wasm' ? loadWasm() : loadNapi());
// Proof the swapped path ran: one line per call, per process.
const log = process.env.APPPORT_UI_RUST_LOG;
const note = (op) => { if (log) appendFileSync(log, `${process.pid} ${variant} ${op}\n`); };
export function validateUiContribution(value) { note('validate'); return rust.validateUiContribution(value); }
export function filterUiContribution(contribution, available) { note('filter'); return rust.filterUiContribution(contribution, available); }

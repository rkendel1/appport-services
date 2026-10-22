// The reference: @appport/protocol as @appport/services resolves it.
import { AppPortError, filterUiContribution, validateUiContribution } from '@appport/protocol';

/** The TypeScript result as a caller observes it, in the envelope the Rust boundary returns. */
export function oracle({ op, value, available }) {
  try {
    const validated = validateUiContribution(value);
    return { ok: true, value: op === 'filter' ? filterUiContribution(validated, available ?? []) : validated };
  } catch (error) {
    if (AppPortError.is(error)) return { ok: false, error: error.toErrorObject() };
    return { ok: false, internal: error?.name ?? typeof error };
  }
}

/** The bytes a Rust binding receives for a case: the raw document embedded verbatim. */
export function requestJson(c) {
  return `{"op":${JSON.stringify(c.op)},"value":${c.raw}${c.available ? `,"available":${JSON.stringify(c.available)}` : ''}}`;
}

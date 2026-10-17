import { ServiceAuthorityError } from '../authority/errors.js';
import type { ServiceResource } from '../authority/context.js';
import { SERVICE_CAPABILITY_MANIFEST } from '../authority/manifest.js';
import type { ApiKeyResourceRule, ApiKeyRestrictions } from './models.js';

const MAX_CAPABILITIES = 64;
const MAX_RESOURCE_RULES = 64;
const MAX_ATTRIBUTES = 16;
const MAX_TEXT = 256;

const CAPABILITIES = new Set(SERVICE_CAPABILITY_MANIFEST.filter((capability) => capability.invocable).map((capability) => capability.name));
const RESOURCE_TYPES = new Set(SERVICE_CAPABILITY_MANIFEST.map((capability) => capability.authorization.resource));

/**
 * Validate and canonicalize caller-supplied restrictions. Unknown capability
 * names and resource types are refused rather than ignored: a restriction
 * that silently matched nothing would read as narrower than it is.
 */
export function normalizeRestrictions(value: unknown): ApiKeyRestrictions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('restrictions must be an object');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== 'capabilities' && key !== 'resources') throw invalid(`restrictions.${key} is not supported`);
  }
  if (!Array.isArray(input.capabilities)) throw invalid('restrictions.capabilities must be an array of capability names');
  if (input.capabilities.length > MAX_CAPABILITIES) throw invalid(`restrictions.capabilities allows at most ${MAX_CAPABILITIES} entries`);
  for (const name of input.capabilities) {
    if (typeof name !== 'string' || !CAPABILITIES.has(name)) throw invalid(`restrictions.capabilities: "${String(name)}" is not an invocable capability in the service manifest`);
  }
  const capabilities = [...new Set(input.capabilities as string[])].sort();
  if (input.resources === undefined) return Object.freeze({ capabilities: Object.freeze(capabilities) });
  if (!Array.isArray(input.resources)) throw invalid('restrictions.resources must be an array of resource rules');
  if (input.resources.length > MAX_RESOURCE_RULES) throw invalid(`restrictions.resources allows at most ${MAX_RESOURCE_RULES} rules`);
  const resources = input.resources.map(normalizeRule);
  return Object.freeze({ capabilities: Object.freeze(capabilities), resources: Object.freeze(resources) });
}

function normalizeRule(value: unknown, index: number): ApiKeyResourceRule {
  const at = `restrictions.resources[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${at} must be an object`);
  const rule = value as Record<string, unknown>;
  for (const key of Object.keys(rule)) {
    if (key !== 'type' && key !== 'id' && key !== 'attributes') throw invalid(`${at}.${key} is not supported`);
  }
  const out: { type?: string; id?: string; attributes?: Readonly<Record<string, string>> } = {};
  if (rule.type !== undefined) {
    if (typeof rule.type !== 'string' || !RESOURCE_TYPES.has(rule.type)) throw invalid(`${at}.type: "${String(rule.type)}" is not a resource type in the service manifest`);
    out.type = rule.type;
  }
  if (rule.id !== undefined) out.id = text(rule.id, `${at}.id`);
  if (rule.attributes !== undefined) {
    if (!rule.attributes || typeof rule.attributes !== 'object' || Array.isArray(rule.attributes)) throw invalid(`${at}.attributes must be an object of strings`);
    const entries = Object.entries(rule.attributes as Record<string, unknown>);
    if (entries.length > MAX_ATTRIBUTES) throw invalid(`${at}.attributes allows at most ${MAX_ATTRIBUTES} entries`);
    const attributes: Record<string, string> = {};
    for (const [key, attribute] of entries.sort(([a], [b]) => a.localeCompare(b))) attributes[text(key, `${at}.attributes key`)] = text(attribute, `${at}.attributes.${key}`);
    if (entries.length) out.attributes = Object.freeze(attributes);
  }
  // An empty rule would match every resource: say so explicitly by omitting `resources`.
  if (out.type === undefined && out.id === undefined && out.attributes === undefined) throw invalid(`${at} must set at least one of type, id, or attributes`);
  return Object.freeze(out);
}

/** Default deny: true only when the capability is listed and, if rules exist, one rule matches. */
export function restrictionsPermit(restrictions: ApiKeyRestrictions | undefined, capability: string, resource: ServiceResource): boolean {
  if (!restrictions) return true;
  if (!Array.isArray(restrictions.capabilities) || !restrictions.capabilities.includes(capability)) return false;
  if (restrictions.resources === undefined) return true;
  return restrictions.resources.some((rule) => ruleMatches(rule, resource));
}

function ruleMatches(rule: ApiKeyResourceRule, resource: ServiceResource): boolean {
  if (rule.type !== undefined && rule.type !== resource.type) return false;
  if (rule.id !== undefined && rule.id !== resource.id) return false;
  return Object.entries(rule.attributes ?? {}).every(([key, value]) => resource.attributes?.[key] === value);
}

/**
 * True when `child` can never permit something `parent` would not. A key
 * used to manage keys cannot create, widen, or rotate (and so learn the
 * secret of) a key broader than itself.
 */
export function restrictionsWithin(child: ApiKeyRestrictions | undefined, parent: ApiKeyRestrictions | undefined): boolean {
  if (!parent) return true;
  if (!child) return false;
  if (!child.capabilities.every((capability) => parent.capabilities.includes(capability))) return false;
  if (parent.resources === undefined) return true;
  if (child.resources === undefined) return false;
  return child.resources.every((rule) => parent.resources!.some((outer) => ruleNarrows(rule, outer)));
}

function ruleNarrows(inner: ApiKeyResourceRule, outer: ApiKeyResourceRule): boolean {
  if (outer.type !== undefined && inner.type !== outer.type) return false;
  if (outer.id !== undefined && inner.id !== outer.id) return false;
  return Object.entries(outer.attributes ?? {}).every(([key, value]) => inner.attributes?.[key] === value);
}

function text(value: unknown, property: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) throw invalid(`${property} must be a non-empty string of at most ${MAX_TEXT} characters`);
  return value;
}

function invalid(message: string): ServiceAuthorityError {
  return new ServiceAuthorityError('INVALID_REQUEST', message);
}

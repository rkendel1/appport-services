import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { ServiceAuthorityError } from './errors.js';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface WebhookDestinationPolicy {
  /**
   * Permit loopback/private destinations. Only trusted host code can set
   * this (local development and tests); it is not reachable from appport.toml
   * or any request.
   */
  readonly allowPrivateNetworks?: boolean;
  /** Override DNS resolution (tests). Must return every address for the host. */
  readonly lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}

export interface ValidatedDestination {
  readonly url: URL;
  /** The address that was validated; delivery connects to exactly this address. */
  readonly address: ResolvedAddress;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal']);

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(network, prefix, 'ipv6');

/** True when an address is loopback, private, link-local (incl. metadata), unspecified, or otherwise non-public. */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const embedded = embeddedIpv4(lower);
  if (embedded) return isForbiddenAddress(embedded);
  return blocked.check(lower, 'ipv6');
}

/**
 * Validate a webhook destination: scheme, hostname, and every resolved
 * address. String checks alone are not trusted; the resolved address is.
 */
export async function validateDestination(rawUrl: string, policy: WebhookDestinationPolicy = {}): Promise<ValidatedDestination> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw forbidden('Webhook destination is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw forbidden('Webhook destination must use http or https');
  if (url.username || url.password) throw forbidden('Webhook destination must not embed credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname) throw forbidden('Webhook destination host is required');

  if (!policy.allowPrivateNetworks && (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.internal'))) {
    throw forbidden('Webhook destination host is not permitted');
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await resolve(hostname, policy);
  if (addresses.length === 0) throw forbidden('Webhook destination did not resolve');
  if (!policy.allowPrivateNetworks) {
    for (const entry of addresses) {
      if (isForbiddenAddress(entry.address)) throw forbidden('Webhook destination resolves to a private, loopback, link-local, or metadata address');
    }
  }
  return { url, address: addresses[0] };
}

async function resolve(hostname: string, policy: WebhookDestinationPolicy): Promise<readonly ResolvedAddress[]> {
  try {
    if (policy.lookup) return await policy.lookup(hostname);
    const results = await dnsLookup(hostname, { all: true, verbatim: true });
    return results.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
  } catch {
    throw forbidden('Webhook destination did not resolve');
  }
}

function embeddedIpv4(address: string): string | null {
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:xxxx:xxxx), IPv4-compatible, and NAT64 (64:ff9b::/96).
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return null;
}

function forbidden(message: string): ServiceAuthorityError {
  return new ServiceAuthorityError('INVALID_REQUEST', message, { reason: 'destination_forbidden' });
}

import { BlockList, isIP } from 'node:net';

/**
 * Everything that is not a globally routable unicast address. Resolved IPs are checked
 * against this list on every outbound connection (SSRF guard), so a hostname that is
 * allowlisted by name but resolves to an internal address — or is rebound to one between
 * validation and connection — is still refused.
 */
const blocked = new BlockList();

const IPV4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved (includes broadcast)
];

const IPV6_BLOCKS: Array<[string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

for (const [network, prefix] of IPV4_BLOCKS) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of IPV6_BLOCKS) blocked.addSubnet(network, prefix, 'ipv6');

/**
 * IPv4-mapped IPv6 (::ffff:a.b.c.d) is refused outright: it is a way to smuggle an IPv4
 * address past IPv6 rules, and no legitimate public host resolves to one. This is done by
 * hand because Node's BlockList treats plain IPv4 addresses as mapped, so a blanket
 * `::ffff:0:0/96` rule would block every IPv4 address.
 */
function isIpv4Mapped(address: string): boolean {
  try {
    // The URL parser canonicalises every spelling (::ffff:1.2.3.4, 0:0:0:0:0:ffff:102:304, …) to "[::ffff:102:304]".
    return new URL(`http://[${address}]/`).hostname.startsWith('[::ffff:');
  } catch {
    return false;
  }
}

/** True only for a syntactically valid, globally routable unicast IPv4/IPv6 address. */
export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6 && isIpv4Mapped(address)) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function isIpLiteral(hostname: string): boolean {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return isIP(bare) !== 0;
}

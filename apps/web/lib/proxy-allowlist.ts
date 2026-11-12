/**
 * The only method + path pairs the browser-facing proxy forwards to the API.
 * Anything else — notably `files/*` — is a 404 at the BFF.
 */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export type ProxyMethod = 'GET' | 'POST';

const ALLOWLIST: ReadonlyArray<{ method: ProxyMethod; pattern: RegExp }> = [
  { method: 'GET', pattern: /^auth\/session$/ },
  { method: 'GET', pattern: /^platforms$/ },
  { method: 'POST', pattern: /^resolve$/ },
  { method: 'POST', pattern: /^uploads$/ },
  { method: 'POST', pattern: /^jobs$/ },
  { method: 'GET', pattern: new RegExp(`^jobs/${UUID}$`) },
];

export function isAllowedRoute(method: string, path: string): boolean {
  return ALLOWLIST.some((rule) => rule.method === method && rule.pattern.test(path));
}

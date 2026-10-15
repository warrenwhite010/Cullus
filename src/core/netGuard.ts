// Keeping web fetching off the internal network.
//
// This was inline in fetchPage and string-only. It moves here because the
// browser path needs exactly the same answer, and because a literal check on the
// hostname has a hole a browser makes much easier to walk through:
//
//   `internal.attacker.com` is not "localhost", does not start with "10.", and
//   passes every string test — while resolving to 127.0.0.1. The fetch then goes
//   to a service on the developer's own machine.
//
// So there are two layers. The literal check is kept because it is instant and
// catches the obvious cases without a DNS round trip. The resolution check is
// the one that actually holds: whatever the name looks like, every address it
// resolves to has to be public.
//
// A browser also needs this applied per navigation, not once per URL. A public
// page that 302s to 169.254.169.254 reads the cloud metadata service, and the
// pre-flight check never sees that URL. See browser.ts.

import { promises as dns } from "dns";

/** Obvious private, loopback and link-local names. Instant, no DNS. */
export function isPrivateLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/** Is a resolved IP address one we refuse to talk to? */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.toLowerCase();

  // IPv4-mapped IPv6 (::ffff:127.0.0.1) — the mapping is transparent to the
  // socket, so it must not be transparent to this check.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1] : address;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 169 && b === 254) || // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      a >= 224 // multicast and reserved
    );
  }

  return (
    address === "::1" ||
    address === "::" ||
    /^f[cd]/.test(address) || // unique local fc00::/7
    /^fe[89ab]/.test(address) // link-local fe80::/10
  );
}

/**
 * Why this URL must not be fetched, or null when it is allowed.
 *
 * Resolves the hostname, so it costs a DNS lookup. A failure to resolve is
 * treated as allowed: the fetch will fail on its own, and refusing here would
 * turn every transient DNS blip into a confusing security error.
 */
export async function blockedUrlReason(url: URL): Promise<string | null> {
  if (!["http:", "https:"].includes(url.protocol)) {
    return `Refusing to fetch ${url.protocol} — only http and https are allowed.`;
  }

  const host = url.hostname.toLowerCase();

  if (isPrivateLiteral(host)) {
    return `Refusing to fetch a private or loopback address (${host}).`;
  }

  try {
    const resolved = await dns.lookup(host, { all: true });
    const priv = resolved.find((r) => isPrivateAddress(r.address));
    if (priv) {
      return `Refusing to fetch ${host}: it resolves to a private address (${priv.address}).`;
    }
  } catch {
    /* unresolvable — let the fetch fail normally */
  }

  return null;
}

/**
 * Local-only request checks for API routes.
 * - Host must be a loopback name (defends against DNS-rebinding) unless explicitly allowed.
 * - Origin, when present, must match Host (blocks cross-site POSTs from other web pages).
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(host: string): string {
  // Strip the port, handling IPv6 literals like "[::1]:3000".
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1).toLowerCase();
  return host.split(":")[0]!.toLowerCase();
}

export type GuardResult = { ok: true } | { ok: false; status: number; message: string };

export function checkRequestOrigin(headers: Headers, allowNonLocal: boolean): GuardResult {
  const host = headers.get("host");
  if (!host) return { ok: false, status: 400, message: "Missing Host header." };

  if (!allowNonLocal && !LOOPBACK_HOSTNAMES.has(hostnameOf(host))) {
    return {
      ok: false,
      status: 403,
      message: "This app only accepts requests on localhost. See README (Security) before exposing it on a network.",
    };
  }

  const origin = headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, status: 403, message: "Invalid Origin header." };
    }
    if (originHost.toLowerCase() !== host.toLowerCase()) {
      return { ok: false, status: 403, message: "Cross-origin requests are not allowed." };
    }
  }
  return { ok: true };
}

/** Very small in-process concurrency limiter (single local user; protects the local GPU/CPU). */
export function createConcurrencyLimiter(max: number) {
  let active = 0;
  return {
    tryAcquire(): (() => void) | null {
      if (active >= max) return null;
      active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active--;
        }
      };
    },
    get active() {
      return active;
    },
  };
}

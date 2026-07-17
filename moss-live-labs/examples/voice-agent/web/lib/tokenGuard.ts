import { NextResponse } from "next/server";

export type TokenGuardConfig = {
  allowRemoteToken: boolean;
  trustProxy: boolean;
  trustedProxyHops: number;
  /** Exclusive strategy: "x-forwarded-for" | "x-real-ip" */
  trustProxyHeader: string;
  listenHost: string;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TokenGuardConfig {
  return {
    allowRemoteToken: env.ALLOW_REMOTE_TOKEN === "1",
    trustProxy: env.TRUST_PROXY === "1",
    trustedProxyHops: Math.max(1, Number(env.TRUSTED_PROXY_HOPS || "1") || 1),
    trustProxyHeader: (env.TRUST_PROXY_HEADER || "x-forwarded-for").trim().toLowerCase(),
    listenHost: (env.MOSS_LISTEN_HOST || "").trim().toLowerCase(),
  };
}

export function isLoopbackIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::ffff:127.0.0.1"
  ) {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function isLoopbackListenHost(host: string): boolean {
  const bracketed = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  const hostname = bracketed?.[1] ?? host.replace(/^([^:]+):\d+$/, "$1");
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "0:0:0:0:0:0:0:1"
  );
}

/**
 * Resolve the caller address. Never use Host / X-Forwarded-Host.
 * Strategy is selected only via trustProxyHeader — not both at once.
 */
export function peerIp(request: Request, config: TokenGuardConfig): string | null {
  if (!config.trustProxy) return null;

  if (config.trustProxyHeader === "x-real-ip") {
    return request.headers.get("x-real-ip")?.trim() || null;
  }

  if (config.trustProxyHeader !== "x-forwarded-for") {
    return null;
  }

  const xff = request.headers.get("x-forwarded-for");
  if (!xff) return null;
  const parts = xff
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < config.trustedProxyHops) return null;
  // Rightmost trusted hop — leftmost is attacker-controlled when clients forge XFF
  // and the proxy only appends.
  return parts[parts.length - config.trustedProxyHops] || null;
}

/** Returns a 403 response when the caller is not allowed; otherwise null. */
export function assertLocalDevOnly(
  request: Request,
  config: TokenGuardConfig,
): NextResponse | null {
  if (config.allowRemoteToken) return null;

  // Host-header checks are intentionally not used here (spoofable).
  // Production loopback (`npm start` with MOSS_LISTEN_HOST=127.0.0.1) is allowed;
  // remote production still requires ALLOW_REMOTE_TOKEN=1.
  const ip = peerIp(request, config);
  if (ip !== null) {
    return isLoopbackIp(ip)
      ? null
      : new NextResponse("Token endpoint is local-dev only", { status: 403 });
  }

  // No verified peer IP. Allow only when the npm script marked this process as
  // loopback-bound (works for both `next dev` and production `next start`).
  if (!config.trustProxy && config.listenHost && isLoopbackListenHost(config.listenHost)) {
    return null;
  }

  return new NextResponse("Token endpoint is local-dev only", { status: 403 });
}

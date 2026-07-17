import { NextResponse } from "next/server";
import { AccessToken, TrackSource, type VideoGrant } from "livekit-server-sdk";

// Copy web/.env.local.example to web/.env.local to get the `livekit-server --dev` defaults.
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const ALLOW_REMOTE_TOKEN = process.env.ALLOW_REMOTE_TOKEN === "1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const TRUSTED_PROXY_HOPS = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS || "1") || 1);
/**
 * Explicit trusted-proxy client strategy (only when TRUST_PROXY=1):
 * - "x-forwarded-for" (default): append-only proxies; use the rightmost trusted hop.
 * - "x-real-ip": proxies that overwrite a single validated header.
 * Never fall back between the two — forged X-Real-IP must not bypass XFF hop math.
 */
const TRUST_PROXY_HEADER = (process.env.TRUST_PROXY_HEADER || "x-forwarded-for").trim().toLowerCase();
/** Set by `npm run dev` / `start` so unverified peers are allowed only on loopback binds. */
const LISTEN_HOST = (process.env.MOSS_LISTEN_HOST || "").trim().toLowerCase();

export const revalidate = 0;

function isLoopbackIp(ip: string): boolean {
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

function isLoopbackListenHost(host: string): boolean {
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
 * Strategy is selected only via TRUST_PROXY_HEADER — not both at once.
 */
function peerIp(request: Request): string | null {
  if (!TRUST_PROXY) return null;

  if (TRUST_PROXY_HEADER === "x-real-ip") {
    return request.headers.get("x-real-ip")?.trim() || null;
  }

  if (TRUST_PROXY_HEADER !== "x-forwarded-for") {
    console.error(
      `Invalid TRUST_PROXY_HEADER=${JSON.stringify(TRUST_PROXY_HEADER)}; use "x-forwarded-for" or "x-real-ip"`,
    );
    return null;
  }

  const xff = request.headers.get("x-forwarded-for");
  if (!xff) return null;
  const parts = xff
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < TRUSTED_PROXY_HOPS) return null;
  // Rightmost trusted hop — leftmost is attacker-controlled when clients forge XFF
  // and the proxy only appends.
  return parts[parts.length - TRUSTED_PROXY_HOPS] || null;
}

function assertLocalDevOnly(request: Request): NextResponse | null {
  if (ALLOW_REMOTE_TOKEN) return null;

  // Host-header checks are intentionally not used here (spoofable).
  // Production loopback (`npm start` with MOSS_LISTEN_HOST=127.0.0.1) is allowed;
  // remote production still requires ALLOW_REMOTE_TOKEN=1.
  const ip = peerIp(request);
  if (ip !== null) {
    return isLoopbackIp(ip)
      ? null
      : new NextResponse("Token endpoint is local-dev only", { status: 403 });
  }

  // No verified peer IP. Allow only when the npm script marked this process as
  // loopback-bound (works for both `next dev` and production `next start`).
  if (!TRUST_PROXY && LISTEN_HOST && isLoopbackListenHost(LISTEN_HOST)) {
    return null;
  }

  return new NextResponse("Token endpoint is local-dev only", { status: 403 });
}

// Local-dev demo: mint tokens only for loopback-bound servers unless explicitly opted in.
export async function GET(request: Request) {
  const denied = assertLocalDevOnly(request);
  if (denied) return denied;

  try {
    if (!LIVEKIT_URL) throw new Error("LIVEKIT_URL is not defined");
    if (!API_KEY) throw new Error("LIVEKIT_API_KEY is not defined");
    if (!API_SECRET) throw new Error("LIVEKIT_API_SECRET is not defined");

    // collision-resistant so concurrent visitors never share a room (and its audio / moss.retrieval data)
    const roomName = `support-demo-${crypto.randomUUID()}`;
    const identity = `user-${crypto.randomUUID()}`;

    const at = new AccessToken(API_KEY, API_SECRET, { identity, name: "You", ttl: "15m" });
    const grant: VideoGrant = {
      room: roomName,
      roomJoin: true,
      canPublish: true, // publish mic
      canPublishSources: [TrackSource.MICROPHONE],
      canPublishData: true,
      canSubscribe: true,
    };
    at.addGrant(grant);

    return NextResponse.json(
      { serverUrl: LIVEKIT_URL, participantToken: await at.toJwt() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("token generation failed", error);
    return new NextResponse("Failed to generate token", { status: 500 });
  }
}

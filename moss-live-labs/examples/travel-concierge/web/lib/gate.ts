import { createHmac, timingSafeEqual } from "crypto";

export const COOKIE_NAME = "travel_demo_gate";

/** HMAC token stored in an httpOnly cookie — never ship APP_SECRET to the browser. */
export function gateCookieValue(secret: string): string {
  return createHmac("sha256", secret).update("travel-concierge-gate").digest("hex");
}

export function hasValidGateCookie(cookieHeader: string | null, secret: string): boolean {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  const value = match?.[1];
  if (!value) return false;
  const expected = gateCookieValue(secret);
  try {
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

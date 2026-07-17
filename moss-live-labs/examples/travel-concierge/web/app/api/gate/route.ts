import { NextResponse } from "next/server";
import { COOKIE_NAME, gateCookieValue } from "@/lib/gate";

const APP_SECRET = process.env.APP_SECRET;

export const revalidate = 0;

/**
 * Exchange the server-only APP_SECRET for an httpOnly gate cookie.
 * The secret never needs to be embedded in client JS (no NEXT_PUBLIC_*).
 */
export async function POST(request: Request) {
  if (!APP_SECRET) {
    return NextResponse.json({ ok: true, gated: false });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  const secret =
    body && typeof body === "object" && "secret" in body && typeof (body as { secret: unknown }).secret === "string"
      ? (body as { secret: string }).secret
      : "";

  if (secret !== APP_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const res = NextResponse.json({ ok: true, gated: true });
  res.cookies.set(COOKIE_NAME, gateCookieValue(APP_SECRET), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12, // 12h demo session
  });
  return res;
}

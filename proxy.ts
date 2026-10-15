import { NextRequest, NextResponse } from "next/server";
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp =
    "default-src 'self'; script-src 'self' 'nonce-" +
    nonce +
    "'" +
    (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "") +
    "; style-src 'self' 'nonce-" +
    nonce +
    "'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = { matcher: ["/connect/ai/:path*"] };

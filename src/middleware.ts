import NextAuth from "next-auth";
import { authConfig } from "@/server/auth/auth.config";
import { NextResponse } from "next/server";

const { auth } = NextAuth(authConfig);

// Routes that don't require auth
const PUBLIC_ROUTES = ["/login", "/pricing", "/api/webhooks/stripe", "/api/auth", "/api/metrics", "/api/health"];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // Allow public routes
  if (PUBLIC_ROUTES.some((r) => pathname.startsWith(r))) {
    return NextResponse.next();
  }

  // No session → login
  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};

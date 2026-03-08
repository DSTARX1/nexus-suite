import { auth } from "@/server/auth/config";
import { NextResponse, type NextRequest } from "next/server";

// Routes that don't require auth
const PUBLIC_ROUTES = ["/login", "/api/webhooks/stripe", "/api/auth", "/api/metrics", "/api/health"];
// Routes accessible during onboarding (PENDING_SETUP)
const ONBOARDING_ROUTES = ["/onboarding", "/provisioning"];
// Routes only for fully onboarded users
const PROTECTED_ROUTES = ["/dashboard", "/competitors", "/workflows", "/agents", "/settings"];

export default auth((req) => {
  const nextReq = req as unknown as NextRequest;
  const { pathname } = nextReq.nextUrl;
  const session = req.auth;

  // Allow public routes
  if (PUBLIC_ROUTES.some((r) => pathname.startsWith(r))) {
    return NextResponse.next();
  }

  // No session → login
  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", nextReq.url));
  }

  const { onboardingStatus, subscriptionStatus, orgBlocked } = session.user;

  // Blocked subscription → reactivate page
  if (orgBlocked) {
    if (pathname !== "/reactivate") {
      return NextResponse.redirect(new URL("/reactivate", nextReq.url));
    }
    return NextResponse.next();
  }

  // No org yet (hasn't completed checkout) → pricing page
  if (!session.user.organizationId) {
    if (pathname !== "/pricing") {
      return NextResponse.redirect(new URL("/pricing", nextReq.url));
    }
    return NextResponse.next();
  }

  // PENDING_PAYMENT → redirect to pricing/checkout
  if (onboardingStatus === "PENDING_PAYMENT") {
    if (pathname !== "/pricing") {
      return NextResponse.redirect(new URL("/pricing", nextReq.url));
    }
    return NextResponse.next();
  }

  // PENDING_SETUP → allow onboarding routes, block dashboard
  if (onboardingStatus === "PENDING_SETUP") {
    if (PROTECTED_ROUTES.some((r) => pathname.startsWith(r))) {
      return NextResponse.redirect(new URL("/provisioning", nextReq.url));
    }
    return NextResponse.next();
  }

  // SUSPENDED → suspended page
  if (onboardingStatus === "SUSPENDED") {
    if (pathname !== "/suspended") {
      return NextResponse.redirect(new URL("/suspended", nextReq.url));
    }
    return NextResponse.next();
  }

  // ACTIVE → block access to onboarding/provisioning (already done)
  if (onboardingStatus === "ACTIVE") {
    if (pathname === "/provisioning" || pathname === "/onboarding") {
      return NextResponse.redirect(new URL("/dashboard", nextReq.url));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};

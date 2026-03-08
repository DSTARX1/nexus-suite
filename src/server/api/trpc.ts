import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { auth } from "@/server/auth/config";
import { db } from "@/lib/db";

// ── Context ──────────────────────────────────────────────────────

export async function createTRPCContext() {
  const session = await auth();
  return { session, db };
}

type Context = Awaited<ReturnType<typeof createTRPCContext>>;

// ── Init ─────────────────────────────────────────────────────────

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

// ── Layer 1: Public Procedure ────────────────────────────────────
// No auth required — used for health checks, public API

export const publicProcedure = t.procedure;

// ── Layer 2: Authed Procedure ────────────────────────────────────
// Requires valid NextAuth session — rejects unauthenticated requests

const enforceAuth = t.middleware(async ({ ctx, next }) => {
  if (!ctx.session?.user?.id) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in",
    });
  }

  // Block users whose org subscription is dead
  if (ctx.session.user.orgBlocked) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Your subscription is inactive. Please reactivate.",
      cause: ctx.session.user.blockReason,
    });
  }

  return next({
    ctx: {
      session: ctx.session,
      userId: ctx.session.user.id,
      organizationId: ctx.session.user.organizationId,
    },
  });
});

export const authedProcedure = t.procedure.use(enforceAuth);

// ── Layer 3: Subscribed Procedure ────────────────────────────────
// Requires ACTIVE or PAUSED subscription — blocks PAST_DUE, CANCELED, etc.
// Also enforces per-route feature gates

const enforceSubscription = t.middleware(async ({ ctx, next }) => {
  const { organizationId } = ctx as { organizationId?: string };

  if (!organizationId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No organization found. Complete checkout first.",
    });
  }

  const status = (ctx as { session: { user: { subscriptionStatus?: string } } })
    .session.user.subscriptionStatus;
  const allowedStatuses = ["ACTIVE", "PAUSED"];

  if (!status || !allowedStatuses.includes(status)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Subscription status "${status}" does not allow access. Please update your billing.`,
    });
  }

  return next({
    ctx: {
      ...ctx,
      organizationId: organizationId as string,
      subscriptionStatus: status,
    },
  });
});

export const subscribedProcedure = authedProcedure.use(enforceSubscription);

// ── Layer 4: Onboarded Procedure ─────────────────────────────────
// Requires onboardingStatus === ACTIVE
// PENDING_SETUP users are routed to Provisioning UI — they cannot access
// the main dashboard, agents, workflows, or any tool routes

const enforceOnboarded = t.middleware(async ({ ctx, next }) => {
  const onboardingStatus = (
    ctx as { session: { user: { onboardingStatus?: string } } }
  ).session.user.onboardingStatus;

  if (onboardingStatus !== "ACTIVE") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        onboardingStatus === "PENDING_SETUP"
          ? "Your account is being provisioned. Our team is configuring your AI agents."
          : onboardingStatus === "PENDING_PAYMENT"
            ? "Please complete payment to continue."
            : "Your account has been suspended. Contact support.",
    });
  }

  return next({ ctx });
});

export const onboardedProcedure = subscribedProcedure.use(enforceOnboarded);

// ── Admin Procedure ──────────────────────────────────────────────
// Requires OWNER or ADMIN role on the org

const enforceAdmin = t.middleware(async ({ ctx, next }) => {
  const role = (ctx as { session: { user: { role?: string } } }).session.user
    .role;

  if (!role || !["OWNER", "ADMIN"].includes(role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required",
    });
  }

  return next({ ctx });
});

export const adminProcedure = authedProcedure.use(enforceAdmin);

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe, resolveTierFromPriceId, PRICING } from "@/lib/stripe";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  const body = await req.text();
  const headersList = await headers();
  const signature = headersList.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Idempotency: skip already-processed events
  const existing = await db.stripeEvent.findUnique({ where: { id: event.id } });
  if (existing) {
    return NextResponse.json({ received: true, deduplicated: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event);
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event);
        break;

      case "invoice.payment_failed":
        await handlePaymentFailed(event);
        break;
    }

    // Record processed event
    await db.stripeEvent.create({
      data: {
        id: event.id,
        type: event.type,
        payload: event.data.object as unknown as Record<string, unknown>,
      },
    });
  } catch (err) {
    console.error(`[stripe-webhook] Failed to process ${event.type}:`, err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// ── checkout.session.completed ───────────────────────────────────
// Dual line items: one-time setup fee + recurring subscription
// Creates org with PENDING_SETUP — user sees Provisioning UI until admin activates
async function handleCheckoutCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;

  if (session.mode !== "subscription") return;

  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;
  const customerEmail = session.customer_details?.email;

  if (!customerEmail) {
    throw new Error("No customer email in checkout session");
  }

  // Resolve tier from subscription's recurring price
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const recurringItem = subscription.items.data.find(
    (item) => item.price.type === "recurring",
  );

  if (!recurringItem) {
    throw new Error("No recurring price found in subscription");
  }

  const tier = resolveTierFromPriceId(recurringItem.price.id);
  if (!tier) {
    throw new Error(`Unknown price ID: ${recurringItem.price.id}`);
  }

  const features = PRICING[tier].features;

  // Find user by email (must exist via NextAuth signup)
  const user = await db.user.findUnique({ where: { email: customerEmail } });
  if (!user) {
    throw new Error(`No user found for email: ${customerEmail}`);
  }

  // Create org + make user the OWNER
  const org = await db.organization.create({
    data: {
      name: session.metadata?.orgName ?? `${user.name}'s Organization`,
      slug: generateSlug(session.metadata?.orgName ?? user.name ?? customerEmail),
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      setupPaymentIntentId: session.payment_intent as string | null,
      subscriptionStatus: "ACTIVE",
      onboardingStatus: "PENDING_SETUP",
      pricingTier: tier,
      ...features,
      members: {
        create: {
          userId: user.id,
          role: "OWNER",
        },
      },
    },
  });

  // Link event to org
  await db.stripeEvent.update({
    where: { id: event.id },
    data: { organizationId: org.id },
  });
}

// ── customer.subscription.updated ────────────────────────────────
// Handles upgrades, downgrades, payment method changes, status transitions
async function handleSubscriptionUpdated(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;

  const org = await db.organization.findUnique({
    where: { stripeSubscriptionId: subscription.id },
  });
  if (!org) return; // not our subscription

  // Map Stripe status → our status
  const statusMap: Record<string, string> = {
    active: "ACTIVE",
    past_due: "PAST_DUE",
    unpaid: "UNPAID",
    canceled: "CANCELED",
    paused: "PAUSED",
  };

  const newStatus = statusMap[subscription.status];
  if (!newStatus) return;

  // Check if tier changed (upgrade/downgrade)
  const recurringItem = subscription.items.data.find(
    (item) => item.price.type === "recurring",
  );
  const newTier = recurringItem
    ? resolveTierFromPriceId(recurringItem.price.id)
    : null;

  const updateData: Record<string, unknown> = {
    subscriptionStatus: newStatus,
  };

  // Denormalize new tier's feature gates if tier changed
  if (newTier && newTier !== org.pricingTier) {
    const features = PRICING[newTier].features;
    Object.assign(updateData, { pricingTier: newTier, ...features });
  }

  await db.organization.update({
    where: { id: org.id },
    data: updateData,
  });
}

// ── customer.subscription.deleted ────────────────────────────────
async function handleSubscriptionDeleted(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;

  await db.organization.updateMany({
    where: { stripeSubscriptionId: subscription.id },
    data: {
      subscriptionStatus: "CANCELED",
      onboardingStatus: "SUSPENDED",
    },
  });
}

// ── invoice.payment_failed ───────────────────────────────────────
async function handlePaymentFailed(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id;

  if (!subscriptionId) return;

  await db.organization.updateMany({
    where: { stripeSubscriptionId: subscriptionId },
    data: { subscriptionStatus: "PAST_DUE" },
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function generateSlug(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
}

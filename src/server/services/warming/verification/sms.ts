/**
 * SMS Verification Provider
 *
 * Supports smspool.net and 5sim.net APIs for receiving SMS verification codes.
 *
 * Env vars:
 *   SMSPOOL_API_KEY — for smspool.net
 *   FIVESIM_API_KEY — for 5sim.net
 */

import type { VerificationCodeProvider } from "./provider";

type SmsBackend = "smspool" | "5sim";

const CODE_PATTERN = /\b(\d{6})\b/;

interface SmsOrderResult {
  orderId: string;
  phoneNumber: string;
}

/**
 * smspool.net API adapter
 */
async function smspoolOrder(serviceId: string): Promise<SmsOrderResult> {
  const apiKey = process.env.SMSPOOL_API_KEY;
  if (!apiKey) throw new Error("SMSPOOL_API_KEY not set");

  const res = await fetch("https://api.smspool.net/purchase/sms", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      key: apiKey,
      service: serviceId,
      country: "1", // US
    }),
  });

  const data = (await res.json()) as { success: number; order_id: string; number: string };
  if (!data.success) throw new Error("smspool order failed");

  return { orderId: data.order_id, phoneNumber: data.number };
}

async function smspoolCheck(orderId: string): Promise<string | null> {
  const apiKey = process.env.SMSPOOL_API_KEY!;

  const res = await fetch(
    `https://api.smspool.net/sms/check?key=${encodeURIComponent(apiKey)}&orderid=${encodeURIComponent(orderId)}`,
  );

  const data = (await res.json()) as { status: number; sms?: string };
  if (data.status === 3 && data.sms) {
    const match = data.sms.match(CODE_PATTERN);
    return match?.[1] ?? null;
  }
  return null;
}

/**
 * 5sim.net API adapter
 */
async function fivesimOrder(serviceId: string): Promise<SmsOrderResult> {
  const apiKey = process.env.FIVESIM_API_KEY;
  if (!apiKey) throw new Error("FIVESIM_API_KEY not set");

  const res = await fetch(
    `https://5sim.net/v1/user/buy/activation/usa/any/${serviceId}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  const data = (await res.json()) as { id: number; phone: string };
  return { orderId: String(data.id), phoneNumber: data.phone };
}

async function fivesimCheck(orderId: string): Promise<string | null> {
  const apiKey = process.env.FIVESIM_API_KEY!;

  const res = await fetch(`https://5sim.net/v1/user/check/${orderId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const data = (await res.json()) as { status: string; sms?: Array<{ code: string }> };
  if (data.status === "RECEIVED" && data.sms?.length) {
    return data.sms[0].code;
  }
  return null;
}

export class SmsVerificationProvider implements VerificationCodeProvider {
  readonly name: string;
  private backend: SmsBackend;
  private activeOrderId: string | null = null;

  constructor(backend: SmsBackend) {
    this.backend = backend;
    this.name = backend;
  }

  async getCode(identifier: string, timeoutMs = 120_000): Promise<string | null> {
    // identifier = service name (e.g. "tiktok", "instagram")
    const serviceId = identifier;

    // Place order
    const order =
      this.backend === "smspool"
        ? await smspoolOrder(serviceId)
        : await fivesimOrder(serviceId);

    this.activeOrderId = order.orderId;
    console.log(`[sms:${this.backend}] Order ${order.orderId}, phone: ${order.phoneNumber}`);

    // Poll for code
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 5_000;
    const checkFn = this.backend === "smspool" ? smspoolCheck : fivesimCheck;

    while (Date.now() < deadline) {
      const code = await checkFn(order.orderId);
      if (code) return code;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    return null; // timed out
  }

  async dispose(): Promise<void> {
    this.activeOrderId = null;
  }
}

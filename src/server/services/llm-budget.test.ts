import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ── Mock Redis ──────────────────────────────────────────────────
const redisMock = {
  hget: vi.fn(),
  hset: vi.fn(),
  expire: vi.fn(),
  get: vi.fn(),
  incrby: vi.fn(),
  ttl: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn(),
  on: vi.fn(),
};

vi.mock("ioredis", () => {
  return {
    Redis: class {
      hget = redisMock.hget;
      hset = redisMock.hset;
      expire = redisMock.expire;
      get = redisMock.get;
      incrby = redisMock.incrby;
      ttl = redisMock.ttl;
      publish = redisMock.publish;
      subscribe = redisMock.subscribe;
      on = redisMock.on;
    },
  };
});

// ── Mock Prisma ─────────────────────────────────────────────────
const dbMock = {
  organization: {
    findUnique: vi.fn(),
  },
};

vi.mock("@/lib/db", () => ({
  db: dbMock,
}));

// Import AFTER mocks are set up — wrapped in async to avoid top-level await in CJS
let trackLlmSpend: Awaited<typeof import("./llm-budget.js")>["trackLlmSpend"];
let checkLlmBudget: Awaited<typeof import("./llm-budget.js")>["checkLlmBudget"];
let getSpendSummary: Awaited<typeof import("./llm-budget.js")>["getSpendSummary"];

beforeAll(async () => {
  const mod = await import("./llm-budget.js");
  trackLlmSpend = mod.trackLlmSpend;
  checkLlmBudget = mod.checkLlmBudget;
  getSpendSummary = mod.getSpendSummary;
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no cached pricing, TTL not set yet
  redisMock.hget.mockResolvedValue(null);
  redisMock.hset.mockResolvedValue("OK");
  redisMock.expire.mockResolvedValue(1);
  redisMock.get.mockResolvedValue(null);
  redisMock.incrby.mockResolvedValue(0);
  redisMock.ttl.mockResolvedValue(-1); // no TTL = first write
});

describe("trackLlmSpend", () => {
  describe("exact math verification", () => {
    it("1000 prompt tokens on GPT-4o → 25 hundredths", async () => {
      // GPT-4o: 250 cents/1M prompt tokens
      // (1000 * 250 * 100) / 1_000_000 = 25 hundredths = 0.25 cents → rounds to 0
      redisMock.incrby.mockResolvedValue(25);

      const result = await trackLlmSpend("org_1", "openai/gpt-4o", 1000, 0);

      // Verify INCRBY called with 25 hundredths
      expect(redisMock.incrby).toHaveBeenCalledWith(
        expect.stringContaining("llm:spend:org_1:"),
        25,
      );
      expect(result.addedCents).toBe(0); // 25 hundredths → Math.round(25/100) = 0
      expect(result.spentCents).toBe(0); // same
    });

    it("1000 completion tokens on GPT-4o → 100 hundredths = 1 cent", async () => {
      // GPT-4o: 1000 cents/1M completion tokens
      // (1000 * 1000 * 100) / 1_000_000 = 100 hundredths
      redisMock.incrby.mockResolvedValue(100);

      const result = await trackLlmSpend("org_1", "openai/gpt-4o", 0, 1000);

      expect(redisMock.incrby).toHaveBeenCalledWith(
        expect.stringContaining("llm:spend:org_1:"),
        100,
      );
      expect(result.addedCents).toBe(1); // 100/100 = 1
      expect(result.spentCents).toBe(1);
    });

    it("10000 prompt + 5000 completion on Claude Opus", async () => {
      // Opus: 1500 prompt, 7500 completion cents/1M
      // prompt: ceil((10000 * 1500 * 100) / 1M) = ceil(1500) = 1500
      // completion: ceil((5000 * 7500 * 100) / 1M) = ceil(3750) = 3750
      // total = 5250 hundredths
      redisMock.incrby.mockResolvedValue(5250);

      const result = await trackLlmSpend(
        "org_1",
        "anthropic/claude-opus-4-6",
        10000,
        5000,
      );

      expect(redisMock.incrby).toHaveBeenCalledWith(
        expect.stringContaining("llm:spend:org_1:"),
        5250,
      );
      expect(result.spentCents).toBe(53); // Math.round(5250/100) = 53
    });

    it("zero tokens → no INCRBY, returns current spend", async () => {
      redisMock.get.mockResolvedValue("500");

      const result = await trackLlmSpend("org_1", "openai/gpt-4o", 0, 0);

      expect(redisMock.incrby).not.toHaveBeenCalled();
      expect(result.addedCents).toBe(0);
      expect(result.spentCents).toBe(5); // 500/100 = 5
    });

    it("uses Math.ceil for fractional hundredths", async () => {
      // GPT-4o-mini: 15 cents/1M prompt
      // (1 * 15 * 100) / 1_000_000 = 0.0015 → ceil → 1 hundredth
      redisMock.incrby.mockResolvedValue(1);

      await trackLlmSpend("org_1", "openai/gpt-4o-mini", 1, 0);

      expect(redisMock.incrby).toHaveBeenCalledWith(
        expect.stringContaining("llm:spend:org_1:"),
        1,
      );
    });
  });

  describe("Redis TTL behavior", () => {
    it("sets 48h TTL on first write (ttl returns -1)", async () => {
      redisMock.ttl.mockResolvedValue(-1);
      redisMock.incrby.mockResolvedValue(25);

      await trackLlmSpend("org_1", "openai/gpt-4o", 1000, 0);

      expect(redisMock.expire).toHaveBeenCalledWith(
        expect.stringContaining("llm:spend:org_1:"),
        172800,
      );
    });

    it("skips TTL when already set (ttl returns positive)", async () => {
      redisMock.ttl.mockResolvedValue(86400);
      redisMock.incrby.mockResolvedValue(25);

      await trackLlmSpend("org_1", "openai/gpt-4o", 1000, 0);

      // expire is called for pricing cache, but NOT for spend key (172800 TTL)
      expect(redisMock.expire).not.toHaveBeenCalledWith(
        expect.stringContaining("llm:spend:"),
        172800,
      );
    });
  });

  describe("midnight reset via key rotation", () => {
    it("spend key includes YYYY-MM-DD (different day = different key)", async () => {
      redisMock.incrby.mockResolvedValue(100);

      await trackLlmSpend("org_1", "openai/gpt-4o", 0, 1000);

      const today = new Date().toISOString().slice(0, 10);
      expect(redisMock.incrby).toHaveBeenCalledWith(
        `llm:spend:org_1:${today}`,
        100,
      );
    });
  });

  describe("unknown model pricing", () => {
    it("falls back to GPT-4o pricing for unknown models", async () => {
      // Unknown model → 250 prompt, 1000 completion cents/1M
      // (1000 * 250 * 100) / 1M = 25 hundredths
      redisMock.incrby.mockResolvedValue(25);

      await trackLlmSpend("org_1", "unknown/model", 1000, 0);

      expect(redisMock.incrby).toHaveBeenCalledWith(
        expect.stringContaining("llm:spend:org_1:"),
        25,
      );
    });
  });
});

describe("checkLlmBudget", () => {
  it("allows when spend < budget", async () => {
    redisMock.get.mockResolvedValue("5000"); // 50 cents spent
    dbMock.organization.findUnique.mockResolvedValue({
      dailyLlmBudgetCents: 500, // 500 cents budget
      name: "Test Org",
    });

    const result = await checkLlmBudget("org_1");

    expect(result.allowed).toBe(true);
    expect(result.spentCents).toBe(50);
    expect(result.budgetCents).toBe(500);
    expect(result.remainingCents).toBe(450);
  });

  it("denies when spend >= budget", async () => {
    redisMock.get.mockResolvedValue("50000"); // 500 cents = budget
    dbMock.organization.findUnique.mockResolvedValue({
      dailyLlmBudgetCents: 500,
      name: "Test Org",
    });

    const result = await checkLlmBudget("org_1");

    expect(result.allowed).toBe(false);
    expect(result.spentCents).toBe(500);
    expect(result.remainingCents).toBe(0);
    expect(result.message).toContain("budget exceeded");
  });

  it("denies when spend exceeds budget", async () => {
    redisMock.get.mockResolvedValue("60000"); // 600 cents > 500
    dbMock.organization.findUnique.mockResolvedValue({
      dailyLlmBudgetCents: 500,
      name: "Test Org",
    });

    const result = await checkLlmBudget("org_1");

    expect(result.allowed).toBe(false);
    expect(result.percentUsed).toBe(100); // capped at 100
  });

  it("denies when org not found", async () => {
    redisMock.get.mockResolvedValue("0");
    dbMock.organization.findUnique.mockResolvedValue(null);

    const result = await checkLlmBudget("org_missing");

    expect(result.allowed).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns correct percentUsed", async () => {
    redisMock.get.mockResolvedValue("35000"); // 350 cents
    dbMock.organization.findUnique.mockResolvedValue({
      dailyLlmBudgetCents: 500,
      name: "Test Org",
    });

    const result = await checkLlmBudget("org_1");

    expect(result.percentUsed).toBe(70);
  });
});

describe("getSpendSummary", () => {
  it("returns green when < 70%", async () => {
    redisMock.get.mockResolvedValue("10000"); // 100 cents / 500 = 20%
    dbMock.organization.findUnique.mockResolvedValue({
      dailyLlmBudgetCents: 500,
      name: "Test Org",
    });

    const result = await getSpendSummary("org_1");

    expect(result.status).toBe("green");
  });

  it("returns yellow when >= 70% and < 90%", async () => {
    redisMock.get.mockResolvedValue("40000"); // 400 cents / 500 = 80%
    dbMock.organization.findUnique.mockResolvedValue({
      dailyLlmBudgetCents: 500,
      name: "Test Org",
    });

    const result = await getSpendSummary("org_1");

    expect(result.status).toBe("yellow");
  });

  it("returns red when >= 90%", async () => {
    redisMock.get.mockResolvedValue("46000"); // 460 cents / 500 = 92%
    dbMock.organization.findUnique.mockResolvedValue({
      dailyLlmBudgetCents: 500,
      name: "Test Org",
    });

    const result = await getSpendSummary("org_1");

    expect(result.status).toBe("red");
  });
});

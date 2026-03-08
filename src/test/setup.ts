import { beforeEach, vi } from "vitest";
import { mockReset } from "vitest-mock-extended";
import { prismaMock } from "./factories";

// Reset all mocks before each test
beforeEach(() => {
  mockReset(prismaMock);
  vi.clearAllMocks();
});

import { describe, it, expect } from "vitest";
import { generateBrowserProfile } from "./fingerprint";

describe("generateBrowserProfile", () => {
  describe("OS consistency", () => {
    it("Mac profiles always get Apple WebGL vendor/renderer", () => {
      // Generate many profiles, check all Mac ones have Apple WebGL
      for (let i = 0; i < 200; i++) {
        const profile = generateBrowserProfile();
        if (profile.platform === "MacIntel") {
          expect(profile.webglVendor).toBe("Apple");
          expect(profile.webglRenderer).toMatch(/^Apple M/);
        }
      }
    });

    it("Mac profiles never get NVIDIA or AMD WebGL", () => {
      for (let i = 0; i < 200; i++) {
        const profile = generateBrowserProfile();
        if (profile.platform === "MacIntel") {
          expect(profile.webglVendor).not.toContain("NVIDIA");
          expect(profile.webglVendor).not.toContain("AMD");
          expect(profile.webglVendor).not.toContain("Intel");
        }
      }
    });
  });

  describe("uniqueness", () => {
    it("100 profiles have 100 unique canvasNoiseSeed values", () => {
      const seeds = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const profile = generateBrowserProfile();
        seeds.add(profile.canvasNoiseSeed);
      }
      expect(seeds.size).toBe(100);
    });
  });

  describe("all required fields populated", () => {
    it("every GeneratedProfile field is truthy", () => {
      for (let i = 0; i < 50; i++) {
        const profile = generateBrowserProfile();

        expect(profile.userAgent).toBeTruthy();
        expect(profile.screenWidth).toBeGreaterThan(0);
        expect(profile.screenHeight).toBeGreaterThan(0);
        expect(profile.hardwareConcurrency).toBeGreaterThan(0);
        expect(profile.platform).toBeTruthy();
        expect(profile.languages.length).toBeGreaterThan(0);
        expect(profile.canvasNoiseSeed).toBeTruthy();
        expect(profile.webglVendor).toBeTruthy();
        expect(profile.webglRenderer).toBeTruthy();
        expect(profile.timezone).toBeTruthy();
        expect(profile.locale).toBeTruthy();
      }
    });

    it("userAgent contains Chrome version string", () => {
      const profile = generateBrowserProfile();
      expect(profile.userAgent).toMatch(/Chrome\/\d+\.\d+\.\d+\.\d+/);
    });

    it("canvasNoiseSeed is 32-char hex string", () => {
      const profile = generateBrowserProfile();
      expect(profile.canvasNoiseSeed).toMatch(/^[0-9a-f]{32}$/);
    });
  });
});

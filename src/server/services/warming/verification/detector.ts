/**
 * Verification Detector
 *
 * Watches Patchright page for verification challenge selectors.
 * When detected, triggers the code-catching flow via the configured provider.
 */

import type { Page } from "patchright";
import type { VerificationCodeProvider } from "./provider";

// Platform-specific selectors that indicate a verification challenge
const VERIFICATION_SELECTORS: Record<string, string[]> = {
  tiktok: [
    'text="Enter the code"',
    'text="Verify your account"',
    'text="Enter verification code"',
    '[data-e2e="verify-code-input"]',
    'input[placeholder*="code"]',
  ],
  instagram: [
    'text="Enter the code"',
    'text="Confirm your account"',
    'text="Security Code"',
    'input[name="security_code"]',
    'input[aria-label*="Security code"]',
  ],
  generic: [
    'text="Enter the code"',
    'text="Verify your account"',
    'text="verification code"',
    'input[autocomplete="one-time-code"]',
  ],
};

// Selectors for the code input field (where to type the code)
const CODE_INPUT_SELECTORS: Record<string, string[]> = {
  tiktok: [
    '[data-e2e="verify-code-input"]',
    'input[placeholder*="code"]',
    'input[type="tel"][maxlength="6"]',
  ],
  instagram: [
    'input[name="security_code"]',
    'input[aria-label*="Security code"]',
    'input[placeholder*="code"]',
  ],
  generic: [
    'input[autocomplete="one-time-code"]',
    'input[placeholder*="code"]',
    'input[maxlength="6"]',
  ],
};

// Selectors for the submit/confirm button after entering code
const SUBMIT_SELECTORS: Record<string, string[]> = {
  tiktok: [
    '[data-e2e="verify-code-submit"]',
    'button:has-text("Verify")',
    'button:has-text("Submit")',
    'button:has-text("Confirm")',
  ],
  instagram: [
    'button:has-text("Confirm")',
    'button:has-text("Submit")',
    'button[type="submit"]',
  ],
  generic: [
    'button:has-text("Verify")',
    'button:has-text("Submit")',
    'button:has-text("Confirm")',
    'button[type="submit"]',
  ],
};

export interface DetectionResult {
  detected: boolean;
  platform: string;
  matchedSelector?: string;
}

/**
 * Check if the current page is showing a verification challenge.
 */
export async function detectVerification(
  page: Page,
  platform = "generic",
): Promise<DetectionResult> {
  const selectors = VERIFICATION_SELECTORS[platform] ?? VERIFICATION_SELECTORS.generic;

  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        return { detected: true, platform, matchedSelector: selector };
      }
    } catch {
      // selector didn't match, continue
    }
  }

  return { detected: false, platform };
}

/**
 * Find the code input field on the page.
 */
async function findCodeInput(page: Page, platform: string) {
  const selectors = CODE_INPUT_SELECTORS[platform] ?? CODE_INPUT_SELECTORS.generic;

  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el) return el;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Find the submit button on the page.
 */
async function findSubmitButton(page: Page, platform: string) {
  const selectors = SUBMIT_SELECTORS[platform] ?? SUBMIT_SELECTORS.generic;

  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el) return el;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Handle a detected verification challenge:
 * 1. Get code from provider (IMAP or SMS)
 * 2. Type it into the input field
 * 3. Click submit
 */
export async function handleVerification(
  page: Page,
  provider: VerificationCodeProvider,
  identifier: string,
  platform = "generic",
): Promise<boolean> {
  console.log(`[detector] Verification detected on ${platform}, fetching code for ${identifier}...`);

  const code = await provider.getCode(identifier);
  if (!code) {
    console.error("[detector] Failed to get verification code (timed out)");
    return false;
  }

  console.log(`[detector] Got code: ${code.slice(0, 2)}****`);

  // Find and fill the input
  const input = await findCodeInput(page, platform);
  if (!input) {
    console.error("[detector] Could not find code input field");
    return false;
  }

  // Type with human-like delays
  await input.click();
  await input.fill(""); // clear first
  for (const char of code) {
    await input.type(char, { delay: 80 + Math.random() * 120 });
  }

  // Brief pause before submitting
  await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));

  // Find and click submit
  const submitBtn = await findSubmitButton(page, platform);
  if (submitBtn) {
    await submitBtn.click();
  } else {
    // Fallback: press Enter
    await input.press("Enter");
  }

  // Wait for navigation/response
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  console.log("[detector] Verification code submitted");
  return true;
}

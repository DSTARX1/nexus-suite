/**
 * Verification Code Provider Interface
 *
 * Swappable via VERIFICATION_PROVIDER env var (imap | smspool | 5sim).
 * Each provider knows how to retrieve a verification code for a given account.
 */

export interface VerificationCodeProvider {
  readonly name: string;

  /**
   * Wait for and return a verification code.
   * @param identifier - email address (IMAP) or phone number (SMS)
   * @param timeoutMs - max wait time before giving up
   * @returns the extracted code, or null if timed out
   */
  getCode(identifier: string, timeoutMs?: number): Promise<string | null>;

  /** Clean up connections / polling */
  dispose(): Promise<void>;
}

export type VerificationProviderType = "imap" | "smspool" | "5sim";

/**
 * Factory: create the right provider based on env config.
 * Lazy-imports to avoid pulling in unused deps.
 */
export async function createVerificationProvider(
  type?: VerificationProviderType,
): Promise<VerificationCodeProvider> {
  const resolved = type ?? (process.env.VERIFICATION_PROVIDER as VerificationProviderType) ?? "imap";

  switch (resolved) {
    case "imap": {
      const { ImapVerificationProvider } = await import("./imap");
      return new ImapVerificationProvider();
    }
    case "smspool":
    case "5sim": {
      const { SmsVerificationProvider } = await import("./sms");
      return new SmsVerificationProvider(resolved);
    }
    default:
      throw new Error(`Unknown verification provider: ${resolved}`);
  }
}

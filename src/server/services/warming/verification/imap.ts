/**
 * IMAP Verification Provider
 *
 * Connects to an email inbox, polls for verification emails,
 * and extracts 6-digit codes via regex.
 *
 * Env vars:
 *   IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS, IMAP_TLS (default true)
 */

import { createConnection, type Socket } from "net";
import { connect as tlsConnect, type TLSSocket } from "tls";
import type { VerificationCodeProvider } from "./provider";

// 6-digit code patterns commonly seen in verification emails
const CODE_PATTERNS = [
  /\b(\d{6})\b/,                          // plain 6-digit
  /code[:\s]+(\d{6})/i,                   // "code: 123456"
  /verification[:\s]+(\d{6})/i,           // "verification: 123456"
  /confirm[:\s]+(\d{6})/i,               // "confirm: 123456"
  /pin[:\s]+(\d{6})/i,                   // "PIN: 123456"
];

interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
}

function getImapConfig(): ImapConfig {
  return {
    host: process.env.IMAP_HOST ?? "localhost",
    port: parseInt(process.env.IMAP_PORT ?? "993", 10),
    user: process.env.IMAP_USER ?? "",
    pass: process.env.IMAP_PASS ?? "",
    tls: process.env.IMAP_TLS !== "false",
  };
}

/**
 * Minimal IMAP client — just enough to fetch recent unseen messages.
 * We avoid heavy deps (like node-imap) and use raw socket commands.
 */
class SimpleImapClient {
  private socket: Socket | TLSSocket | null = null;
  private tagCounter = 0;
  private buffer = "";

  async connect(config: ImapConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.socket!.once("data", () => resolve()); // server greeting
      };

      if (config.tls) {
        this.socket = tlsConnect(
          { host: config.host, port: config.port, rejectUnauthorized: false },
          onConnect,
        );
      } else {
        this.socket = createConnection({ host: config.host, port: config.port }, onConnect);
      }

      this.socket.setEncoding("utf-8");
      this.socket.on("error", reject);
    });
  }

  private async command(cmd: string): Promise<string> {
    const tag = `A${++this.tagCounter}`;
    const fullCmd = `${tag} ${cmd}\r\n`;

    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error("Not connected"));

      let response = "";
      const onData = (chunk: string) => {
        response += chunk;
        // Response complete when we see our tag followed by OK/NO/BAD
        if (response.includes(`${tag} OK`) || response.includes(`${tag} NO`) || response.includes(`${tag} BAD`)) {
          this.socket!.removeListener("data", onData);
          if (response.includes(`${tag} NO`) || response.includes(`${tag} BAD`)) {
            reject(new Error(`IMAP error: ${response.trim()}`));
          } else {
            resolve(response);
          }
        }
      };
      this.socket.on("data", onData);
      this.socket.write(fullCmd);
    });
  }

  async login(user: string, pass: string): Promise<void> {
    await this.command(`LOGIN "${user}" "${pass}"`);
  }

  async selectInbox(): Promise<void> {
    await this.command("SELECT INBOX");
  }

  /** Search for unseen messages from the last hour */
  async searchRecent(): Promise<string[]> {
    const response = await this.command("SEARCH UNSEEN");
    const match = response.match(/\* SEARCH (.+)/);
    if (!match) return [];
    return match[1].trim().split(/\s+/);
  }

  /** Fetch body of a message by sequence number */
  async fetchBody(seqNum: string): Promise<string> {
    const response = await this.command(`FETCH ${seqNum} BODY[TEXT]`);
    return response;
  }

  async disconnect(): Promise<void> {
    if (!this.socket) return;
    try {
      await this.command("LOGOUT");
    } catch {
      // ignore logout errors
    }
    this.socket.destroy();
    this.socket = null;
  }
}

/**
 * Extract a 6-digit verification code from email body text.
 */
function extractCode(body: string): string | null {
  for (const pattern of CODE_PATTERNS) {
    const match = body.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

export class ImapVerificationProvider implements VerificationCodeProvider {
  readonly name = "imap";
  private client: SimpleImapClient | null = null;

  async getCode(identifier: string, timeoutMs = 120_000): Promise<string | null> {
    const config = getImapConfig();
    this.client = new SimpleImapClient();

    try {
      await this.client.connect(config);
      await this.client.login(config.user, config.pass);
      await this.client.selectInbox();

      const deadline = Date.now() + timeoutMs;
      const pollIntervalMs = 5_000;

      while (Date.now() < deadline) {
        const messageIds = await this.client.searchRecent();

        // Check newest messages first
        for (const id of messageIds.reverse()) {
          const body = await this.client.fetchBody(id);

          // Only process messages that mention the identifier (email address)
          if (!body.toLowerCase().includes(identifier.toLowerCase())) continue;

          const code = extractCode(body);
          if (code) return code;
        }

        // Poll interval
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      return null; // timed out
    } finally {
      await this.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }
}

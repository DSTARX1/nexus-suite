import type { BrowserContext } from "patchright";
import type { BypassResult } from "./plain-http.js";

const RECAPTCHA_TIMEOUT = 45_000;

/**
 * reCAPTCHA v2 solver — audio-first approach.
 * 1. Click reCAPTCHA checkbox
 * 2. Click audio challenge button
 * 3. Download MP3 → send to speech-to-text via OpenRouter
 * 4. Submit transcribed text
 * Falls back to vision LLM if audio unavailable.
 */
export async function solveRecaptcha(
  url: string,
  context: BrowserContext,
): Promise<BypassResult> {
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });

    // Find reCAPTCHA iframe and click checkbox
    const recaptchaFrame = await page.waitForSelector(
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]',
      { timeout: 10_000 },
    );

    if (!recaptchaFrame) {
      throw new Error("reCAPTCHA iframe not found");
    }

    const anchorFrame = await recaptchaFrame.contentFrame();
    if (!anchorFrame) throw new Error("Cannot access reCAPTCHA anchor frame");

    // Click the checkbox
    const checkbox = await anchorFrame.waitForSelector(
      "#recaptcha-anchor",
      { timeout: 5_000 },
    );
    if (checkbox) await checkbox.click();

    // Wait for challenge frame to appear
    await page.waitForTimeout(2_000);

    // Find the bframe (challenge frame)
    const bframeHandle = await page.waitForSelector(
      'iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]',
      { timeout: 10_000 },
    );

    if (!bframeHandle) {
      // Maybe already solved by just clicking checkbox
      return await extractResult(url, page, context);
    }

    const bframe = await bframeHandle.contentFrame();
    if (!bframe) throw new Error("Cannot access reCAPTCHA challenge frame");

    // Try audio-first approach
    const audioButton = await bframe.waitForSelector(
      "#recaptcha-audio-button",
      { timeout: 5_000 },
    ).catch(() => null);

    if (audioButton) {
      await audioButton.click();
      await page.waitForTimeout(1_000);

      // Get the audio source URL
      const audioSrc = await bframe.evaluate(() => {
        const audio = document.querySelector<HTMLAudioElement>("#audio-source");
        return audio?.src ?? null;
      });

      if (audioSrc) {
        const transcript = await transcribeAudio(audioSrc);
        if (transcript) {
          // Type the transcript into the response field
          const responseInput = await bframe.waitForSelector(
            "#audio-response",
            { timeout: 5_000 },
          );
          if (responseInput) {
            await responseInput.fill(transcript);
            const verifyBtn = await bframe.waitForSelector(
              "#recaptcha-verify-button",
              { timeout: 3_000 },
            );
            if (verifyBtn) await verifyBtn.click();
            await page.waitForTimeout(3_000);
            return await extractResult(url, page, context);
          }
        }
      }
    }

    // Fallback: vision LLM approach (screenshot captcha image → GPT-4o)
    const imageResult = await solveWithVision(bframe, page, url, context);
    if (imageResult) return imageResult;

    throw new Error("reCAPTCHA solve failed: both audio and vision approaches exhausted");
  } finally {
    await page.close().catch(() => {});
  }
}

async function transcribeAudio(audioUrl: string): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[reCAPTCHA] no OPENROUTER_API_KEY set, skipping audio transcription");
    return null;
  }

  try {
    // Download the audio file
    const audioResp = await fetch(audioUrl);
    const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
    const base64Audio = audioBuffer.toString("base64");

    // Send to OpenRouter whisper endpoint
    const resp = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/whisper-1",
        file: base64Audio,
        response_format: "text",
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) return null;

    const text = await resp.text();
    return text.trim() || null;
  } catch (err) {
    console.warn("[reCAPTCHA] audio transcription failed:", err);
    return null;
  }
}

async function solveWithVision(
  bframe: import("patchright").Frame,
  page: import("patchright").Page,
  url: string,
  context: BrowserContext,
): Promise<BypassResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  try {
    // Screenshot the captcha challenge area via the bframe's owner page
    const frameElement = await bframe.frameElement();
    const screenshot = await frameElement.screenshot({ type: "png" });
    const base64Image = Buffer.from(screenshot).toString("base64");

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Look at this reCAPTCHA image. What objects does it ask you to select? List the grid positions (1-9, left-to-right top-to-bottom) that match. Reply with ONLY comma-separated numbers.",
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${base64Image}` },
              },
            ],
          },
        ],
        max_tokens: 50,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!resp.ok) return null;

    const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
    const answer = data.choices?.[0]?.message?.content;
    if (!answer) return null;

    // Parse grid positions and click them
    const positions = answer.match(/\d+/g)?.map(Number).filter((n) => n >= 1 && n <= 9);
    if (!positions?.length) return null;

    // Click each tile in the grid
    const tiles = await bframe.$$("td.rc-imageselect-tile");
    for (const pos of positions) {
      const tile = tiles[pos - 1];
      if (tile) await tile.click();
      await page.waitForTimeout(300);
    }

    const verifyBtn = await bframe.$("#recaptcha-verify-button");
    if (verifyBtn) await verifyBtn.click();
    await page.waitForTimeout(3_000);

    return await extractResult(url, page, context);
  } catch (err) {
    console.warn("[reCAPTCHA] vision solve failed:", err);
    return null;
  }
}

async function extractResult(
  url: string,
  page: import("patchright").Page,
  context: BrowserContext,
): Promise<BypassResult> {
  const html = await page.content();
  const browserCookies = await context.cookies(url);
  const cookies = browserCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
  }));

  return {
    success: true,
    html,
    cookies,
    strategy: "recaptcha",
  };
}

/**
 * Human-Like Behavior Module
 *
 * Realistic mouse movements (bezier curves), scroll velocity variation,
 * random pauses, typing speed variation. Adapted from botasaurus humancursor patterns.
 */

import type { Page } from "patchright";

// ── Random helpers ────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

/** Random pause between actions (2-8s by default) */
export async function humanPause(minMs = 2000, maxMs = 8000): Promise<void> {
  await new Promise((r) => setTimeout(r, rand(minMs, maxMs)));
}

// ── Bezier Curve Mouse Movement ───────────────────────────────────

interface Point {
  x: number;
  y: number;
}

/**
 * Generate a cubic bezier curve from start to end with randomized control points.
 * Returns a list of intermediate points for smooth mouse movement.
 */
function bezierCurve(start: Point, end: Point, steps: number): Point[] {
  // Randomize control points to make the path look natural
  const cp1: Point = {
    x: start.x + (end.x - start.x) * rand(0.2, 0.5) + rand(-50, 50),
    y: start.y + (end.y - start.y) * rand(0.0, 0.3) + rand(-30, 30),
  };
  const cp2: Point = {
    x: start.x + (end.x - start.x) * rand(0.5, 0.8) + rand(-50, 50),
    y: start.y + (end.y - start.y) * rand(0.7, 1.0) + rand(-30, 30),
  };

  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    // Cubic bezier formula: B(t) = (1-t)^3*P0 + 3*(1-t)^2*t*P1 + 3*(1-t)*t^2*P2 + t^3*P3
    const x =
      u * u * u * start.x +
      3 * u * u * t * cp1.x +
      3 * u * t * t * cp2.x +
      t * t * t * end.x;
    const y =
      u * u * u * start.y +
      3 * u * u * t * cp1.y +
      3 * u * t * t * cp2.y +
      t * t * t * end.y;
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}

/**
 * Move mouse to target using bezier curve with variable speed.
 */
export async function humanMouseMove(page: Page, targetX: number, targetY: number): Promise<void> {
  // Get current mouse position (or start from a random edge)
  const startX = randInt(0, 100);
  const startY = randInt(0, 100);

  const distance = Math.sqrt((targetX - startX) ** 2 + (targetY - startY) ** 2);
  const steps = Math.max(15, Math.min(80, Math.floor(distance / 10)));

  const points = bezierCurve({ x: startX, y: startY }, { x: targetX, y: targetY }, steps);

  for (const point of points) {
    await page.mouse.move(point.x, point.y);
    // Variable delay per step: faster in the middle, slower at start/end (ease in/out)
    const progress = points.indexOf(point) / points.length;
    const easeDelay = progress < 0.2 || progress > 0.8 ? rand(5, 15) : rand(1, 5);
    await new Promise((r) => setTimeout(r, easeDelay));
  }
}

/**
 * Click with human-like mouse movement to the element first.
 */
export async function humanClick(page: Page, selector: string): Promise<void> {
  const el = await page.$(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  const box = await el.boundingBox();
  if (!box) throw new Error(`Element not visible: ${selector}`);

  // Click at a random point within the element (not dead center)
  const clickX = box.x + rand(box.width * 0.2, box.width * 0.8);
  const clickY = box.y + rand(box.height * 0.2, box.height * 0.8);

  await humanMouseMove(page, clickX, clickY);
  await new Promise((r) => setTimeout(r, rand(50, 150))); // brief pause before click
  await page.mouse.click(clickX, clickY);
}

// ── Scroll Behavior ───────────────────────────────────────────────

/**
 * Scroll down with variable velocity — simulates human reading behavior.
 * Occasionally pauses and varies speed.
 */
export async function humanScroll(
  page: Page,
  totalPixels: number,
  direction: "down" | "up" = "down",
): Promise<void> {
  let scrolled = 0;
  const sign = direction === "down" ? 1 : -1;

  while (scrolled < totalPixels) {
    // Variable scroll chunk: 50-300px
    const chunk = randInt(50, 300);
    const actual = Math.min(chunk, totalPixels - scrolled);

    await page.mouse.wheel(0, sign * actual);
    scrolled += actual;

    // Variable delay between scroll events
    const delay = rand(30, 200);
    await new Promise((r) => setTimeout(r, delay));

    // 15% chance of a longer "reading" pause
    if (Math.random() < 0.15) {
      await new Promise((r) => setTimeout(r, rand(500, 2000)));
    }
  }
}

/**
 * Scroll through feed content for a specified duration.
 */
export async function scrollFeed(page: Page, durationMs: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < durationMs) {
    // Scroll down a random amount
    await humanScroll(page, randInt(300, 800));

    // Pause to "read" content
    await humanPause(1500, 4000);

    // Occasionally scroll up slightly (natural behavior)
    if (Math.random() < 0.1) {
      await humanScroll(page, randInt(50, 150), "up");
      await humanPause(500, 1500);
    }
  }
}

// ── Typing Behavior ───────────────────────────────────────────────

/**
 * Type text with human-like speed variation.
 * Varies delay between keystrokes, occasionally pauses longer.
 */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  const el = await page.$(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  await humanClick(page, selector);
  await new Promise((r) => setTimeout(r, rand(200, 500)));

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    await el.type(char, { delay: 0 });

    // Base delay: 50-180ms (average typing speed ~60-80 WPM)
    let delay = rand(50, 180);

    // Slower after spaces (word boundary pause)
    if (char === " ") delay += rand(30, 100);

    // Occasional longer pause (thinking)
    if (Math.random() < 0.05) delay += rand(200, 600);

    await new Promise((r) => setTimeout(r, delay));
  }
}

// ── Video Watching ────────────────────────────────────────────────

/**
 * Watch a video for a randomized duration, with occasional mouse movements.
 */
export async function watchVideo(page: Page, minSec: number, maxSec: number): Promise<void> {
  const watchTimeMs = rand(minSec * 1000, maxSec * 1000);
  const start = Date.now();

  while (Date.now() - start < watchTimeMs) {
    // Idle for a while
    await humanPause(3000, 8000);

    // Occasionally move mouse slightly (shows presence)
    if (Math.random() < 0.3) {
      const viewport = page.viewportSize();
      if (viewport) {
        await humanMouseMove(
          page,
          randInt(viewport.width * 0.2, viewport.width * 0.8),
          randInt(viewport.height * 0.3, viewport.height * 0.7),
        );
      }
    }
  }
}

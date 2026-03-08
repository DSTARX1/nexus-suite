import { randomBytes, randomInt } from "crypto";

// Browser fingerprint generator
// Adapted from CloudflareBypass BrowserConfig.generate_random_config()
// Each profile is deterministic per seed but unique across profiles

interface GeneratedProfile {
  userAgent: string;
  screenWidth: number;
  screenHeight: number;
  hardwareConcurrency: number;
  platform: string;
  languages: string[];
  canvasNoiseSeed: string;
  webglVendor: string;
  webglRenderer: string;
  timezone: string;
  locale: string;
}

const OS_CONFIGS = [
  {
    platform: "Win32",
    uaOs: "Windows NT 10.0; Win64; x64",
    timezones: ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"],
  },
  {
    platform: "MacIntel",
    uaOs: "Macintosh; Intel Mac OS X 10_15_7",
    timezones: ["America/New_York", "America/Los_Angeles", "America/Chicago"],
  },
  {
    platform: "Linux x86_64",
    uaOs: "X11; Linux x86_64",
    timezones: ["America/New_York", "Europe/London", "America/Chicago"],
  },
];

const SCREEN_RESOLUTIONS = [
  [1920, 1080],
  [2560, 1440],
  [1366, 768],
  [1536, 864],
  [1440, 900],
  [1680, 1050],
  [3840, 2160],
];

const WEBGL_CONFIGS = [
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Apple", renderer: "Apple M1" },
  { vendor: "Apple", renderer: "Apple M2 Pro" },
];

const CHROME_VERSIONS = [
  "120.0.6099.130",
  "121.0.6167.85",
  "122.0.6261.69",
  "123.0.6312.58",
  "124.0.6367.91",
  "125.0.6422.60",
];

const LANGUAGE_SETS = [
  ["en-US", "en"],
  ["en-US", "en", "es"],
  ["en-GB", "en"],
  ["en-US"],
];

function pick<T>(arr: T[]): T {
  return arr[randomInt(arr.length)];
}

export function generateBrowserProfile(): GeneratedProfile {
  const os = pick(OS_CONFIGS);
  const [screenWidth, screenHeight] = pick(SCREEN_RESOLUTIONS);
  const webgl = pick(WEBGL_CONFIGS);
  const chromeVersion = pick(CHROME_VERSIONS);
  const languages = pick(LANGUAGE_SETS);

  // Mac profiles should get Apple WebGL, not NVIDIA/AMD
  const effectiveWebgl =
    os.platform === "MacIntel"
      ? pick(WEBGL_CONFIGS.filter((w) => w.vendor === "Apple"))
      : webgl;

  return {
    userAgent: `Mozilla/5.0 (${os.uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    screenWidth,
    screenHeight,
    hardwareConcurrency: pick([4, 8, 12, 16]),
    platform: os.platform,
    languages,
    canvasNoiseSeed: randomBytes(16).toString("hex"),
    webglVendor: effectiveWebgl.vendor,
    webglRenderer: effectiveWebgl.renderer,
    timezone: pick(os.timezones),
    locale: languages[0],
  };
}

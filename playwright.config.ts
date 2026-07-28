import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  // The constrained-device measurements are opt-in: they throttle the CPU 20x
  // and stream 2000 seconds of audio, which is minutes of wall clock for a
  // number that only changes when the render path does. Run them with
  // `bun run test:constrained` when that path changes, not on every commit.
  testIgnore: process.env.LIBSIDPLAYFP_WASM_CONSTRAINED ? [] : ["**/constrained-device.spec.ts"],
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:4173" },
  projects: [
    { name: "desktop-chromium", use: { browserName: "chromium" } },
    {
      name: "android-chromium",
      use: { ...devices["Pixel 5"], browserName: "chromium" },
    },
    { name: "desktop-firefox", use: { browserName: "firefox" } },
    {
      name: "ios-webkit",
      use: { ...devices["iPhone 13"], browserName: "webkit" },
    },
    {
      name: "constrained-device",
      testMatch: "**/constrained-device.spec.ts",
      timeout: 1_800_000,
      use: {
        browserName: "chromium",
        launchOptions: {
          // A phone-sized JS heap, so the collector runs on the cadence a
          // constrained device forces rather than a desktop's near-never.
          args: ["--js-flags=--max-old-space-size=64 --expose-gc"],
        },
      },
    },
  ],
  webServer: {
    command: "node test/browser/server.mjs",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});

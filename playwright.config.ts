import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
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
  ],
  webServer: {
    command: "node test/browser/server.mjs",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});

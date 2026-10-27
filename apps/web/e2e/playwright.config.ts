import { defineConfig, devices } from "@playwright/test";

// Parcours principaux de l'interface (ROADMAP M6) : `pnpm --filter @jules/web e2e`.
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" } },
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}-{projectName}{ext}",
  use: {
    baseURL: "http://localhost:4310",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec tsx --conditions=@jules/source e2e/server.ts",
    cwd: "..",
    url: "http://localhost:4310/v1/health",
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});

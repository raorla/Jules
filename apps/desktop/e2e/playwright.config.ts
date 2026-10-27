import { defineConfig, devices } from "@playwright/test";

// Interface desktop dans un navigateur (M9) : vraie api et vraie base (le serveur des tests du web),
// build du desktop servi par `vite preview`, et un pont Tauri simulé injecté dans la page.
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4320",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm exec tsx --conditions=@jules/source e2e/server.ts",
      cwd: "../../web",
      url: "http://localhost:4310/v1/health",
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      // Mode local (M10) : l'api du desktop sur la machine, sans GitHub.
      command: "pnpm exec tsx --conditions=@jules/source e2e/local-server.ts",
      cwd: "..",
      url: "http://localhost:4330/v1/health",
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      command: "pnpm exec vite preview --port 4320 --strictPort",
      cwd: "..",
      url: "http://localhost:4320",
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});

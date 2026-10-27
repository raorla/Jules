import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers.js";

// DESIGN.md §12 : captures à 1280 et 390 px dans les deux thèmes, contrastes vérifiés par axe-core,
// aucun défilement horizontal, et chaque puce colorée porte un texte.

const SCREENS = [
  { name: "dashboard", path: "/", ready: "Tâches récentes" },
  { name: "task", path: "task:Corriger l'arrondi de la TVA", ready: "Gates" },
  { name: "approvals", path: "/approvals", ready: "Ajouter l'export CSV des factures" },
  { name: "settings", path: "/settings", ready: "Passkeys" },
  { name: "servers", path: "/servers", ready: "web-staging" },
  { name: "deployments", path: "/deployments", ready: "Déploiements par semaine" },
] as const;

for (const colorScheme of ["dark", "light"] as const) {
  for (const width of [1280, 390]) {
    test.describe(`${colorScheme} ${width}px`, () => {
      test.use({ colorScheme, viewport: { width, height: 900 } });

      for (const screen of SCREENS) {
        test(screen.name, async ({ page, request }) => {
          await loginAs(page, request, "root");
          if (screen.path.startsWith("task:")) {
            await page
              .getByRole("link", { name: new RegExp(screen.path.slice(5)) })
              .first()
              .click();
          } else {
            await page.goto(screen.path);
          }
          await expect(page.getByText(screen.ready, { exact: true }).first()).toBeVisible();
          await expect(page.locator("html")).toHaveClass(
            colorScheme === "light" ? /light/ : /^(?!.*light)/,
          );

          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          expect(overflow, "défilement horizontal").toBeLessThanOrEqual(0);

          const mute = await page
            .locator(".chip")
            .evaluateAll((chips) => chips.filter((c) => !c.textContent.trim()).length);
          expect(mute, "puce sans texte").toBe(0);

          const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
          expect(
            axe.violations.map(
              (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
            ),
          ).toEqual([]);

          await expect(page).toHaveScreenshot(`${screen.name}-${colorScheme}-${width}.png`, {
            fullPage: true,
          });
        });
      }
    });
  }
}

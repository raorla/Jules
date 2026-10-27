import { expect, test } from "@playwright/test";
import { addVirtualAuthenticator, lastCommand, loginAs } from "./helpers.js";

test.describe("parcours principaux", () => {
  test("suivre une tâche puis approuver sa spec depuis le web", async ({ page, request }) => {
    await loginAs(page, request, "root");
    // La spec à valider et le plan DevOps de production.
    await expect(page.locator(".kpi.dominant")).toContainText("2");
    await page.getByRole("link", { name: /Approbations/ }).click();
    await page
      .locator(".ac", { hasText: "Ajouter l'export CSV" })
      .getByRole("link", { name: /Approuver/ })
      .click();
    await expect(page.getByRole("heading", { name: /Ajouter l'export CSV/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: "AC1" })).toBeVisible();
    await expect(page.locator('[aria-current="step"]')).toContainText("Spec");
    await page.getByRole("button", { name: "Approuver" }).click();
    await expect(page.getByRole("status")).toHaveText("Commande envoyée : Jules la vérifie.");
    expect(await lastCommand(request)).toEqual({
      name: "approve",
      source: "web",
      decision: "pending",
    });
    await page.reload();
    await expect(page.locator("section", { hasText: "Chronologie" })).toContainText(
      "/jules approve · root",
    );
  });

  test("demander une révision exige un retour écrit", async ({ page, request }) => {
    await loginAs(page, request, "root");
    await page
      .getByRole("link", { name: /Ajouter l'export CSV/ })
      .first()
      .click();
    const revise = page.getByRole("button", { name: "Demander une révision" });
    await expect(revise).toBeDisabled();
    await page
      .getByRole("textbox", { name: "Ce qui doit changer…" })
      .fill("Ajouter le séparateur point-virgule.");
    await revise.click();
    await expect(page.getByRole("status")).toBeVisible();
    expect(await lastCommand(request)).toMatchObject({ name: "revise", source: "web" });
  });

  test("la page d'une tâche livrée montre gates, diff, review, coût et PR", async ({
    page,
    request,
  }) => {
    await loginAs(page, request, "root");
    await page
      .getByRole("link", { name: /Corriger l'arrondi de la TVA/ })
      .first()
      .click();
    await expect(page.getByText("G5.4")).toBeVisible();
    await expect(page.getByRole("region", { name: "diff" })).toContainText(
      "round(lines.reduce(sum, 0) * 0.2)",
    );
    await expect(page.getByText("Le critère AC1 est couvert par un test.")).toBeVisible();
    await expect(page.getByText("1.84 $")).toBeVisible();
    await expect(page.getByRole("link", { name: "Pull request" })).toHaveAttribute(
      "href",
      "https://github.com/acme/factures/pull/7",
    );
    await expect(page.getByText("claude-sonnet-5-5").first()).toBeVisible();
    // La transcription de l'exécution, masquée par le worker, avec l'appel refusé.
    await page.getByText("Transcription").first().click();
    await expect(
      page.getByText("Je lance les tests avec la clé [masqué]", { exact: false }),
    ).toBeVisible();
    await expect(page.locator(".call", { hasText: "git_push" })).toContainText("refusé");
  });

  test("créer une tâche depuis le web", async ({ page, request }) => {
    await loginAs(page, request, "root");
    await page.getByRole("link", { name: "Tâches", exact: true }).click();
    await page.getByLabel("Titre").fill("Ajouter un filtre par client");
    await page
      .getByLabel("Ce qu'il faut faire")
      .fill("Sur la liste des factures, filtrer par client.");
    await page.getByRole("button", { name: "Créer la tâche" }).click();
    await expect(page.getByRole("status")).toHaveText("Tâche créée : Jules ouvre l'issue GitHub.");
    await expect(page.getByRole("link", { name: /Ajouter un filtre par client/ })).toBeVisible();
  });

  test("la recherche filtre les tâches", async ({ page, request }) => {
    await loginAs(page, request, "root");
    await page.getByRole("searchbox", { name: "Rechercher une tâche…" }).fill("TVA");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("link", { name: /Corriger l'arrondi/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Mettre à jour les dépendances/ })).toHaveCount(0);
  });

  test("un viewer voit tout mais ne peut pas approuver", async ({ page, request }) => {
    await loginAs(page, request, "vera");
    await expect(page.getByRole("button", { name: "Arrêt d'urgence" })).toHaveCount(0);
    await page
      .getByRole("link", { name: /Ajouter l'export CSV/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Approuver" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("l'interface passe en anglais", async ({ page, request }) => {
    await loginAs(page, request, "root");
    await page.getByRole("link", { name: "Réglages" }).click();
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await page.getByRole("button", { name: "FR", exact: true }).click();
  });
});

test.describe("DevOps (M7)", () => {
  test("approuver un plan de production exige la passkey, au moment même", async ({
    page,
    request,
  }) => {
    await addVirtualAuthenticator(page);
    await loginAs(page, request, "root");
    await page.getByRole("link", { name: /Approbations/ }).click();
    const card = page.locator(".ac", { hasText: "web-prod" });
    await expect(card).toContainText("production");
    await expect(card).toContainText("sudo -n systemctl restart api");
    await expect(card).toContainText("Production : l'approbation exige ta passkey.");

    // Sans passkey enregistrée : refusé, l'interface dit quoi faire.
    await card.getByRole("button", { name: "Approuver avec ma passkey" }).click();
    await page.getByRole("button", { name: "Utiliser ma passkey" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(
      "Ajoute d'abord une passkey dans les réglages.",
    );
    await page.getByRole("dialog").getByRole("button", { name: "Annuler" }).click();

    await page.getByRole("link", { name: "Réglages" }).click();
    await page.getByRole("button", { name: "Ajouter une passkey" }).click();
    await page.getByRole("link", { name: /Approbations/ }).click();
    await page
      .locator(".ac", { hasText: "web-prod" })
      .getByRole("button", { name: "Approuver avec ma passkey" })
      .click();
    await page.getByRole("button", { name: "Utiliser ma passkey" }).click();
    await expect(page.locator(".ac", { hasText: "web-prod" }).getByRole("status")).toHaveText(
      "Décision envoyée : Jules la vérifie.",
    );
    expect(await lastCommand(request)).toEqual({
      name: "approve",
      source: "web",
      decision: "pending",
    });
  });

  test("un plan hors production s'approuve sans passkey", async ({ page, request }) => {
    await loginAs(page, request, "root");
    await page.getByRole("link", { name: /Approbations/ }).click();
    const card = page.locator(".ac", { hasText: "web-staging" });
    await expect(card).toContainText("staging");
    await card.getByRole("button", { name: "Approuver", exact: true }).click();
    await expect(card.getByRole("status")).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("valider la clé d'hôte d'un serveur demande la passkey et l'empreinte exacte", async ({
    page,
    request,
  }) => {
    await addVirtualAuthenticator(page);
    await loginAs(page, request, "root");
    await page.getByRole("link", { name: "Réglages" }).click();
    await page.getByRole("button", { name: "Ajouter une passkey" }).click();
    await page.getByRole("link", { name: "Serveurs" }).click();
    const prod = page.locator(".row", { hasText: "web-prod" });
    await expect(prod).toContainText("Clé d'hôte à valider");
    // Une empreinte qui n'est pas celle offerte par le serveur est refusée, même avec la passkey.
    await prod.getByLabel("Empreinte (SHA256:…)").fill(`SHA256:${"x".repeat(43)}`);
    await prod.getByRole("button", { name: "Valider l'empreinte" }).click();
    await page.getByRole("button", { name: "Utiliser ma passkey" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("ne correspond pas");
    await page.getByRole("dialog").getByRole("button", { name: "Annuler" }).click();
    await prod.getByLabel("Empreinte (SHA256:…)").fill(`SHA256:${"p".repeat(43)}`);
    await prod.getByRole("button", { name: "Valider l'empreinte" }).click();
    await expect(page.locator(".row", { hasText: "web-prod" })).toContainText("Clé d'hôte validée");
  });

  test("les déploiements montrent l'environnement, les PR et les métriques DORA", async ({
    page,
    request,
  }) => {
    await loginAs(page, request, "root");
    await page.getByRole("link", { name: "Déploiements" }).click();
    await expect(page.locator(".kpi.dominant")).toContainText("Déploiements par semaine");
    const rolledBack = page.locator(".row", { hasText: "77e0b3a" });
    await expect(rolledBack).toContainText("retour arrière");
    await expect(rolledBack).toContainText("staging");
    await expect(rolledBack).toContainText("PR #8");
  });

  test("l'historique d'un serveur garde les commandes refusées", async ({ page, request }) => {
    await loginAs(page, request, "root");
    await page.getByRole("link", { name: "Serveurs" }).click();
    await page.getByRole("link", { name: "web-staging" }).click();
    await expect(page.locator(".row", { hasText: "rm -rf /var" })).toContainText("refusé");
    await expect(page.locator(".row", { hasText: "rm -rf /var" })).toContainText("dangereuse");
    await expect(page.locator(".row", { hasText: "systemctl status api" })).toContainText("code 0");
  });

  test("une tâche DevOps montre ses propres phases et son plan", async ({ page, request }) => {
    await loginAs(page, request, "root");
    await page
      .getByRole("link", { name: /Redémarrer l'API en production/ })
      .first()
      .click();
    await expect(page.locator('[aria-current="step"]')).toContainText("Approbation");
    await expect(
      page.getByText("environ 5 s d'indisponibilité de l'API", { exact: false }),
    ).toBeVisible();
  });
});

test.describe("sécurité de l'interface", () => {
  test("un artefact qui contient du HTML ou du JavaScript ne l'exécute pas (XSS)", async ({
    page,
    request,
  }) => {
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await loginAs(page, request, "root");
    await page
      .getByRole("link", { name: /Ajouter l'export CSV/ })
      .first()
      .click();
    const spec = page.locator("section", { hasText: "Spec v1" });
    await expect(spec).toContainText("<script>window.__xss=1</script>");
    await expect(spec).toContainText('<b onmouseover="window.__xss=1">un fichier vide</b>');
    await spec.getByText("un fichier vide").hover();
    expect(await spec.locator("img, script, b").count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    expect(dialogs).toEqual([]);
  });

  test("relever l'autonomie demande la passkey, même avec une session ouverte", async ({
    page,
    request,
  }) => {
    await addVirtualAuthenticator(page);
    await loginAs(page, request, "ada");
    await page.getByRole("link", { name: "Réglages" }).click();
    const group = page.getByRole("group", { name: /acme\/factures/ });

    // Sans passkey enregistrée : l'action est refusée et l'interface dit quoi faire.
    await group.getByRole("button", { name: "L2" }).click();
    await expect(page.getByRole("dialog")).toContainText("Confirmer avec ta passkey");
    await page.getByRole("button", { name: "Utiliser ma passkey" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(
      "Ajoute d'abord une passkey dans les réglages.",
    );
    await page.getByRole("dialog").getByRole("button", { name: "Annuler" }).click();
    await expect(group.getByRole("button", { name: "L1" })).toHaveAttribute("aria-pressed", "true");

    // Avec une passkey : la cérémonie WebAuthn débloque l'action, qui est rejouée.
    await page.getByRole("button", { name: "Ajouter une passkey" }).click();
    await expect(page.locator(".chip.ok")).toHaveCount(1);
    await group.getByRole("button", { name: "L2" }).click();
    await page.getByRole("button", { name: "Utiliser ma passkey" }).click();
    await expect(group.getByRole("button", { name: "L2" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("un secret écrit depuis le web n'est plus jamais affiché", async ({ page, request }) => {
    await addVirtualAuthenticator(page);
    await loginAs(page, request, "root");
    await page.getByRole("link", { name: "Réglages" }).click();
    await page.getByRole("button", { name: "Ajouter une passkey" }).click();
    await page.getByRole("textbox", { name: "Nom", exact: true }).fill("stripe_test_key");
    await page.getByLabel("Valeur", { exact: true }).fill("sk_test_e2e_valeur_secrete");
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.getByRole("button", { name: "Utiliser ma passkey" }).click();
    await expect(
      page.getByText("Secret scellé pour le worker : il ne sera plus lisible ici."),
    ).toBeVisible();
    await expect(page.getByText("stripe_test_key", { exact: true })).toBeVisible();
    const listed = await (await page.request.get("/v1/secrets")).text();
    expect(listed).not.toContain("sk_test_e2e_valeur_secrete");
    expect(await page.content()).not.toContain("sk_test_e2e_valeur_secrete");
  });

  test("l'arrêt d'urgence s'active d'un clic confirmé et ne se lève qu'avec la passkey", async ({
    page,
    request,
  }) => {
    await addVirtualAuthenticator(page);
    await loginAs(page, request, "root");
    await page.getByRole("link", { name: "Réglages" }).click();
    await page.getByRole("button", { name: "Ajouter une passkey" }).click();
    await page.getByRole("button", { name: "Arrêt d'urgence" }).click();
    await page.getByRole("button", { name: "Tout arrêter" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Arrêt d'urgence actif" }),
    ).toBeVisible();
    expect(await lastCommand(request)).toMatchObject({ name: "stop_all", source: "web" });
    await page.getByRole("button", { name: "Lever l'arrêt" }).click();
    await page.getByRole("button", { name: "Utiliser ma passkey" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Arrêt d'urgence actif" })).toBeHidden();
  });
});

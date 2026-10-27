import { describe, expect, it } from "vitest";
import { detectTrigger, findMention, prose } from "../src/triggers.js";
import { INSTALLATION_ID, issueComment, issues } from "./fixtures.js";

const settings = { mention: "@jules", label: "jules" };

describe("findMention", () => {
  it.each([
    "@jules ajoute un endpoint",
    "Salut @jules, peux-tu regarder ?",
    "ping @Jules.",
    "(@jules)",
  ])("trouve la mention dans %j", (text) => {
    expect(findMention(text, "@jules")).toBeDefined();
  });

  it.each([
    "écris à jules@example.com",
    "@jules-bot fais ça",
    "@julesverne",
    "voir https://github.com/@jules",
    "`@jules` dans du code",
    "```\n@jules dans un bloc\n```",
    "> @jules cité depuis un autre commentaire",
    "<!-- @jules -->",
    "pas de mention",
  ])("ignore %j", (text) => {
    expect(findMention(text, "@jules")).toBeUndefined();
  });

  it("renvoie le texte qui suit la mention", () => {
    expect(findMention("ok @jules   setup le repo", "@jules")?.rest).toBe("setup le repo");
  });

  it("retire un bloc de code non fermé jusqu'à la fin", () => {
    expect(prose("texte\n```\n@jules")).toBe("texte\n");
  });
});

describe("detectTrigger", () => {
  it("crée une tâche depuis un commentaire qui mentionne Jules", () => {
    const result = detectTrigger(
      "issue_comment",
      issueComment({ body: "@jules ajoute /healthz" }),
      settings,
    );

    expect(result).toEqual({
      trigger: {
        source: "issue_comment",
        installationId: INSTALLATION_ID,
        repo: {
          githubId: 99,
          owner: "acme",
          ownerType: "Organization",
          name: "sandbox",
          fullName: "acme/sandbox",
          private: true,
          defaultBranch: "main",
        },
        issue: { number: 1, title: "Ajouter un endpoint de santé" },
        sender: { githubId: 5007, login: "alice" },
        request: "@jules ajoute /healthz",
      },
    });
  });

  it.each([
    [
      "un commentaire modifié",
      issueComment({ body: "@jules go", action: "edited" }),
      "comment_not_created",
    ],
    [
      "un bot",
      issueComment({ body: "@jules go", login: "renovate[bot]", userType: "Bot" }),
      "sender_is_bot",
    ],
    [
      "une PR (M4 : /jules fix)",
      issueComment({ body: "@jules go", onPullRequest: true }),
      "pull_request_comment",
    ],
    ["sans mention", issueComment({ body: "merci" }), "no_mention"],
    ["@jules setup (M4)", issueComment({ body: "@jules setup" }), "subcommand_unavailable:setup"],
    [
      "@jules devops (M7)",
      issueComment({ body: "@jules devops redémarre nginx" }),
      "subcommand_unavailable:devops",
    ],
  ])("ignore %s", (_, payload, reason) => {
    expect(detectTrigger("issue_comment", payload, settings)).toEqual({ ignored: reason });
  });

  it("crée une tâche depuis une issue ouverte qui mentionne Jules", () => {
    const result = detectTrigger(
      "issues",
      issues({ action: "opened", body: "@jules corrige ça" }),
      settings,
    );
    expect(result).toMatchObject({
      trigger: { source: "issue_opened", request: "@jules corrige ça" },
    });
  });

  it("crée une tâche quand le label jules est posé", () => {
    const result = detectTrigger(
      "issues",
      issues({ action: "labeled", label: "Jules", body: "détails" }),
      settings,
    );
    expect(result).toMatchObject({ trigger: { source: "issue_labeled", request: "détails" } });
  });

  it.each([
    ["un autre label", issues({ action: "labeled", label: "bug" }), "other_label"],
    ["une issue sans mention", issues({ action: "opened", body: "rien" }), "no_mention"],
    ["une issue fermée", issues({ action: "closed", body: "@jules" }), "issue_action_not_handled"],
  ])("ignore %s", (_, payload, reason) => {
    expect(detectTrigger("issues", payload, settings)).toEqual({ ignored: reason });
  });

  it("ignore un payload inattendu ou un autre événement", () => {
    expect(detectTrigger("issue_comment", { action: "created" }, settings)).toEqual({
      ignored: "payload_unexpected",
    });
    expect(detectTrigger("push", {}, settings)).toEqual({ ignored: "event_not_handled" });
  });
});

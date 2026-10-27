import { describe, expect, it } from "vitest";
import { REQUIRED_EVENTS, REQUIRED_PERMISSIONS, checkAppSetup } from "./app-setup.js";

const valid = {
  slug: "jules",
  permissions: { ...REQUIRED_PERMISSIONS },
  events: [...REQUIRED_EVENTS],
};

describe("checkAppSetup", () => {
  it("accepte l'App configurée comme dans ARCHITECTURE.md §12", () => {
    expect(checkAppSetup(valid)).toEqual({ errors: [], warnings: [] });
  });

  it.each(["workflows", "administration", "secrets", "actions", "environments"])(
    "refuse la permission %s, même en lecture",
    (name) => {
      const report = checkAppSetup({
        ...valid,
        permissions: { ...valid.permissions, [name]: "read" },
      });
      expect(report.errors).toEqual([`permission interdite accordée à l'App : ${name}:read`]);
    },
  );

  it("signale une permission manquante, insuffisante ou inutile", () => {
    const report = checkAppSetup({
      ...valid,
      permissions: {
        metadata: "read",
        contents: "read",
        pull_requests: "write",
        issues: "write",
        checks: "write",
        deployments: "write",
        security_events: "write",
        discussions: "write",
      },
    });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      "permission insuffisante : contents est à read, write attendu",
      "permission inutile : discussions:write",
    ]);
  });

  it("signale un événement non abonné", () => {
    const report = checkAppSetup({ ...valid, events: valid.events.filter((e) => e !== "push") });
    expect(report.warnings).toEqual(["événement non abonné : push"]);
  });
});

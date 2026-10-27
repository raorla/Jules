import { describe, expect, it } from "vitest";
import { latestJson } from "./release.js";

describe("manifeste des mises à jour", () => {
  const release = {
    version: "0.2.0",
    baseUrl: "https://github.com/acme/jules/releases/download/desktop-v0.2.0/",
    notes: "Corrections",
    date: new Date(Date.UTC(2026, 9, 27)),
  };

  it("associe chaque plateforme à son paquet signé", () => {
    const manifest = latestJson(
      [
        { name: "Jules_0.2.0_amd64.AppImage", signature: "sig-linux\n" },
        { name: "Jules_0.2.0_x64_fr-FR.msi", signature: "sig-windows" },
        { name: "Jules_universal.app.tar.gz", signature: "sig-mac" },
        { name: "Jules_0.2.0_amd64.deb" },
        { name: "Jules_0.2.0_x64_en-US.msi" },
      ],
      release,
    );
    expect(manifest).toEqual({
      version: "0.2.0",
      notes: "Corrections",
      pub_date: "2026-10-27T00:00:00.000Z",
      platforms: {
        "linux-x86_64": {
          signature: "sig-linux",
          url: "https://github.com/acme/jules/releases/download/desktop-v0.2.0/Jules_0.2.0_amd64.AppImage",
        },
        "windows-x86_64": {
          signature: "sig-windows",
          url: "https://github.com/acme/jules/releases/download/desktop-v0.2.0/Jules_0.2.0_x64_fr-FR.msi",
        },
        "darwin-aarch64": {
          signature: "sig-mac",
          url: "https://github.com/acme/jules/releases/download/desktop-v0.2.0/Jules_universal.app.tar.gz",
        },
        "darwin-x86_64": {
          signature: "sig-mac",
          url: "https://github.com/acme/jules/releases/download/desktop-v0.2.0/Jules_universal.app.tar.gz",
        },
      },
    });
  });

  it("refuse une publication sans aucun paquet signé", () => {
    expect(() => latestJson([{ name: "Jules_0.2.0_amd64.AppImage" }], release)).toThrow(
      "aucun paquet signé",
    );
  });
});

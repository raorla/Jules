import "@jules/ui/styles.css";
import { JulesApp, type DesktopBridge } from "@jules/ui";
import { createRoot } from "react-dom/client";
import { tauriBridge } from "./bridge.js";

// Les tests Playwright injectent un pont simulé : un navigateur n'a pas accès à Tauri.
const injected = (window as { __JULES_DESKTOP_BRIDGE__?: DesktopBridge }).__JULES_DESKTOP_BRIDGE__;
const root = document.getElementById("root");
if (root) {
  void (injected ? Promise.resolve(injected) : tauriBridge()).then((bridge) => {
    createRoot(root).render(<JulesApp desktop={bridge} />);
  });
}

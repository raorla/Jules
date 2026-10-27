import "@jules/ui/styles.css";
import { JulesApp } from "@jules/ui";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<JulesApp />);
}

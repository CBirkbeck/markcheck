import { defineManifest } from "@crxjs/vite-plugin";

// UEA eVision (SITS). Replace the host for a different institution.
export const EVISION_MATCH = "https://evision.uea.ac.uk/*";

export default defineManifest({
  manifest_version: 3,
  name: "markcheck — eVision/Blackboard mark checker",
  version: "0.1.0",
  description: "Compare student marks between eVision and Blackboard, entirely in your browser.",
  permissions: ["storage", "scripting", "tabs"],
  host_permissions: [EVISION_MATCH],
  action: { default_popup: "src/popup/popup.html", default_title: "markcheck" },
  background: { service_worker: "src/background/service-worker.ts", type: "module" },
  content_scripts: [{ matches: [EVISION_MATCH], js: ["src/content/content.ts"], run_at: "document_idle" }],
});

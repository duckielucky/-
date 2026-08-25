import { access } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const requiredFiles = [
  ".openai/hosting.json",
  "app/page.tsx",
  "app/layout.tsx",
  "app/globals.css",
  "public/login.html",
  "public/profile.html",
  "public/manager.html",
  "worker/index.ts",
  "vite.config.ts",
];

const missingFiles = [];

for (const file of requiredFiles) {
  try {
    await access(new URL(file, projectRoot));
  } catch {
    missingFiles.push(file);
  }
}

if (missingFiles.length > 0) {
  console.error("Cloudflare source check failed. Missing required files:");
  for (const file of missingFiles) console.error(`- ${file}`);
  process.exit(1);
}

console.log("Cloudflare source check passed: Lucky project files are complete.");

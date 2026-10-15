#!/usr/bin/env node
// Reads requirements.txt and installs it with npm.
// requirements.txt is the human-edited source of truth; package.json follows.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const requirementsPath = join(projectRoot, "requirements.txt");

if (!existsSync(requirementsPath)) {
  console.error(`requirements.txt not found at ${requirementsPath}`);
  process.exit(1);
}

const prod = [];
const dev = [];

for (const rawLine of readFileSync(requirementsPath, "utf-8").split("\n")) {
  const line = rawLine.replace(/#.*$/, "").trim();
  if (!line) continue;

  const isDev = /\s--dev$/.test(line);
  const spec = line.replace(/\s--dev$/, "").trim();
  if (!spec) continue;

  (isDev ? dev : prod).push(spec);
}

if (prod.length === 0 && dev.length === 0) {
  console.error("requirements.txt lists no packages.");
  process.exit(1);
}

function install(specs, flag, label) {
  if (specs.length === 0) return;
  console.log(`\nInstalling ${specs.length} ${label} package(s):`);
  for (const s of specs) console.log(`  ${s}`);

  const result = spawnSync("npm", ["install", flag, ...specs], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    console.error(`\nnpm install ${flag} failed with exit code ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}

install(prod, "--save", "runtime");
install(dev, "--save-dev", "dev");

console.log("\nDependencies installed. Next: npm run build");

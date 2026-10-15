#!/usr/bin/env node
// Install Cullus as a background service.
//
// Why this exists: scheduled jobs only fire while the process is running. If
// you start the assistant from a terminal and close the window, nothing is
// scheduled any more — the "check Oanda every 15 minutes" job just stops, with
// no error, because there is nothing left to run it.
//
// A service manager fixes that. It starts the assistant at login, restarts it
// if it crashes, and keeps it alive with no terminal attached.
//
//   macOS  launchd  ~/Library/LaunchAgents/com.assistant.cli.plist
//   Linux  systemd  ~/.config/systemd/user/cullus.service
//
// Both are USER services, not system ones. The assistant reads your vault, your
// Keychain and your home directory — it should run as you, not as root.
//
// Usage:
//   node scripts/install-service.mjs            print what would be written
//   node scripts/install-service.mjs --install  write it and load it
//   node scripts/install-service.mjs --uninstall

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const entry = path.join(projectRoot, "dist", "index.js");
const nodeBin = process.execPath;
const logDir = path.join(os.homedir(), ".cullus", "logs");

const LABEL = "com.cullus";
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const UNIT_PATH = path.join(os.homedir(), ".config", "systemd", "user", "cullus.service");

const mode = process.argv.includes("--install")
  ? "install"
  : process.argv.includes("--uninstall")
    ? "uninstall"
    : "print";

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${entry}</string>
  </array>

  <!-- Start at login and keep it running. KeepAlive restarts it if it exits
       for any reason, which is what makes scheduled jobs survive a crash. -->
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <!-- Ollama lives in /usr/local/bin or /opt/homebrew/bin. launchd does not
       inherit your shell PATH, so without this the assistant starts but cannot
       find the thing it needs most. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>${projectRoot}</string>

  <key>StandardOutPath</key>
  <string>${path.join(logDir, "cullus.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, "cullus.error.log")}</string>

  <!-- Do not thrash if it is failing to start: wait 10s between attempts. -->
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
}

function unit() {
  return `[Unit]
Description=Cullus — local AI assistant with scheduled jobs
Documentation=file://${projectRoot}/README.md
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${entry}
WorkingDirectory=${projectRoot}

# Restart on any exit, including a clean one, so scheduled jobs survive a crash.
# RestartSec keeps it from thrashing if startup itself is broken.
Restart=always
RestartSec=10

# Ollama is usually on the user PATH; systemd user units get a minimal one.
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

# SIGTERM triggers the graceful shutdown in src/core/lifecycle.ts, which stops
# the scheduler, drains in-flight jobs and disconnects MCP. Give it room to do
# that before SIGKILL -- the drain budget is 15s.
KillSignal=SIGTERM
TimeoutStopSec=25

StandardOutput=append:${path.join(logDir, "cullus.log")}
StandardError=append:${path.join(logDir, "cullus.error.log")}

[Install]
WantedBy=default.target
`;
}

const isMac = process.platform === "darwin";
const targetPath = isMac ? PLIST_PATH : UNIT_PATH;
const contents = isMac ? plist() : unit();

if (!isMac && process.platform !== "linux") {
  console.error(`Unsupported platform: ${process.platform}. Install a service manually.`);
  process.exit(1);
}

if (mode === "print") {
  console.log(`Would write ${targetPath}:\n`);
  console.log(contents);
  console.log(`Run with --install to write and load it, or --uninstall to remove it.`);
  process.exit(0);
}

if (mode === "uninstall") {
  try {
    if (isMac) execFileSync("launchctl", ["unload", targetPath], { stdio: "ignore" });
    else {
      execFileSync("systemctl", ["--user", "disable", "--now", "cullus.service"], { stdio: "ignore" });
    }
  } catch {
    /* not loaded; removing the file is still the right outcome */
  }
  fs.rmSync(targetPath, { force: true });
  console.log(`Removed ${targetPath}`);
  process.exit(0);
}

// --install
if (!fs.existsSync(entry)) {
  console.error(`dist/index.js not found. Run \`npm run build\` first.`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(targetPath, contents, "utf-8");
console.log(`Wrote ${targetPath}`);

try {
  if (isMac) {
    // Unload first so --install is idempotent and picks up a changed plist.
    try {
      execFileSync("launchctl", ["unload", targetPath], { stdio: "ignore" });
    } catch {
      /* was not loaded */
    }
    execFileSync("launchctl", ["load", targetPath], { stdio: "inherit" });
    console.log(`\nLoaded. It will start at login and restart if it exits.`);
    console.log(`  status:  launchctl list | grep ${LABEL}`);
    console.log(`  stop:    launchctl unload ${targetPath}`);
  } else {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", "cullus.service"], { stdio: "inherit" });
    console.log(`\nEnabled and started.`);
    console.log(`  status:  systemctl --user status cullus`);
    console.log(`  stop:    systemctl --user stop cullus`);
    console.log(`\nIf jobs should run when you are not logged in: sudo loginctl enable-linger $USER`);
  }
  console.log(`  logs:    tail -f ${path.join(logDir, "cullus.log")}`);
} catch (err) {
  console.error(`\nWrote the file but could not load it: ${err.message}`);
  console.error(`Load it manually, or check the log at ${logDir}.`);
  process.exit(1);
}

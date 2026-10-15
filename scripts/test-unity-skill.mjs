// Does the /unity skill hold its output structure, and does /effort change that?
//
// The skill worked on its first real run — read-only discovery, two behaviour
// questions, no writes, all five plan headings. What leaked was structure:
//
//   • Only 1 of 4 "WHAT I WILL BUILD" lines opened with a Unity term. The rest
//     were "a new method", "an Input system listener", "a function" — so the
//     glossary the skill exists to teach went unused.
//   • The build prompt had no Rules section at all, and the seven Unity rules
//     were pasted into Steps, where the first one reads "...list those command
//     names in Step 1" while BEING step 1 and listing none.
//   • It promised not to touch the Rigidbody, then added force to it.
//
// The pattern: sections with distinctive ALL-CAPS headers survived; anything
// described in prose was dropped or mangled. So the skill's Stage 4 was
// rewritten from a prose list of headings into a literal fill-in template —
// which is the rule the /prompt skill already states and /unity did not follow:
// a model copies a sample; it argues with a description.
//
// This measures whether that worked, and whether /effort high is doing any of
// the lifting. Structure is scored mechanically rather than by reading it, so
// two runs are comparable.
//
// The turn is NOT isolated, because isolated turns never think (provider.ts
// line ~2090) and thinking is most of what /effort high buys. Instead it runs
// in a FRESH session that is activated for the test and deactivated after, so
// the live transcript is untouched either way.
//
// Usage: node scripts/test-unity-skill.mjs [effort] [model]
// Requires: npm run build, Ollama running, Unity Editor open on TronGame

import fs from "fs";
import os from "os";
import path from "path";

const effort = process.argv[2] ?? "high";
const model = process.argv[3] ?? "gemma4:latest";
const IDEA = "a throwing disc weapon that bounces off arena walls and comes back to me";
const PROJECT = "/Users/warrenwhite/TronGame";

const { getAiResponse } = await import("../dist/core/provider.js");
const { updateSettings, getEffortProfile } = await import("../dist/core/session.js");
const { setInquiryHandler } = await import("../dist/core/inquiry.js");
const { registerConfiguredServers } = await import("../dist/core/mcpServers.js");
const { mcpManager } = await import("../dist/core/mcpManager.js");
const { loadConfig } = await import("../dist/core/config.js");
const sessions = await import("../dist/core/sessions.js");
const gitBaseline = await import("../dist/core/gitBaseline.js");

for (const granted of loadConfig().allowedPaths ?? []) {
  if (fs.existsSync(granted)) mcpManager.addAllowedPath(granted);
}
await registerConfiguredServers();

// The skill forbids writes. Snapshot anyway: "it should not write" is the thing
// under test, so the run must be survivable if it does.
const before = gitBaseline.snapshot(PROJECT, `before /unity test at effort ${effort}`);
console.log(`\nSnapshot: ${before.action}${before.sha ? ` (${before.sha})` : ""}`);

// Answer the skill's ask_user calls the way the user did on the real run, so
// the two are comparable. Anything unrecognised takes the first option, which
// is the skill's own "recommended first" slot.
const answers = [
  { match: /return|come back|recall/i, pick: "Press a key to call it back" },
  { match: /touch|collide|damage|enemy/i, pick: "Just bounce, deal no damage" },
];
const asked = [];

setInquiryHandler(async (request) => {
  const rule = answers.find((a) => a.match.test(request.question));
  const labels = request.options.map((o) => o.label);
  const chosen = rule && labels.includes(rule.pick) ? rule.pick : labels[0] ?? "yes";
  asked.push({ question: request.question, chosen });
  console.log(`  ask_user: "${request.question.slice(0, 90)}" → ${chosen}`);
  return { chosen: [chosen] };
});

// Fresh session, so nothing lands in the live transcript.
const previousActive = loadConfig().activeSessionId;
const testSession = sessions.createSession(`/unity structure test — effort ${effort}`);
sessions.activateSession(testSession.id);

const skillRaw = fs.readFileSync(path.join(os.homedir(), ".cullus/skills/unity.md"), "utf-8");
const skillBody = skillRaw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)?.[1]?.trim() ?? skillRaw;
const PROMPT = `${skillBody} ${IDEA}`;

const profile = getEffortProfile(effort);
updateSettings({ effort });

console.log(`\n/unity at /effort ${effort} on ${model}`);
console.log(`  think: ${profile.think}   numPredict: ${profile.numPredict}   max steps: ${profile.maxSteps}`);
console.log(`  skill body: ${skillBody.split(/\s+/).length} words`);
console.log(`  test session: ${testSession.id}\n`);

const WRITE_TOOLS = /^(write_file|write_text_file|edit_file|create_|set_|add_|delete_|attach_|instantiate_|save_|recompile|eval|run_script|move_|rename_)/;
const toolsUsed = [];
const startedAt = Date.now();
let answer = "";
let thrown = null;

try {
  const result = await getAiResponse(PROMPT, model, undefined, (toolName) => {
    toolsUsed.push(toolName);
    const writes = WRITE_TOOLS.test(toolName) && toolName !== "set_inquiry";
    console.log(`  step ${toolsUsed.length}: ${toolName}${writes ? "  ← WRITE" : ""}`);
  });
  answer = result?.content ?? "";
} catch (err) {
  thrown = err;
} finally {
  setInquiryHandler(null);
  if (previousActive) sessions.activateSession(previousActive);
}

const seconds = Math.round((Date.now() - startedAt) / 1000);
console.log(`\n--- ${seconds}s, ${toolsUsed.length} tool calls ---\n`);
if (thrown) console.log(`The turn threw: ${thrown.message}\n`);

// -------------------------------------------------------------------------
// Score the structure
// -------------------------------------------------------------------------

let pass = 0;
const results = [];

function check(label, condition, detail = "") {
  results.push({ label, ok: Boolean(condition), detail });
  if (condition) pass++;
}

const PLAN_HEADINGS = [
  "WHAT YOU ASKED FOR",
  "WHAT I WILL BUILD",
  "WHAT YOU WILL SEE WHEN IT IS DONE",
  "WHAT I WILL NOT TOUCH",
  "WHAT COULD LOOK WRONG",
];

for (const heading of PLAN_HEADINGS) {
  check(`plan has ${heading}`, answer.includes(heading));
}

// Every numbered line under WHAT I WILL BUILD must open with a glossary term.
// This is the check the first run failed 3 times out of 4.
const GLOSSARY = [
  "GameObject", "Component", "Transform", "Mesh", "MeshRenderer", "MeshFilter",
  "Collider", "CapsuleCollider", "MeshCollider", "Rigidbody", "Material",
  "Prefab", "Script", "Serialized field", "Tag", "Layer", "Scene",
];

const buildSection = answer.split("WHAT I WILL BUILD")[1]?.split("WHAT YOU WILL SEE")[0] ?? "";
const buildLines = buildSection
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^\d+[.)]\s/.test(l));

const openedWithTerm = buildLines.filter((line) => {
  const body = line.replace(/^\d+[.)]\s*/, "").replace(/^[*`]+/, "");
  return GLOSSARY.some((term) => body.toLowerCase().startsWith(term.toLowerCase()));
});

check(
  `every WHAT I WILL BUILD line opens with a glossary term (${openedWithTerm.length}/${buildLines.length})`,
  buildLines.length > 0 && openedWithTerm.length === buildLines.length,
  buildLines
    .filter((l) => !openedWithTerm.includes(l))
    .map((l) => l.slice(0, 70))
    .join(" | ")
);

// The build prompt: a fenced block carrying all seven headings.
const fenced = answer.match(/```[a-z]*\n([\s\S]*?)```/g) ?? [];
const promptBlock = fenced.map((b) => b.replace(/```[a-z]*\n?/g, "")).find((b) => /Role:/.test(b)) ?? "";

check("a fenced build prompt was emitted", promptBlock.length > 0);

for (const heading of ["Role:", "Task:", "Inputs:", "Steps:", "Rules:", "Done when:", "If stuck:"]) {
  check(`prompt has ${heading}`, promptBlock.includes(heading));
}

// The specific regression: rules pasted into Steps. A Steps list carrying the
// verbatim rule text is the failure, and the self-referential "in Step 1" is
// its signature.
const stepsSection = promptBlock.split("Steps:")[1]?.split(/\n\s*Rules:/)[0] ?? "";
check(
  "no rule text leaked into Steps",
  !/in Step 1|before the first call to that command|Unity's names are prefixed/i.test(stepsSection),
  stepsSection.slice(0, 160)
);

check(
  "Rules section is non-empty",
  (promptBlock.split("Rules:")[1]?.split(/\n\s*Done when:/)[0] ?? "").trim().length > 20
);

// Consistency: the run must not have written anything, because the skill says so.
const writesUsed = toolsUsed.filter((t) => WRITE_TOOLS.test(t));
check("no write tool was called", writesUsed.length === 0, writesUsed.join(", "));

// And the closing line has a fixed form now.
check("closes with the /build line", /Run \/build/i.test(answer));

// Did it finish, or run out of turn?
check("finished in one turn", !answer.includes("[[CONTINUE]]"));

console.log("Structure score:");
for (const r of results) {
  console.log(`  ${r.ok ? "🟢" : "🔴"} ${r.label}${!r.ok && r.detail ? `\n       ${r.detail}` : ""}`);
}

console.log(`\n${pass}/${results.length} structural checks passed at /effort ${effort}.`);
console.log(`Questions asked: ${asked.length}`);

// Leave the project as it was, whatever happened.
const after = gitBaseline.undoToSnapshot(PROJECT);
console.log(`Project restored: ${after.action}${after.message ? ` — ${after.message}` : ""}`);

// Model in the filename: keyed on effort alone, the 35B run overwrote the
// gemma4 one it was supposed to be compared against.
const outPath = `/tmp/unity-skill-${effort}-${model.replace(/[^a-z0-9.]+/gi, "-")}.md`;
fs.writeFileSync(outPath, answer, "utf-8");
console.log(`\nFull output: ${outPath}`);
console.log(`Test session (safe to delete): ${testSession.id}\n`);

process.exit(0);

// Skills: reusable prompt macros stored as markdown in ~/.cullus/skills/.
//
// A skill is just a prompt prefix with a name and description — the same shape
// as Claude Code's slash-command skills, but resolved locally. This keeps
// `/verify`, `/run` and friends editable by the user instead of hardcoded, and
// means adding a new one is dropping a .md file in a folder.
//
// Format: YAML-ish frontmatter with `description:`, then the prompt body.

import * as fs from "fs";
import * as path from "path";
import { CONFIG_DIR, ensureConfigDir } from "./config.js";
import { vaultPathFor, resolveInVault, listVaultNotes, writeVaultNote } from "./vaultStore.js";

export const SKILLS_DIR = path.join(CONFIG_DIR, "skills");

export interface Skill {
  name: string;
  description: string;
  prompt: string;
  builtin: boolean;
  /** Where it came from, so the UI can say "edit this in Obsidian". */
  source?: "vault" | "file" | "builtin";
  /** Vault-relative path, for skills authored as notes. */
  vaultPath?: string;
}

/** Shipped skills, written to disk on first run so they can be edited. */
const BUILTIN_SKILLS: Array<{ name: string; description: string; prompt: string }> = [
  {
    name: "pipeline",
    description:
      "Plan a Unity job, a Blender job, or a Blender-into-Unity job — the decisive questions, " +
      "the traps, and a build prompt to paste",
    // Long enough to be a template literal rather than concatenation: it is a
    // document, and every trap in it is one this project paid for once. See
    // validatePipeline in skillValidators.ts for the sections that are checked,
    // because a planning skill degrades towards generic advice and generic
    // advice reads fine.
    prompt: `Plan the 3D job below. Do not build it. Edit no files, and call no Unity or Blender command that writes.

Assume I know what I want and not what it is called. Teach the terms as you go, and tell me which facts decided the plan, so I know what to state up front next time.

STAGE 1 — NAME THE JOB, IN ONE LINE.
Exactly one of:
• UNITY — behaviour, scenes, scripts, physics, gameplay. Nothing new is modelled.
• BLENDER — geometry, materials, UVs, rigging. Nothing goes into the game yet.
• BRIDGE — something modelled in Blender has to end up working in Unity.
Say which and why. If it is really two jobs, say so and plan the first only.

STAGE 2 — READ THE ACTUAL STATE FIRST. DO NOT ASK ME ANY OF IT.
Read-only tools only.
• Unity: list_open_scenes, get_scene_hierarchy, get_component_properties, get_tags_layers, unity_symbol, list_directory, read_text_file. Establish the render pipeline (URP or built-in), the scene that is open, where scripts and materials live, and whether something already does most of this. If a script does, extend it rather than adding a second one.
• Blender: get_addon_status, get_scene_info, get_object_info. Establish what is in the scene, the unit scale, and where each object's origin sits.
• If a Blender call fails with a connection error, stop and tell me to start the addon's server (N in the viewport → MCP → Start MCP Server). Only I can do that.
State in one line each what you found. If a tool was unavailable, say which and what you could not therefore check.

STAGE 3 — ASK ME AT MOST THREE QUESTIONS.
Use ask_user, one per call, 2–4 concrete options, your recommendation first. Ask only what changes the outcome and only what the files cannot answer. Never ask me to choose a technical term — pick it and explain it.

STAGE 4 — THE PLAN. These headings, exactly, in this order.

WHAT YOU ASKED FOR
One sentence in my words.

THE FACTS THAT DECIDE THIS
Three to five bullets, each a fact you established in Stage 2 or asked in Stage 3, and what it forces. This section is the point of the skill: it teaches me which facts to state up front. Example shape:
• The project is URP, so a material built for the built-in pipeline renders magenta — every material has to be URP/Lit.
• The bike is 4.3 units long, so the trail anchor cannot sit at -1.9 or the wall starts inside its own back wheel.

WHAT I WILL BUILD
Numbered. Start every line with a term from the glossary below, then a dash, then what it means in plain English, then a dash, then why it is needed.
  1. Collider on the step — the invisible shape physics uses for contact — without it the stair is scenery you walk through.
GLOSSARY — the only terms allowed to open a line:
  Unity: GameObject, Component, Transform, Mesh, Collider, Rigidbody, CharacterController, Material, Prefab, Scene, Script, Layer, Tag.
  Blender: Object, Mesh, Modifier, Origin, Material, UV Map, Armature, Empty, Collection.
  Bridge: FBX, GLB, Import Settings, Resources folder, Prefab.
A method, a field or a coroutine is not a glossary term — those are parts of a Script, so name the script and say what it will do.

WHAT I WILL NOT TOUCH
The scenes, scripts and assets you will leave alone. Be specific; this is the promise I hold you to.

HOW IT CAN GO WRONG HERE
Only the traps that apply to THIS job, each with the specific number or name from this project. Draw from the list in Stage 5. Three to six of them. No generic advice.

HOW WE WILL KNOW IT WORKED
Stage 6. Concrete calls with concrete arguments, and the answer that counts as a pass.

STAGE 5 — THE TRAP LIST. Every one of these has actually happened in this project.

BRIDGE, on the way out of Blender:
• Axes. Blender is Z-up and models usually face +Y; Unity is Y-up and faces +Z. Expect a quarter-turn about X on arrival, and say where you will apply it.
• Origin. A model whose origin is at ground level must not inherit an offset written for a primitive cube whose origin is its centre — that left every bike hovering 0.65 above the deck.
• Apply modifiers before export, or the bevel and subdivision you can see in Blender are not in the file.
• Export a named selection, not the scene. The camera and the default light will otherwise be in your FBX.
• Name the parts you will treat differently. Glow strips have to be separate, named geometry or nothing in Unity can assign them a different material.
• Triangle count. State it. One light cycle came in at 36,648 triangles, which is fine for four bikes and not for forty.

BRIDGE, on the way into Unity:
• An FBX carries no URP materials. Every renderer needs a material assigned in Unity, in code or on a prefab.
• A material tuned to make primitives read as lit will blow out on real geometry — emissive 2.6 turned a modelled bike into a featureless yellow blob. Real meshes want a dark shell and emissive trim.
• Runtime loading needs Assets/Resources (Resources.Load by name) — AssetDatabase is editor-only, so a thing spawned during play cannot use it.
• Colliders do not come from the model. Decide explicitly: keep the CharacterController, add a primitive collider, or generate a mesh collider and pay for it.

UNITY, behaviour and verification:
• Geometry placed inside other geometry compiles, saves and screenshots perfectly, and cannot be walked on. A 32-step stair built inside a mountain passed every check there was.
• Play mode does not tick while the Editor is unfocused, and focus cannot be held by an automated caller. Anything read from a frozen editor is one still frame. Check Time.frameCount advanced, or drive the system at an explicit delta instead.
• \`recompile\` answers "up_to_date" both when your edit is compiled and when it was never seen. After editing files outside the Editor, refresh the asset database, and confirm a symbol you added actually exists.
• A collider thinner than (speed × fixedDeltaTime) is tunnelled. At 26 m/s a bike passes through a 0.18m wall. Use a swept cast, not a trigger.
• Writing Rigidbody.position does not reach the Transform without a physics step — a held crate was three metres up while every check read it as on the floor.
• Two scripts calling Move() on one CharacterController in a frame move it twice. One owner.

STAGE 6 — THE VERIFICATION PLAN. Name the calls, with arguments.
• unity_scene_audit — cameras, lights, missing scripts, bad transforms, thin colliders.
• unity_scene_overlaps — surfaces with solid matter above them. Name what you expect to be reported as deliberate, so a real find stands out.
• unity_walk_probe — prove every route a player needs. Give \`from\`, \`to\`, and \`via\` waypoints for anything that is not a straight line, with real coordinates from Stage 2. A blocked result without waypoints only means "not in a straight line".
• For behaviour over time — damage, flight, fuel, a trail — a scene-side probe with static entry points, driven at a fixed delta. GlassArenaProbe, LightCycleProbe and MandoProbe in TronGame are the pattern.
• For a bridge job, also: the child object names and per-mesh triangle counts Unity reports after import, and a screenshot path (images are written to ~/.cullus/captures and returned as a path — open it, or say plainly you cannot and verify by measurement instead).

STAGE 7 — THE BUILD PROMPT.
A fenced block I can paste, written as instructions to whoever builds it. It must contain: the one-line job, the exact paths and names to use, the numbered build steps, an explicit "do not touch" list, the traps from Stage 4 restated as constraints, and a DONE MEANS section whose criteria are all checkable by the calls in Stage 6.
Keep it to one slice of work. If the job is bigger than one slice, say what the next slice is and leave it out.

The job:
`,
  },
  {
    name: "verify",
    description:
      "Verify a change actually works by exercising it end-to-end, not just by reading code",
    prompt:
      "Verify the change described below actually does what it is supposed to do.\n\n" +
      "Rules:\n" +
      "1. Do not conclude from reading code alone. Run something.\n" +
      "2. Drive the affected flow end-to-end with execute_shell_command and observe real output.\n" +
      "3. Report the exact command you ran and the exact output you saw.\n" +
      "4. If it fails, say so plainly and quote the failure. Do not soften it.\n" +
      "5. State explicitly anything you could NOT verify and why.\n\n" +
      "What to verify:\n",
  },
  {
    name: "run",
    description: "Launch this project's app and confirm a change works in the real thing",
    prompt:
      "Launch this project and confirm it actually starts.\n\n" +
      "Steps:\n" +
      "1. Inspect the working directory to identify the project type (look for package.json, " +
      "pyproject.toml, Cargo.toml, Makefile).\n" +
      "2. Find the documented start command rather than guessing.\n" +
      "3. Run it, capture the output, and report whether it started.\n" +
      "4. If it fails, quote the error and name the single most likely cause.\n\n" +
      "Additional context:\n",
  },
  {
    name: "fix",
    description:
      "The repair method /fix follows — editable, so you can tune how the loop reasons",
    prompt:
      "Repair the problem below by evidence, not by inspection.\n\n" +
      "Method:\n" +
      "1. Reproduce first. Run the project's build and verify commands and read the actual output. " +
      "Never diagnose from source alone.\n" +
      "2. Probe reality once. If the failure output is not conclusive, run ONE read-only command " +
      "that settles it (curl the endpoint, print the resolved value, list what exists).\n" +
      "3. Find every reference, not the first one. Grep for the identifier, the error string and " +
      "the filename before deciding which file is wrong.\n" +
      "4. Make the smallest exact edit that fixes the cause. Quote existing text verbatim, " +
      "including indentation, and make it unique.\n" +
      "5. Rebuild and re-verify. A green build is the only evidence that counts; say so plainly " +
      "when it is still red.\n" +
      "6. Sweep for leftovers. Anything that referenced a name you removed — comments, README, " +
      "other modules — is part of the same change.\n" +
      "7. If two attempts produce the identical failure, stop and revert rather than guessing " +
      "a third time.\n\n" +
      "What to repair:\n",
  },
  {
    name: "learn",
    description:
      "Reflect on what just happened and capture the reusable part as a skill you can run again",
    prompt:
      "Reflect on this conversation and capture what is worth keeping.\n\n" +
      "Look for two things:\n" +
      "• A success — something that worked, where the METHOD would work again on a " +
      "different subject.\n" +
      "• A correction — somewhere the user redirected you, where the correction " +
      "generalises beyond the specific case.\n\n" +
      "Method:\n" +
      "1. Say in one or two lines what actually happened. Quote the user's own words " +
      "when they corrected you; a remembered paraphrase drifts toward what you wanted " +
      "to hear.\n" +
      "2. Name the reusable part. Ask: on a different subject next week, what would I " +
      "do differently having learned this? If the answer is nothing, there is no skill " +
      "here — say so and stop. A skill is a method, not a fact.\n" +
      "3. Check it is not already covered. Call list_skills first; if an existing skill " +
      "covers it, propose an edit to that one instead of a near-duplicate.\n" +
      "4. Write it as numbered, executable steps in the imperative — the same shape as " +
      "the skills you already have. Each step must be something a reader can do, not a " +
      "principle to hold in mind.\n" +
      "5. Save it with skill_write. Give it a short kebab-case name that says what it " +
      "does, and tell the user the slash command that now runs it.\n\n" +
      "Rules:\n" +
      "• One skill per run. Two half-observations are worth less than one you can act on.\n" +
      "• Capture the method, never the specifics of this session. \"Check the running " +
      "port before assuming the build is live\" is a skill; \"port 3000 was busy\" is not.\n" +
      "• Include what NOT to do when a correction taught you that — the failure mode is " +
      "usually the reusable half.\n" +
      "• If nothing generalises, say so plainly and write nothing. A thin skill file is " +
      "worse than none: it gets loaded and followed anyway.\n\n" +
      "Anything specific to reflect on (blank means the whole conversation):\n",
  },
  {
    name: "prompt",
    description:
      "Interview me about a rough ask, then write a finished prompt a small local model can follow",
    prompt:
      "Turn my rough ask below into a finished prompt that a SMALL LOCAL MODEL can follow " +
      "without guessing. You are writing the prompt, not doing the work described in it. " +
      "Do not start the task, do not open files to begin it, and do not answer the ask.\n\n" +
      "Stage 1 — interview me. Ask with the ask_user tool, ONE question per call, with 2-5 " +
      "concrete options and a recommended one first. Ask at most 6 questions, fewest that " +
      "close the real gaps. Skip anything my ask already answers, and skip anything you can " +
      "settle yourself by reading a file or listing a directory — do that instead of asking.\n" +
      "Cover only the gaps that would change the output:\n" +
      "1. Deliverable — what exists at the end: a file, an edited file, a command run, an " +
      "answer on screen? Which path?\n" +
      "2. Inputs — which files, folders, URLs or values does it work from? Exact paths.\n" +
      "3. Done test — what does the model check to know it succeeded?\n" +
      "4. Boundaries — what must it NOT touch, and does it need permission before writing?\n" +
      "5. Shape — format, length, language, style of the output.\n" +
      "6. Failure — what should it do when it gets stuck or the input is missing?\n\n" +
      "Stage 2 — write the prompt. Output it as ONE fenced code block, plain text, nothing " +
      "after it but a two-line note on how to use it. Build it in this fixed order, with these " +
      "headings, dropping any section that would be empty:\n" +
      "  Role: one line — what the model is doing.\n" +
      "  Task: one sentence, imperative, one deliverable.\n" +
      "  Inputs: exact paths and values, one per line.\n" +
      "  Steps: 3-7 numbered steps, one action each, in order.\n" +
      "  Rules: hard limits, one per line, phrased as what TO do.\n" +
      "  Output: the exact shape wanted, with a short worked example of the format.\n" +
      "  Done when: the check that proves it worked.\n" +
      "  If stuck: the one fallback action.\n\n" +
      "Rules for the prompt you write — small models fail on the opposite of each:\n" +
      "• Short sentences. One instruction per line. No paragraph holding three asks.\n" +
      "• Name every file, path, tool and value literally. Never \"the config\" or \"the usual place\".\n" +
      "• Say what TO do, not what to avoid. \"Reply with JSON only\" beats \"don't add prose\".\n" +
      "• Show the output format by example. A model copies a sample; it argues with a description.\n" +
      "• No nested conditionals, no \"if X then maybe Y unless Z\". Split into steps.\n" +
      "• Keep it under about 400 words. A long prompt buries its own instructions.\n" +
      "• No politeness, no backstory, no \"you are a world-class expert\". State the job.\n\n" +
      "My rough ask:\n",
  },
  {
    name: "money",
    description:
      "Find and take the highest expected-value trades available right now, within the risk budget",
    prompt:
      "Make the most money available today WITHOUT breaking the risk rules. The rules are the " +
      "point: an account that survives is the only one that compounds.\n\n" +
      "Do this in order, with tools — do not describe it:\n" +
      "1. oanda_status. If the daily loss stop is already hit or margin is tight, stop here and " +
      "say so. That is the answer on those days.\n" +
      "2. oanda_daily_plan. This scans the watchlist, measures each pair+strategy out of sample, " +
      "and ranks every candidate by expected value in account currency.\n" +
      "3. Report the plan before acting: each recommended trade, its size, what it risks, its " +
      "expected value, and the total expected gain with best and worst case.\n" +
      "4. For any trade you are about to place, run oanda_pretrade_research first. A technical " +
      "signal into a rate decision is not an edge.\n" +
      "5. Place them with oanda_create_order, one at a time, confirm: true. Report each fill or " +
      "refusal exactly as returned.\n" +
      "6. Finish with the total risk now open and the worst case if every stop is hit.\n\n" +
      "Rules:\n" +
      "• Never raise risk to hit a number. If the plan says one trade, take one trade.\n" +
      "• Never place a trade the plan marked skip or blocked, whatever it looks like on a chart.\n" +
      "• If the server is locked read-only, produce the plan and say which toggle unlocks it. Do " +
      "not treat the lock as a problem to route around.\n" +
      "• Quote the worst case in money every time you quote the expected gain. They are the same " +
      "decision.\n" +
      "• A day with no trade is a correct outcome. Say so plainly rather than finding something.\n\n" +
      "Anything specific about today:\n",
  },
  {
    name: "roi",
    description:
      "Rank today's opportunities by expected return, with a calculated estimate of what each is worth",
    prompt:
      "Find the highest return-on-investment strategy available today and put a number on it. " +
      "Analysis only — place nothing.\n\n" +
      "Steps:\n" +
      "1. oanda_daily_plan with measure: true. Every candidate comes back priced.\n" +
      "2. oanda_rank_instruments if the plan reports that it priced anything on a prior rather " +
      "than a measurement — the measurement is the whole point of the estimate.\n" +
      "3. Present a table, best expected value first: pair, direction, strategy, units, risk, " +
      "reward if the target is hit, the hit rate used AND where that number came from, and the " +
      "expected value.\n" +
      "4. State the total: expected gain, best case, worst case, and the percentage of NAV each " +
      "represents.\n" +
      "5. Name the single highest-ROI setup and say in one sentence why it beat the others.\n\n" +
      "Rules:\n" +
      "• Distinguish measured from assumed every single time. A hit rate from 40 out-of-sample " +
      "trades and one from a break-even prior are not the same claim.\n" +
      "• Expected value is an average over many days like this one. Say that once, plainly.\n" +
      "• If nothing has positive expected value, the answer is 'nothing today' with the numbers " +
      "that show it. Do not manufacture a recommendation.\n" +
      "• Never present the best case as the expected outcome.\n\n" +
      "Anything to focus on:\n",
  },
  {
    name: "tradereport",
    description: "Report how the day or week's trades went and which strategies to keep or adjust",
    prompt:
      "Report on the trading period below and end with decisions, not just numbers.\n\n" +
      "Steps:\n" +
      "1. oanda_performance_report for the period asked for (default today; 'week' for the last " +
      "seven days).\n" +
      "2. oanda_open_trade_review for anything still running, so the report covers open risk as " +
      "well as closed P/L.\n" +
      "3. Write it in this order:\n" +
      "   • Headline: net P/L, trades closed, win rate, profit factor.\n" +
      "   • Per pair: what it made or lost, and the verdict — keep, adjust, stop, or watch.\n" +
      "   • Per strategy, where the report could attribute it. Say when it could not, and why.\n" +
      "   • Still open: each position, unrealised P/L, and whether it has a stop.\n" +
      "   • Actions: the specific parameter or pair to change, with the tool call that does it.\n" +
      "4. For any 'adjust' verdict, back it with oanda_backtest on that pair before recommending " +
      "a specific number. A parameter change with no measurement behind it is a guess.\n\n" +
      "Rules:\n" +
      "• Lead with sample size. Under about 20 trades, nothing here is significant, and saying so " +
      "is more useful than a ranking.\n" +
      "• Report losses first and in full. A report that buries the bad pair is worthless.\n" +
      "• Never recommend raising risk on the back of a winning week. That is the most expensive " +
      "conclusion available from a small sample.\n" +
      "• Separate 'this lost money' from 'this is broken'. Most losing weeks are variance.\n\n" +
      "Period to report on (blank means today):\n",
  },
  {
    name: "pairs",
    description: "Sweep every tradeable instrument and choose which pairs to trade",
    prompt:
      "Review the tradeable universe and the watchlist.\n\n" +
      "Steps:\n" +
      "1. oanda_list_instruments. This returns exactly what THIS account may trade, priced live — " +
      "no hardcoded list, so it already reflects the account's jurisdiction.\n" +
      "2. Report: how many instruments the account can trade, the breakdown by type, and the " +
      "current watchlist with each pair's spread-to-ATR and score.\n" +
      "3. Name the pairs worth adding and the ones worth dropping, each with the number that " +
      "justifies it — spread as a fraction of ATR is the one that matters most.\n" +
      "4. Only change the watchlist if asked. Use oanda_update_watchlist.\n" +
      "5. After any change, say that the new pairs trade on global parameters until " +
      "oanda_rank_instruments gives them their own measured profiles.\n\n" +
      "Rules:\n" +
      "• A wide watchlist is not a better one. More pairs means more correlated bets on the same " +
      "few currencies, not more diversification.\n" +
      "• Never add a pair whose spread exceeds the configured fraction of its ATR: every signal " +
      "on it will be rejected by the cost filter anyway.\n" +
      "• Say which currencies the watchlist is concentrated in. Six pairs containing USD is one bet.\n\n" +
      "What to look at:\n",
  },
  {
    name: "aggression",
    description: "Set how passive or aggressive the trading is, and show what actually changes",
    prompt:
      "Adjust the risk appetite.\n\n" +
      "Steps:\n" +
      "1. oanda_update_appetite with no level, to show the four presets and which is active.\n" +
      "2. oanda_status, so the recommendation is against the real balance and open risk.\n" +
      "3. If a level was named, show what changes BEFORE applying it: risk per trade, open-risk " +
      "ceiling, daily loss stop, stop and target distances, and the consensus threshold — old " +
      "value and new value, side by side.\n" +
      "4. Translate it into money on this account: what one losing trade costs, and what the " +
      "worst allowed day costs, at the old level and the new one.\n" +
      "5. Apply it with oanda_update_appetite, passing confirm: true for aggressive or max.\n\n" +
      "Rules:\n" +
      "• Always quote the drawdown in account currency, not percent alone. '2% per trade' and " +
      "'$400 a trade' land differently, and the second one is the real number.\n" +
      "• Aggressive and max increase the size of the loss, not the probability of a win. Say that " +
      "when applying either.\n" +
      "• Per-pair profiles override the appetite. Name any pair that will not follow the change.\n" +
      "• If the account is already down on the day, say so before raising anything.\n\n" +
      "Level wanted (blank shows the options):\n",
  },
  {
    name: "autopilot",
    description: "Set up and review the scheduled trader that manages and places trades by itself",
    prompt:
      "Configure or review the autopilot.\n\n" +
      "Steps:\n" +
      "1. oanda_update_autopilot with no arguments. This reports the current state AND the exact " +
      "reasons it is or is not allowed to open trades unattended.\n" +
      "2. oanda_autopilot_run with dryRun: true. This shows precisely what it would do right now " +
      "— stops moved, trades closed, positions opened — without doing any of it.\n" +
      "3. Explain the two modes in terms of what each can do without asking:\n" +
      "   • managed: moves stops to break-even, trails winners, closes invalidated trades. Only " +
      "ever reduces risk. New entries are queued for you.\n" +
      "   • full: also opens positions and places limit orders. Requires arming for a bounded " +
      "window, and allowLive on top of that for real money.\n" +
      "4. Apply only what was asked, with oanda_update_autopilot.\n" +
      "5. Say clearly that nothing runs on a schedule until a cron job calls oanda_autopilot_run, " +
      "and that the arming expires.\n\n" +
      "Rules:\n" +
      "• Never enable full mode or allowLive unless asked for in those words. Managed is the " +
      "default for a reason.\n" +
      "• State the environment — practice or live — in every response. It is the difference " +
      "between a simulation and money.\n" +
      "• Quote the worst case: maxNewTradesPerDay × risk per trade is what an unattended bad day " +
      "costs. Give it in account currency.\n" +
      "• Arming always expires. Never describe any configuration as permanently on.\n\n" +
      "What to set up:\n",
  },
  {
    name: "doctor",
    description: "Explain the current health report and what to fix first",
    prompt:
      "Review the Cullus health report supplied below.\n\n" +
      "For each problem: state what is broken, why it matters, and the exact command or " +
      "click that fixes it. Order by what blocks the most functionality. If everything is " +
      "healthy, say so in one line and stop.\n\nReport:\n",
  },
];

function parseSkillFile(filePath: string, name: string): Skill | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

    if (!match) {
      // No frontmatter: treat the whole file as the prompt.
      return { name, description: "(no description)", prompt: raw.trim(), builtin: false };
    }

    const description =
      match[1].match(/^description:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, "") ??
      "(no description)";

    return { name, description, prompt: match[2].trim(), builtin: false };
  } catch {
    return null;
  }
}

/** Write the built-in skills to disk once, so the user can edit them. */
export function seedBuiltinSkills(): void {
  try {
    ensureConfigDir();
    fs.mkdirSync(SKILLS_DIR, { recursive: true });

    for (const skill of BUILTIN_SKILLS) {
      const target = path.join(SKILLS_DIR, `${skill.name}.md`);
      if (fs.existsSync(target)) continue;

      fs.writeFileSync(
        target,
        `---\ndescription: ${skill.description}\n---\n\n${skill.prompt}`,
        "utf-8"
      );
    }
  } catch (err: any) {
    console.warn(`⚠️  Could not seed skills into ${SKILLS_DIR}: ${err.message}`);
  }
}

/**
 * Skills authored as vault notes.
 *
 * Same format as the ones in ~/.cullus/skills — frontmatter `description:`
 * then the prompt — so parseSkillFile is reused verbatim. The point of putting
 * them in the vault is that they become editable, searchable and linkable next to
 * everything else you write, instead of living in a hidden folder.
 */
function vaultSkills(): Skill[] {
  const folder = vaultPathFor("skills");
  if (!folder) return [];

  const found: Skill[] = [];

  for (const entry of listVaultNotes(folder)) {
    const relative = `${folder}/${entry}`;
    const resolved = resolveInVault(relative);
    if (!resolved.ok) continue;

    const parsed = parseSkillFile(resolved.absolute, entry.replace(/\.md$/, ""));
    if (parsed) found.push({ ...parsed, source: "vault", vaultPath: relative });
  }

  return found;
}

export function listSkills(): Skill[] {
  const skills: Skill[] = [];

  // Vault first: a skill you wrote as a note WINS over the shipped version of the
  // same name, so overriding `verify` is a matter of writing verify.md.
  for (const skill of vaultSkills()) skills.push(skill);

  try {
    if (fs.existsSync(SKILLS_DIR)) {
      for (const entry of fs.readdirSync(SKILLS_DIR)) {
        if (!entry.endsWith(".md")) continue;
        const name = entry.replace(/\.md$/, "");
        if (skills.some((s) => s.name === name)) continue;

        const parsed = parseSkillFile(path.join(SKILLS_DIR, entry), name);
        if (parsed) skills.push({ ...parsed, source: "file" });
      }
    }
  } catch {
    /* fall through to built-ins */
  }

  // Any built-in missing from disk still works, just isn't editable yet.
  for (const builtin of BUILTIN_SKILLS) {
    if (skills.some((s) => s.name === builtin.name)) continue;
    skills.push({ ...builtin, builtin: true, source: "builtin" });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(name: string): Skill | null {
  return listSkills().find((s) => s.name === name) ?? null;
}

export interface WriteSkillResult {
  ok: boolean;
  /** Where it landed: vault-relative path, or an absolute path under SKILLS_DIR. */
  path?: string;
  /** "vault" or "file", so the caller can say where to edit it. */
  where?: "vault" | "file";
  error?: string;
  actionRequired?: string;
}

/** Skill names double as slash commands, so they follow the same shape. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;

/**
 * Persist a skill so it is runnable from the next message onward.
 *
 * Destination follows listSkills()' own precedence: the vault skills folder when
 * one is configured, because a skill you can read, link and edit next to your
 * notes is one you will actually maintain; ~/.cullus/skills otherwise.
 *
 * Overwriting is opt-in. A skill is a standing instruction to the model, so
 * silently replacing one is a bigger deal than replacing a note.
 */
export function writeSkill(
  name: string,
  description: string,
  prompt: string,
  options: { overwrite?: boolean } = {}
): WriteSkillResult {
  const slug = String(name ?? "").trim().toLowerCase().replace(/\s+/g, "-");

  if (!SKILL_NAME.test(slug)) {
    return {
      ok: false,
      error: `"${name}" is not a usable skill name.`,
      actionRequired: "Use 2-41 characters: lowercase letters, digits and dashes.",
    };
  }
  if (!description.trim() || !prompt.trim()) {
    return {
      ok: false,
      error: "A skill needs both a description and a prompt body.",
      actionRequired: "Call again with a one-line description and the numbered steps.",
    };
  }

  const existing = listSkills().find((s) => s.name === slug);
  if (existing && !options.overwrite) {
    return {
      ok: false,
      error: `A skill called "${slug}" already exists.`,
      actionRequired:
        `Read it with the list_skills tool and either pick a different name, or call ` +
        `again with {"overwrite": true} if replacing it is genuinely the intent.`,
    };
  }

  // One-line description on one line: the frontmatter parser reads it with a
  // line-anchored regex, so an embedded newline would silently truncate it.
  const body =
    `---\ndescription: ${description.trim().replace(/\s*\n\s*/g, " ")}\n---\n\n${prompt.trim()}\n`;

  const folder = vaultPathFor("skills");
  if (folder) {
    const relative = `${folder}/${slug}.md`;
    const result = writeVaultNote(relative, body);
    if (!result.ok) {
      return { ok: false, error: result.error, actionRequired: result.actionRequired };
    }
    return { ok: true, path: result.path, where: "vault" };
  }

  try {
    ensureConfigDir();
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const target = path.join(SKILLS_DIR, `${slug}.md`);
    fs.writeFileSync(target, body, "utf-8");
    return { ok: true, path: target, where: "file" };
  } catch (err: any) {
    return {
      ok: false,
      error: `Could not write the skill: ${err.message}`,
      actionRequired: `Check that ${SKILLS_DIR} is writable.`,
    };
  }
}

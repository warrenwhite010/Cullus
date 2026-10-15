// Check a skill's output in code, not by asking the model to check itself.
//
// The /unity skill used to end with a self-audit:
//
//   CHECK BEFORE YOU SEND. Fix any that fail:
//   • Every WHAT I WILL BUILD line opens with a glossary term.
//   • Nothing in WHAT I WILL NOT TOUCH is modified by any step.
//
// That asks the model that made the mistake to notice the mistake, in the same
// context, with the same blind spot. Measured on both models available here:
// gemma4:latest opened all five build lines with the identical term
// "Script on the Disc" — technically compliant, teaching value zero — and, one
// section after being told to check for exactly this, promised not to touch the
// Rigidbody and then applied force through it in step 3 and disabled its force
// application in step 5. ornith-1.5:35b passed the cross-reference check but
// still mislabelled two lines.
//
// Self-auditing also costs prompt budget. Those three lines competed with the
// glossary and the output template for a 9.6 GB model's attention, and they are
// the part that lost.
//
// So the checks move here. Three things change by doing that:
//
//   1. They are deterministic. The 35B's better score was a better roll, not a
//      guarantee; a set intersection either finds a member or it does not.
//   2. They cost nothing in the prompt, so deleting the self-audit section buys
//      the glossary ~50 words back.
//   3. They can express what prose cannot. "Nothing in WHAT I WILL NOT TOUCH is
//      modified by any step" is a cross-reference between two sections of the
//      output — one line of code, and a request to hold two lists in mind
//      simultaneously otherwise, which is the thing small models are worst at.
//
// WHAT THIS DELIBERATELY DOES NOT DO: judge meaning. The 35B called a counter a
// "Component" and a reset method a "Script". Both open with a legal glossary
// term, so both pass every check here, and no amount of string matching fixes
// that. Structure and cross-references are mechanical; semantics are not. A
// validator that pretended otherwise would fail the outputs it cannot read.

export interface Finding {
  /** Which check failed, for logs. */
  check: string;
  /** What is wrong, addressed to the model, naming the offending text. */
  detail: string;
}

export type SkillValidator = (output: string) => Finding[];

/**
 * Terms allowed to open a WHAT I WILL BUILD line.
 *
 * Must stay in step with the glossary in ~/.cullus/skills/unity.md. Duplicated
 * rather than parsed out of the skill file: the skill is user-editable, and a
 * validator that silently weakens when someone reformats a bullet is worse than
 * one that is visibly out of date.
 */
const UNITY_GLOSSARY = [
  "GameObject",
  "Component",
  "Transform",
  "Mesh",
  "MeshRenderer",
  "MeshFilter",
  "Collider",
  "CapsuleCollider",
  "MeshCollider",
  "BoxCollider",
  "Rigidbody",
  "Material",
  "Prefab",
  "Script",
  "Serialized field",
  "Tag",
  "Layer",
  "Scene",
];

const PLAN_HEADINGS = [
  "WHAT YOU ASKED FOR",
  "WHAT I WILL BUILD",
  "WHAT YOU WILL SEE WHEN IT IS DONE",
  "WHAT I WILL NOT TOUCH",
  "WHAT COULD LOOK WRONG",
];

const PROMPT_HEADINGS = ["Role:", "Task:", "Inputs:", "Steps:", "Rules:", "Done when:", "If stuck:"];

/**
 * Verbs that make a mention of something a MODIFICATION of it.
 *
 * The naive version of the cross-reference check — "is anything from WHAT I
 * WILL NOT TOUCH named in Steps?" — fires on the 35B's output, which promises
 * not to modify `GameArena_Walls` and then has a step reading "Verify in the
 * DiscBattle scene that GameArena_Walls carries the Wall tag". That step is a
 * read, the promise is about writes, and flagging it would train the user to
 * ignore the validator.
 *
 * So the check is scoped to steps that actually do something. This is the list
 * that separates gemma4's real contradiction ("apply an initial force using the
 * Rigidbody", against a promise not to touch the Rigidbody) from the 35B's
 * legitimate read.
 */
const MUTATING_VERBS = [
  "add", "adds", "adding",
  "set", "sets", "setting",
  "edit", "edits", "editing",
  "apply", "applies", "applying",
  "disable", "disables", "disabling",
  "enable", "enables", "enabling",
  "remove", "removes", "removing",
  "delete", "deletes", "deleting",
  "change", "changes", "changing",
  "modify", "modifies", "modifying",
  "write", "writes", "writing",
  "attach", "attaches", "attaching",
  "replace", "replaces", "replacing",
  "zero", "zeroes", "zeroing",
  "force", "forces", "forcing",
  "override", "overrides", "overriding",
  "assign", "assigns", "assigning",
  "create", "creates", "creating",
];

/** Text between `heading` and the next heading in `order`, or "". */
function sectionAfter(output: string, heading: string, order: string[]): string {
  const start = output.indexOf(heading);
  if (start === -1) return "";

  const from = start + heading.length;
  const later = order.slice(order.indexOf(heading) + 1);

  let end = output.length;
  for (const next of later) {
    const at = output.indexOf(next, from);
    if (at !== -1 && at < end) end = at;
  }

  return output.slice(from, end);
}

/** Numbered list items in a section, stripped of markers and emphasis. */
function numberedItems(section: string): string[] {
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+[.)]\s/.test(line))
    .map((line) => line.replace(/^\d+[.)]\s*/, "").replace(/^[*_`]+/, "").trim());
}

/** The glossary term an item opens with, or null. Longest match wins. */
function openingTerm(item: string): string | null {
  const lower = item.toLowerCase();
  const matches = UNITY_GLOSSARY.filter((term) => lower.startsWith(term.toLowerCase()));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.length - a.length)[0];
}

/**
 * Identifiers a WHAT I WILL NOT TOUCH line is about.
 *
 * Backticked or quoted names first, because those are unambiguous. Falling back
 * to bare capitalised words as well, since gemma4 wrote "The `Rigidbody`
 * component on the `disc` GameObject" in backticks but a model could as easily
 * write it plain — and the contradiction is the same either way.
 */
function protectedNames(section: string): string[] {
  const names = new Set<string>();

  // Two constructions carve names OUT of the promise, and both have produced a
  // false positive on real output:
  //
  //   "the arena geometry — not modified (only read to verify the `Wall` tag)"
  //   "The overall structure of `DiscLauncher.cs` (only modifying `DiscHit.cs`)"
  //
  // The first explains why a name appears at all; the second names an explicit
  // exception. In both cases the protected thing is what comes BEFORE, and the
  // parenthetical is the model being careful — which is exactly the behaviour a
  // false positive punishes. The second one cost a repair round on a plan that
  // was right.
  //
  // Everything before the carve-out still counts, so the promise itself is
  // still checked.
  const CARVE_OUT =
    /\b(?:only read|read only|read-only|only to verify|only modifying|other than|except|excluding|aside from|apart from)\b/i;

  const scoped = section
    .split("\n")
    .map((line) => line.split(CARVE_OUT)[0])
    .join("\n");

  for (const match of scoped.matchAll(/[`'"]([A-Za-z_][\w.]{2,})[`'"]/g)) {
    names.add(match[1]);
  }

  // Bare mentions of the handful of Unity nouns that are commonly promised and
  // then modified. Kept to a known list rather than every capitalised word: a
  // line like "Any scene other than Assets/Scenes/DiscBattle.unity" would
  // otherwise protect the word "Any".
  for (const noun of ["Rigidbody", "Collider", "MeshRenderer", "Transform", "Prefab", "Material"]) {
    if (new RegExp(`\\b${noun}\\b`).test(scoped)) names.add(noun);
  }

  return [...names];
}

/**
 * Does `line` modify `name`, rather than merely mention it?
 *
 * Two rules, both learned from a false positive on real output. The 35B wrote
 * `In the existing OnCollisionEnter, when the collision tag is "Wall" and
 * returning is false, increment bounceCounter; once bounceCounter >=
 * wallBouncesBeforeReturn set returning = true.` — which contains a mutating
 * verb ("set") and the protected name ("Wall"), and modifies neither together:
 * it sets `returning`, and it compares against the string "Wall".
 *
 *   1. The name must come AFTER a mutating verb and close to it, so the verb
 *      plausibly governs it. "Apply an initial force (Rigidbody.AddForce)" has
 *      23 characters between the two; "…is \"Wall\"… set returning" has the verb
 *      after the name entirely.
 *   2. A name appearing only as a quoted string literal is data, not a target.
 *      `CompareTag("Wall")` reads a tag; it does not change one.
 */
const VERB_TO_NAME_WINDOW = 40;

function modifies(line: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Rule 2: strip quoted literals, then require the name to survive.
  const unquoted = line.replace(/(['"`])[^'"`]*\1/g, " ");
  if (!new RegExp(`\\b${escaped}\\b`).test(unquoted)) return false;

  // Rule 1: a mutating verb within the window before the name.
  for (const match of unquoted.matchAll(new RegExp(`\\b${escaped}\\b`, "g"))) {
    const at = match.index ?? 0;
    const before = unquoted.slice(Math.max(0, at - VERB_TO_NAME_WINDOW), at).toLowerCase();
    if (MUTATING_VERBS.some((verb) => new RegExp(`\\b${verb}\\b`).test(before))) return true;
  }

  return false;
}

function validateUnity(output: string): Finding[] {
  const findings: Finding[] = [];

  for (const heading of PLAN_HEADINGS) {
    if (!output.includes(heading)) {
      findings.push({
        check: "plan-heading",
        detail: `The plan is missing the heading ${heading}. Add that section, spelled exactly like that.`,
      });
    }
  }

  // --- WHAT I WILL BUILD: every line opens with a glossary term ---
  const buildSection = sectionAfter(output, "WHAT I WILL BUILD", PLAN_HEADINGS);
  const items = numberedItems(buildSection);

  if (buildSection && items.length === 0) {
    findings.push({
      check: "build-list-empty",
      detail:
        "WHAT I WILL BUILD has no numbered list. Write one numbered line per thing you will " +
        "build, each opening with a glossary term.",
    });
  }

  const untermed = items.filter((item) => openingTerm(item) === null);
  if (untermed.length > 0) {
    findings.push({
      check: "build-line-term",
      detail:
        `${untermed.length} WHAT I WILL BUILD line(s) do not open with a glossary term: ` +
        untermed.map((i) => `"${i.slice(0, 60)}"`).join(", ") +
        `. A method, a function, a variable and a listener are not glossary terms — they are ` +
        `parts of a script, so open the line with Script and name the script.`,
    });
  }

  // --- and no single term carries the whole list ---
  //
  // The check above is gameable and was gamed: gemma4 opened all five lines
  // with "Script on the Disc", passing the letter of the rule while teaching
  // nothing. This is the half of the pair that is hard to state usefully in
  // prose and trivial here.
  const termed = items.map(openingTerm).filter((t): t is string => t !== null);
  if (termed.length >= 3) {
    const counts = new Map<string, number>();
    for (const term of termed) counts.set(term, (counts.get(term) ?? 0) + 1);

    const [dominant, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (count > Math.ceil(termed.length / 2)) {
      // Quote what the model actually wrote, not just the term it resolved to.
      // "3 of 3 lines open with Script" sends it looking for the word Script;
      // "…all open with 'Script on the Disc —'" points at the text to change.
      const repeated = items
        .filter((item) => openingTerm(item) === dominant)
        .map((item) => `"${item.slice(0, 40)}…"`)
        .slice(0, 3)
        .join(", ");

      findings.push({
        check: "build-term-variety",
        detail:
          `${count} of ${termed.length} WHAT I WILL BUILD lines open with the same term ` +
          `"${dominant}" — ${repeated}. Prefixing every line with one term satisfies the rule ` +
          `without teaching anything. Name the actual distinct Unity things involved — the ` +
          `component, each serialized field, the collider, the tag — one per line.`,
      });
    }
  }

  // --- WHAT I WILL NOT TOUCH must not be contradicted by the steps ---
  const notTouch = sectionAfter(output, "WHAT I WILL NOT TOUCH", PLAN_HEADINGS);
  const promptBlock =
    (output.match(/```[a-z]*\n([\s\S]*?)```/g) ?? [])
      .map((block) => block.replace(/```[a-z]*\n?/g, "").replace(/```$/, ""))
      .find((block) => /Role:/.test(block)) ?? "";

  const stepsSection = sectionAfter(promptBlock, "Steps:", PROMPT_HEADINGS);
  const stepLines = stepsSection
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const name of protectedNames(notTouch)) {
    const offending = stepLines.filter((line) => modifies(line, name));

    if (offending.length > 0) {
      findings.push({
        check: "not-touch-contradiction",
        detail:
          `WHAT I WILL NOT TOUCH says you will not modify ${name}, but a step modifies it: ` +
          offending.map((l) => `"${l.slice(0, 90)}"`).join(" ") +
          `. Either remove ${name} from WHAT I WILL NOT TOUCH, or change the step. Adding ` +
          `force to a Rigidbody, or changing a field a script reads, counts as touching it.`,
      });
    }
  }

  // --- the build prompt itself ---
  if (!promptBlock) {
    findings.push({
      check: "prompt-missing",
      detail:
        "There is no fenced build prompt containing a Role: line. Emit the prompt as one " +
        "fenced code block using the template from the skill.",
    });
    return findings;
  }

  for (const heading of PROMPT_HEADINGS) {
    if (!promptBlock.includes(heading)) {
      findings.push({
        check: "prompt-heading",
        detail: `The build prompt is missing the ${heading} section. Keep all seven headings.`,
      });
    }
  }

  const rulesSection = sectionAfter(promptBlock, "Rules:", PROMPT_HEADINGS);
  if (promptBlock.includes("Rules:") && rulesSection.trim().length < 20) {
    findings.push({
      check: "rules-empty",
      detail: "The Rules section is empty. Copy the five standing rules from the skill template into it.",
    });
  }

  // The specific regression: rule text pasted into Steps. gemma4 produced a
  // step reading "...and list those command names in Step 1 so they are fetched
  // together" while BEING step 1 and listing none.
  const leaked = stepLines.filter((line) =>
    /in Step 1|before calling it the first time|before the first call to that command|names are prefixed/i.test(line)
  );
  if (leaked.length > 0) {
    findings.push({
      check: "rule-in-steps",
      detail:
        `A standing rule was written as a step: ${leaked.map((l) => `"${l.slice(0, 80)}"`).join(" ")}. ` +
        `Steps are actions to perform in order; limits belong under Rules. Move it.`,
    });
  }

  // Must stay in step with the skill's closing line. It names /build rather
  // than "paste this into a new chat" because the new chat is the part that
  // matters and asking the user to remember it failed: pasting the prompt into
  // the planning conversation leaves the model holding "build nothing" and
  // "implement this" at once.
  if (!/Run \/build/i.test(output)) {
    findings.push({
      check: "closing-line",
      detail:
        'The closing line is missing. End with exactly: "Run /build to execute this in a ' +
        'clean chat, then check <the first thing to look at>."',
    });
  }

  return findings;
}

/**
 * The sections of a /pipeline plan that are worth having.
 *
 * A planning skill degrades in one predictable direction: towards generic
 * advice. Every section below is one this project learned the hard way and
 * would lose first — the facts that decided the plan, the traps with real
 * numbers in them, and the calls that would actually prove the work. A plan
 * without them reads fine and is worth nothing, which is exactly the failure
 * mode a validator can catch and a reader cannot.
 */
const PIPELINE_HEADINGS = [
  "WHAT YOU ASKED FOR",
  "THE FACTS THAT DECIDE THIS",
  "WHAT I WILL BUILD",
  "WHAT I WILL NOT TOUCH",
  "HOW IT CAN GO WRONG HERE",
  "HOW WE WILL KNOW IT WORKED",
];

/** The three verification tools a plan can draw on. At least one must appear. */
const PIPELINE_PROBES = ["unity_walk_probe", "unity_scene_overlaps", "unity_scene_audit"];

function validatePipeline(output: string): Finding[] {
  const findings: Finding[] = [];
  const lines = output.split("\n");

  // 1. The job has to be named, because the rest of the plan depends on which
  // of the three it is.
  if (!/^\s*(?:•\s*)?(?:\*\*)?(UNITY|BLENDER|BRIDGE)\b/m.test(output)) {
    findings.push({
      check: "pipeline-job-named",
      detail:
        'Stage 1 is missing: name the job as exactly one of UNITY, BLENDER or BRIDGE, on its ' +
        'own line, and say why in one sentence.',
    });
  }

  // 2. Headings, in order. Order matters: the traps have to be stated before
  // the verification that checks for them, or the plan reads as a rationalisation.
  let searchFrom = 0;
  for (const heading of PIPELINE_HEADINGS) {
    const at = output.indexOf(heading, searchFrom);
    if (at < 0) {
      findings.push({
        check: "pipeline-heading",
        detail: `The heading "${heading}" is missing, or appears out of order. Use all six, spelled exactly, in the order given in the skill.`,
      });
      continue;
    }
    searchFrom = at + heading.length;
  }

  // 3. "THE FACTS THAT DECIDE THIS" must contain facts, and a fact about this
  // project has a number or a name in it. Three bullets of "consider the
  // render pipeline" is the failure being caught.
  const facts = sectionOf(output, "THE FACTS THAT DECIDE THIS", PIPELINE_HEADINGS);
  const factBullets = facts.filter((line) => /^\s*[-•*\d]/.test(line));

  if (factBullets.length < 3) {
    findings.push({
      check: "pipeline-facts-count",
      detail: `THE FACTS THAT DECIDE THIS has ${factBullets.length} bullet(s); it needs at least three, each one something you established by reading the project or asked me.`,
    });
  }

  const concreteFacts = factBullets.filter((line) => /\d|\.cs\b|\.fbx\b|\.unity\b|URP|[A-Z][a-z]+[A-Z]/.test(line));
  if (factBullets.length >= 3 && concreteFacts.length < 2) {
    findings.push({
      check: "pipeline-facts-concrete",
      detail:
        "THE FACTS THAT DECIDE THIS reads as general advice. At least two bullets must carry " +
        "something specific from THIS project — a number, a file name, a component name, a " +
        "pipeline. A fact I could have guessed without you is not a fact that decided anything.",
    });
  }

  // 4. Traps must be specific too, for the same reason.
  const traps = sectionOf(output, "HOW IT CAN GO WRONG HERE", PIPELINE_HEADINGS);
  const trapBullets = traps.filter((line) => /^\s*[-•*\d]/.test(line));

  if (trapBullets.length < 3) {
    findings.push({
      check: "pipeline-traps-count",
      detail: `HOW IT CAN GO WRONG HERE lists ${trapBullets.length} trap(s); list at least three that apply to this job specifically.`,
    });
  }

  // 5. A verification section without a callable check is a wish.
  const verify = sectionOf(output, "HOW WE WILL KNOW IT WORKED", PIPELINE_HEADINGS).join("\n");
  if (verify.length > 0 && !PIPELINE_PROBES.some((probe) => verify.includes(probe))) {
    findings.push({
      check: "pipeline-verification-callable",
      detail:
        "HOW WE WILL KNOW IT WORKED names no probe. Name at least one of unity_walk_probe, " +
        "unity_scene_overlaps or unity_scene_audit — with its arguments — or, for behaviour " +
        "over time, the scene-side probe entry points you would call.",
    });
  }

  // 6. A walk probe quoted without waypoints is the mistake the skill warns
  // about: a straight-line failure that says nothing about whether a route
  // exists.
  if (verify.includes("unity_walk_probe") && !/\bvia\b/.test(verify)) {
    findings.push({
      check: "pipeline-walk-waypoints",
      detail:
        "The walk probe is named without `via` waypoints. Unless the route really is a straight " +
        "line, give the waypoints — a blocked result without them only means 'not in a straight " +
        "line', which is not the question.",
    });
  }

  // 7. The build prompt has to be pasteable, which means fenced.
  if (!/```/.test(output)) {
    findings.push({
      check: "pipeline-build-prompt",
      detail:
        "Stage 7 is missing or unfenced: the build prompt must be in a fenced code block so it " +
        "can be pasted, and must end with a DONE MEANS section.",
    });
  } else if (!/DONE MEANS/.test(output)) {
    findings.push({
      check: "pipeline-done-means",
      detail:
        "The build prompt has no DONE MEANS section. Add one, and make every criterion in it " +
        "checkable by the calls you named under HOW WE WILL KNOW IT WORKED.",
    });
  }

  return findings;
}

/**
 * Lines between `heading` and whichever of `all` comes next — or the build
 * prompt, whichever is sooner.
 *
 * The fence matters. HOW WE WILL KNOW IT WORKED is the last heading, so without
 * it the section ran to the end of the output and swallowed Stage 7 — and a
 * DONE MEANS line that merely *mentions* a probe then satisfied the check that
 * the verification section must name one. The plan could promise nothing and
 * pass on the strength of its own build prompt.
 */
function sectionOf(output: string, heading: string, all: string[]): string[] {
  const start = output.indexOf(heading);
  if (start < 0) return [];

  const after = start + heading.length;
  let end = output.length;

  for (const other of all) {
    if (other === heading) continue;
    const at = output.indexOf(other, after);
    if (at >= 0 && at < end) end = at;
  }

  const fence = output.indexOf("```", after);
  if (fence >= 0 && fence < end) end = fence;

  return output.slice(after, end).split("\n");
}

const VALIDATORS: Record<string, SkillValidator> = {
  unity: validateUnity,
  pipeline: validatePipeline,
};

export function hasValidator(skill: string | null | undefined): boolean {
  return Boolean(skill && skill in VALIDATORS);
}

/** Findings for a skill's output. Empty when it passes, or has no validator. */
export function validateSkillOutput(skill: string | null | undefined, output: string): Finding[] {
  if (!skill) return [];
  const validator = VALIDATORS[skill];
  if (!validator) return [];

  try {
    return validator(output);
  } catch {
    // A validator that throws must not take the turn's answer with it. The
    // output is still what the model produced; failing open costs a missed
    // check, failing closed costs the user their answer.
    return [];
  }
}

/**
 * The message that asks for a repair.
 *
 * Names the failing lines and says what is wrong with each, which is a
 * different task from the self-audit this replaces: the model is no longer
 * asked to FIND the error, only to fix a named one. Both models handle that
 * markedly better.
 */
export function repairPrompt(findings: Finding[]): string {
  const list = findings.map((f, i) => `${i + 1}. ${f.detail}`).join("\n");

  return (
    `Your answer failed ${findings.length} automatic check${findings.length > 1 ? "s" : ""}. ` +
    `Fix exactly these and re-send the whole plan and build prompt:\n\n${list}\n\n` +
    `Change nothing else. Do not call any tool — everything you need is in what you already ` +
    `wrote. Re-send the complete output, not a description of the edits.`
  );
}

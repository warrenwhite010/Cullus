// The repair loop, end to end, without a socket or a model.
//
// verify-skill-validator.mjs proves the checks fire on the right text. This
// proves the thing built around them behaves: that a failing output triggers a
// repair, that a fixed output ends the loop, that the attempt cap holds, and
// that the two guards which could silently break it stay intact.
//
// The loop itself lives inside a socket handler in server.ts, so it is not
// importable. What IS importable is every decision it makes, so this drives the
// same sequence against a scripted model and asserts on the transcript.
//
// The two guards worth naming, because both were real bugs on the way here:
//
//   1. VALIDATE ONLY WHEN THE TURN WOULD OTHERWISE END. A model mid-task has
//      not written its final answer, so validating a partial one rejects it for
//      sections it was about to write. The loop checks `!next` first.
//   2. A REPAIR ROUND MUST NOT COUNT AS BARREN. isBarrenRound() returns true
//      whenever a round made no NEW tool calls, and a repair round makes none
//      at all by design — the repair prompt forbids tools. Unguarded, two
//      repairs in a row trip the no-progress stop and print "the last two
//      repeated tool calls already made earlier", which is wrong and unhelpful.
//
// Usage: node scripts/verify-validator-loop.mjs
// Requires: npm run build

const { validateSkillOutput, hasValidator, repairPrompt } = await import("../dist/core/skillValidators.js");
const { isBarrenRound, BARREN_ROUNDS_BEFORE_STOP } = await import("../dist/core/session.js");

let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  🟢 ${label}`);
    return;
  }
  console.log(`  🔴 ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
}

const PASSING = `
WHAT YOU ASKED FOR
A disc that returns.

WHAT I WILL BUILD
1. Script — DiscThrow — the component on the disc — extended to add a return state — without it it never returns.
2. Serialized field — DiscThrow.returnSpeed — a value you can change in the Inspector — how fast it comes home — without it there is no speed.
3. Tag — Wall on the arena walls — a label the script checks — without it the bounce never fires.

WHAT YOU WILL SEE WHEN IT IS DONE
Press left mouse in Assets/Scenes/DiscBattle.unity and it flies, bounces, returns.

WHAT I WILL NOT TOUCH
The \`PlayerCharacter\` GameObject.

WHAT COULD LOOK WRONG
The collider is a capsule, so it hops rather than glides.

\`\`\`
Role: A Unity dev
Task: Extend DiscThrow.cs so the disc returns
Inputs:
  /Users/warrenwhite/TronGame/Assets/Scripts/DiscThrow.cs
Steps:
  1. Read DiscThrow.cs in full.
  2. Add a [SerializeField] float returnSpeed = 25f.
Rules:
  Call editor_stop before any scene or GameObject edit.
  Mark any field I need to tune with [SerializeField] so it appears in the Inspector.
Done when:
  It throws, bounces and returns with no compiler errors.
If stuck:
  Set the Rigidbody's velocity once; never teleport its transform.
\`\`\`
Run /build to execute this in a clean chat, then check the disc returns.
`;

// The real gemma4 failure: one term carrying the whole list.
const FAILING = PASSING.replace(
  /WHAT I WILL BUILD\n[\s\S]*?\n\nWHAT YOU WILL SEE/,
  `WHAT I WILL BUILD
1. Script on the Disc — tracking launch state — without it nothing happens.
2. Script on the Disc — the launch force — without it it does not move.
3. Script on the Disc — a return mechanism — without it it never comes home.

WHAT YOU WILL SEE`
);

/**
 * The decision sequence from server.ts, driven by a scripted model.
 *
 * `outputs` is what the model says on each successive round. Returns the
 * transcript of what the loop did, which is what the assertions read.
 */
function runLoop(outputs, { skill = "unity", maxRepairs = 2, continuations = [] } = {}) {
  const transcript = [];
  let repairRounds = 0;
  let roundIsRepair = false;
  let barrenRounds = 0;
  let stoppedBarren = false;

  for (let round = 1; round <= 12; round++) {
    const thisRoundWasRepair = roundIsRepair;
    roundIsRepair = false;

    const content = outputs[Math.min(round - 1, outputs.length - 1)];
    // A repair round makes no tool calls, by design.
    const novelCalls = thisRoundWasRepair ? 0 : 3;

    transcript.push({ round, repair: thisRoundWasRepair, content: content.slice(0, 24) });

    // Auto-continue takes precedence: the model is still working.
    let next = continuations[round - 1] ? { summary: "more work", prompt: "carry on" } : null;

    // Guard 1: only validate a turn that would otherwise end.
    let unresolved = [];
    if (!next && hasValidator(skill)) {
      const findings = validateSkillOutput(skill, content);
      if (findings.length > 0 && repairRounds < maxRepairs) {
        repairRounds++;
        roundIsRepair = true;
        next = { summary: `fixing ${findings.length} check(s)`, prompt: repairPrompt(findings) };
        transcript.push({ round, dispatchedRepair: findings.map((f) => f.check) });
      } else if (findings.length > 0) {
        unresolved = findings;
        transcript.push({ round, unresolved: findings.map((f) => f.check) });
      }
    }

    if (!next) {
      transcript.push({ round, ended: true, unresolved: unresolved.length });
      break;
    }

    // Guard 2: a repair round is exempt from the barren-round stop.
    barrenRounds = thisRoundWasRepair ? barrenRounds : isBarrenRound(3, novelCalls) ? barrenRounds + 1 : 0;

    if (barrenRounds >= BARREN_ROUNDS_BEFORE_STOP) {
      stoppedBarren = true;
      transcript.push({ round, stoppedBarren: true });
      break;
    }
  }

  return { transcript, repairRounds, stoppedBarren };
}

console.log("\nA passing output ends the turn immediately:");
{
  const { transcript, repairRounds } = runLoop([PASSING]);
  check("no repair was dispatched", repairRounds === 0);
  check("the loop ended on round 1", transcript.some((t) => t.ended && t.round === 1));
  check("nothing was left unresolved", transcript.find((t) => t.ended)?.unresolved === 0);
}

console.log("\nA failing output is repaired, and the fix ends the loop:");
{
  const { transcript, repairRounds } = runLoop([FAILING, PASSING]);
  check("one repair was dispatched", repairRounds === 1);
  check(
    "the repair named the real check",
    transcript.some((t) => t.dispatchedRepair?.includes("build-term-variety")),
    JSON.stringify(transcript.find((t) => t.dispatchedRepair))
  );
  check("round 2 ran as a repair round", transcript.some((t) => t.round === 2 && t.repair === true));
  check("the loop ended on round 2", transcript.some((t) => t.ended && t.round === 2));
  check("nothing was left unresolved", transcript.find((t) => t.ended)?.unresolved === 0);
}

console.log("\nA model that never fixes it stops at the cap, with the findings surfaced:");
{
  const { transcript, repairRounds, stoppedBarren } = runLoop([FAILING]);
  check(`exactly ${2} repairs were attempted`, repairRounds === 2, `got ${repairRounds}`);
  check("the loop ended rather than looping forever", transcript.some((t) => t.ended));
  check(
    "the remaining findings were surfaced, not swallowed",
    transcript.some((t) => t.unresolved?.includes?.("build-term-variety")),
    JSON.stringify(transcript.filter((t) => t.unresolved))
  );
  // Guard 2. Two consecutive repair rounds make zero new tool calls each.
  check("the barren-round stop did not misfire on the repair rounds", stoppedBarren === false);
}

console.log("\nGuard 1 — a mid-task turn is not validated:");
{
  // Round 1 asks to continue, so its (incomplete) output must not be judged.
  const { transcript, repairRounds } = runLoop(["Reading the project now...", PASSING], {
    continuations: [true],
  });
  check("no repair on the round that asked to continue", repairRounds === 0, JSON.stringify(transcript));
  check("the completed output ended the loop", transcript.some((t) => t.ended && t.round === 2));
}

console.log("\nA skill with no validator is untouched:");
{
  const { transcript, repairRounds } = runLoop(["anything at all"], { skill: "prompt" });
  check("no validation ran", repairRounds === 0);
  check("the loop ended on round 1", transcript.some((t) => t.ended && t.round === 1));
}

console.log("\nA message typed during a repair round is held, not folded in:");
{
  // The failure this guards against, measured: the /unity closing line told the
  // user to paste the build prompt into a new chat, they pasted it into this one
  // while a repair round was in flight, and drainUserMessages folded it into a
  // round whose own prompt says "Change nothing else. Do not call any tool."
  // From that message on the model held two incompatible tasks — "build nothing,
  // edit no files" and "implement a robust disc-throwing system" — and resolved
  // it by doing the only thing both allowed, reading files, for six rounds and
  // 780,000 tokens.
  const queue = ["Role: Gameplay Engineer\nTask: Implement the disc system"];
  const drained = [];

  // The callback as server.ts now builds it.
  const drainUserMessages = (thisRoundWasRepair) => {
    if (!thisRoundWasRepair) {
      const taken = queue.splice(0, queue.length);
      drained.push(...taken);
      return taken;
    }
    return [];
  };

  const duringRepair = drainUserMessages(true);
  check("the repair round receives nothing", duringRepair.length === 0);
  check("the message stays queued rather than being dropped", queue.length === 1);

  const afterRepair = drainUserMessages(false);
  check("the next round picks it up", afterRepair.length === 1, JSON.stringify(afterRepair));
  check("the queue is then empty", queue.length === 0);
}

console.log("\nThe repair prompt itself:");
{
  const findings = validateSkillOutput("unity", FAILING);
  const prompt = repairPrompt(findings);
  check("it names the failure count", /failed 1 automatic check/.test(prompt), prompt.slice(0, 80));
  check("it quotes the offending term", /Script on the Disc/.test(prompt));
  check("it forbids tool calls", /Do not call any tool/.test(prompt));
  check("it asks for the whole output back", /Re-send the complete output/.test(prompt));
}

// -------------------------------------------------------------------------
// The wiring in server.ts
// -------------------------------------------------------------------------
//
// The loop above is a faithful copy of the decision sequence, which proves the
// decisions are right but not that the real handler makes them in that order.
// There is no Node socket.io client bundled here and adding a dependency for
// one test is a bad trade, so the compiled handler is checked by structure: the
// order of these calls is the whole contract, and getting it wrong is silent.
console.log("\nThe compiled server wires it in the right order:");
{
  const fs = await import("fs");
  const js = fs.readFileSync("./dist/core/server.js", "utf-8");

  const at = (needle) => js.indexOf(needle);

  const destructured = /send-message["'],\s*async\s*\(\{[^}]*\bskill\b/.test(js);
  check("the send-message handler destructures `skill` from the payload", destructured);

  const decide = at("decideContinuation(result");
  const validate = at("validateSkillOutput(skillName");
  const emitResponse = js.indexOf('"ai-response"', validate);
  const assign = js.indexOf("message = next.prompt", validate);

  check("validateSkillOutput is present in the handler", validate > 0);
  check("it runs AFTER decideContinuation", decide > 0 && validate > decide, `decide@${decide} validate@${validate}`);
  check("the answer is emitted after validation decides", emitResponse > validate);
  check("a repair prompt becomes the next round's message", assign > validate);

  // Guard 2 must survive a refactor: if this assignment ever loses the
  // thisRoundWasRepair term, two repairs in a row start tripping the
  // no-progress stop and the message the user sees is wrong.
  check(
    "the barren-round counter still exempts repair rounds",
    /thisRoundWasRepair\s*\?\s*barrenRounds\s*:/.test(js)
  );

  check("unresolved findings are emitted rather than dropped", at("still fails") > 0);
  check("the repair attempt cap is present", /MAX_REPAIR_ROUNDS\s*=\s*2|repairRounds\s*<\s*2/.test(js));

  // The injection hold. Without the guard, a paste during a repair round is
  // folded into a prompt that forbids doing anything with it.
  check(
    "drainUserMessages returns nothing during a repair round",
    /if\s*\(!thisRoundWasRepair\)\s*return drainInjections\(turn\)/.test(js)
  );
  check("the held message is left in the queue for the next round", !/thisRoundWasRepair[\s\S]{0,200}queue\.splice/.test(js));
}

console.log("\n/build starts a clean chat:");
{
  const fs = await import("fs");
  const html = fs.readFileSync("./src/public/index.html", "utf-8");

  check("the command is registered", /"\/build":\s*\{/.test(html));
  // The new session IS the feature. Sending the prompt into the planning chat
  // is the bug it exists to prevent, so this asserts the order: create the
  // session, then emit.
  const create = html.indexOf('safeJson("/api/sessions", { method: "POST" })', html.indexOf("async function cmdBuild"));
  const emit = html.indexOf('socket.emit("send-message"', create);
  check("it creates a session before sending", create > 0 && emit > create, `create@${create} emit@${emit}`);
  check(
    "it refuses to send when the session could not be created",
    /Could not start a new chat, so the build prompt was not sent/.test(html)
  );
  // Asserted on the extraction regex itself, not on "Role:" appearing
  // somewhere in a 3,000-line file.
  const buildFn = html.slice(html.indexOf("async function cmdBuild"), html.indexOf("async function cmdSnapshots"));
  check("it scans chat code blocks for a Role: line", /querySelectorAll\("#chat-box pre/.test(buildFn));
  check("it takes the LAST matching block", /blocks\[blocks\.length - 1\]/.test(buildFn));
  check("it explains itself when no prompt is on screen", /No build prompt found in this chat/.test(buildFn));
}

console.log(
  failures === 0
    ? "\n🟢 The repair loop repairs, terminates, and reports what it could not fix.\n"
    : `\n🔴 ${failures} check(s) failed.\n`
);

process.exit(failures === 0 ? 0 : 1);

// The turn has to survive its own output being too long for the cap it was given.
//
// One real session — "build a lightcycle scene" — spent twelve auto-continue
// rounds and roughly 3.5 million tokens without producing a working scene. Three
// harness defects account for most of that, and this file asserts the properties
// that would have caught each.
//
//   1. THE GENERATION CAP MUST FIT A WHOLE-FILE WRITE. `write_text_file` sends a
//      file's contents as a JSON string tool argument. 16 KB of C#, once
//      newlines and quotes are escaped, runs well past the 4,096-token medium
//      cap — generation stopped mid-string and llama-server rejected the step
//      with `unexpected end of JSON input`. It happened four times in one
//      session, always on a large write and never on a small call.
//
//   2. RAISING THAT CAP MUST NOT RESIZE THE CONTEXT WINDOW. num_predict was
//      doing double duty as the generation cap AND as the headroom term in
//      chooseContextWindow, so the obvious fix for defect 1 would have pushed
//      every turn into a larger bucket — and num_ctx is what allocates the KV
//      cache (8k → 2.47 GB resident, 200k → 5.23 GB on qwen3.5:2b). The turn
//      that needs a big generation is rare; its memory cost must not be paid on
//      every "hi".
//
//   3. A TRUNCATED OUTPUT MUST NOT BE RETRIED BY SHRINKING THE PROMPT. The retry
//      escalation trimmed history — 40 messages, then 20, then 6. That is the
//      right recovery for a timeout and exactly backwards here: it gives the
//      output no more room and deletes the context the model needs to write the
//      file again. The transcript shows `retry 2 of 2, trimming to 6 messages`
//      followed by a worse file than the one that was truncated.
//
// Plus two reporting defects that made the above hard to see:
//
//   4. "% of context" SUMMED EVERY STEP'S PROMPT AND DIVIDED BY ONE WINDOW, so a
//      14-step turn that never exceeded a fifth of the window reported "293% of
//      context". The number grew with step count and said nothing about whether
//      anything actually overflowed.
//
//   5. A ROUND THAT REPEATS THE PREVIOUS ROUND'S WORK IS NOT PROGRESS. Rounds 5
//      through 8 each re-read the same nine files, produced no edit, and asked
//      to continue. The in-turn repeat guard cannot see across a round boundary.
//
// Usage: node scripts/verify-generation-budget.mjs
// Requires: npm run build

import fs from "fs";
import os from "os";
import path from "path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cullus-genbudget-"));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

let failures = 0;
const ok = (l, d = "") => console.log(`ok  ${l}${d ? ` — ${d}` : ""}`);
const bad = (l, d = "") => { console.error(`FAIL ${l}${d ? ` — ${d}` : ""}`); failures++; };

const provider = await import("../dist/core/provider.js");
const session = await import("../dist/core/session.js");

// ---------------------------------------------------------------------------
// 1. The cap is big enough for the write that broke it.
// ---------------------------------------------------------------------------

const medium = session.getEffortProfile("medium");

// The file that actually failed was 16,836 characters of C#. As a JSON string
// argument every newline and quote becomes two characters, so the tool call is
// materially larger than the file — and tokens for escaped source run denser
// than the ~4 chars/token of prose. 4,096 could not have carried it.
const OBSERVED_WRITE_CHARS = 16_836;
const conservativeTokens = Math.ceil(OBSERVED_WRITE_CHARS / 3.2);

if (medium.numPredict >= conservativeTokens) {
  ok(
    "medium's generation cap fits the write that truncated",
    `${medium.numPredict.toLocaleString()} ≥ ~${conservativeTokens.toLocaleString()} tokens for a ${OBSERVED_WRITE_CHARS.toLocaleString()}-char file`
  );
} else {
  bad(
    "medium's generation cap fits the write that truncated",
    `cap ${medium.numPredict} < ~${conservativeTokens} tokens needed`
  );
}

// ---------------------------------------------------------------------------
// 2. The cap and the window-sizing headroom are separate numbers.
// ---------------------------------------------------------------------------

if (medium.sizingHeadroom > 0 && medium.sizingHeadroom < medium.numPredict) {
  ok(
    "the generation cap is decoupled from context sizing",
    `cap ${medium.numPredict.toLocaleString()}, sizing headroom ${medium.sizingHeadroom.toLocaleString()}`
  );
} else {
  bad(
    "the generation cap is decoupled from context sizing",
    `cap ${medium.numPredict}, headroom ${medium.sizingHeadroom} — sizing still tracks the cap`
  );
}

// And prove the decoupling has the effect it exists for: a short conversation
// must land in the same bucket it would have before the cap was raised.
{
  const short = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "hi" },
  ];
  const CEILING = 262_144;

  const sizedByHeadroom = provider.chooseContextWindow(short, medium.sizingHeadroom, CEILING, 0);
  const sizedByCap = provider.chooseContextWindow(short, medium.numPredict, CEILING, 0);

  if (sizedByHeadroom < sizedByCap) {
    ok(
      "sizing by headroom keeps a short turn in a smaller bucket",
      `${sizedByHeadroom.toLocaleString()} vs ${sizedByCap.toLocaleString()} if it tracked the cap`
    );
  } else {
    bad(
      "sizing by headroom keeps a short turn in a smaller bucket",
      `headroom ${sizedByHeadroom}, cap ${sizedByCap} — no saving`
    );
  }
}

// ---------------------------------------------------------------------------
// 3. A truncation is recognised, and recognised as distinct from a timeout.
// ---------------------------------------------------------------------------
//
// isOutputTruncation is module-private on purpose — nothing outside the retry
// loop should be branching on it. Assert the strings it has to match against the
// compiled source, which is the same guarantee without widening the API.

{
  const compiled = fs.readFileSync(
    new URL("../dist/core/provider.js", import.meta.url),
    "utf-8"
  );

  const truncationMessages = [
    // The exact llama-server rejection from the session.
    'llama-server returned invalid tool call arguments for "write_text_file": unexpected end of JSON input',
    "Unexpected end of JSON input",
    "Unterminated string in JSON at position 8021",
  ];

  // Pull the predicate out of the built bundle and exercise it directly, so this
  // asserts behaviour rather than the presence of a regex.
  const match = compiled.match(/function isOutputTruncation\(err\)\s*\{[\s\S]*?\n\}/);
  if (!match) {
    bad("the truncation predicate exists in the built provider");
  } else {
    const isOutputTruncation = new Function(`${match[0]}; return isOutputTruncation;`)();

    const missed = truncationMessages.filter((m) => !isOutputTruncation({ message: m }));
    if (missed.length === 0) {
      ok("every truncation phrasing is recognised", `${truncationMessages.length}/${truncationMessages.length}`);
    } else {
      bad("every truncation phrasing is recognised", `missed: ${missed.join(" | ")}`);
    }

    // The distinction is the whole point: a timeout must NOT take the
    // raise-the-cap path, or a genuinely oversized prompt never gets trimmed.
    const notTruncations = [
      "fetch failed",
      "request to http://127.0.0.1:11434/api/chat failed, reason: socket hang up",
      "model requires more system memory than is available",
      "timed out after 300s",
    ];
    const misfired = notTruncations.filter((m) => isOutputTruncation({ message: m }));
    if (misfired.length === 0) {
      ok("a timeout or OOM is not mistaken for a truncation", `${notTruncations.length} checked`);
    } else {
      bad("a timeout or OOM is not mistaken for a truncation", `misfired on: ${misfired.join(" | ")}`);
    }
  }

  // The recovery has to turn the right knob. On the truncation branch the
  // generation cap is raised and the history cap is left alone; the old code had
  // exactly one branch and it always trimmed.
  if (/isOutputTruncation\(explained\)/.test(compiled) && /MAX_ESCALATED_NUM_PREDICT/.test(compiled)) {
    ok("the retry path branches on truncation and raises the cap");
  } else {
    bad("the retry path branches on truncation and raises the cap");
  }

  // num_predict must come from the per-step variable the retry raises, not
  // straight from the profile — otherwise the raise is computed and discarded.
  if (/num_predict:\s*generationCap/.test(compiled)) {
    ok("the request sends the escalated cap, not the profile's");
  } else {
    bad("the request sends the escalated cap, not the profile's", "num_predict is not wired to generationCap");
  }
}

// ---------------------------------------------------------------------------
// 4. The context meter reports a peak, not a sum.
// ---------------------------------------------------------------------------

{
  // A turn's usage is accumulated across steps; the peak must not be.
  const usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    contextLength: 65_536,
    steps: 0,
    peakPromptTokens: 0,
  };

  // Fourteen steps averaging ~13k prompt each — the shape of the real session.
  const stepPrompts = [12_545, 17_706, 20_824, 30_751, 33_466, 33_079, 32_871, 35_670, 35_321, 34_455, 34_357, 34_143, 34_320, 27_586];
  for (const p of stepPrompts) {
    usage.promptTokens += p;
    usage.peakPromptTokens = Math.max(usage.peakPromptTokens, p);
  }

  const sumPct = Math.round((usage.promptTokens / usage.contextLength) * 100);
  const peakPct = Math.round((usage.peakPromptTokens / usage.contextLength) * 100);

  if (sumPct > 100 && peakPct <= 100) {
    ok(
      "the sum overstates what the peak shows honestly",
      `sum reads ${sumPct}% of context, peak reads ${peakPct}%`
    );
  } else {
    bad("the sum overstates what the peak shows honestly", `sum ${sumPct}%, peak ${peakPct}%`);
  }

  // And the UI has to be reading the peak. Both the meter and the per-turn
  // footer had the same bug, so check both.
  const ui = fs.readFileSync(new URL("../dist/public/index.html", import.meta.url), "utf-8");
  const readsPeak = (ui.match(/usage\.peakPromptTokens/g) ?? []).length;
  if (readsPeak >= 2) {
    ok("both the meter and the footer read the peak", `${readsPeak} references`);
  } else {
    bad("both the meter and the footer read the peak", `only ${readsPeak} reference(s)`);
  }
}

// ---------------------------------------------------------------------------
// 5. A round that repeats earlier work is recognised as no progress.
// ---------------------------------------------------------------------------

{
  const { isBarrenRound, BARREN_ROUNDS_BEFORE_STOP } = session;

  // The observed loop: nine tool calls, every one of them already made.
  if (isBarrenRound(9, 0)) ok("a round of nine repeated calls counts as barren");
  else bad("a round of nine repeated calls counts as barren");

  // One new discovery is progress, however slight — the run must not be cut off
  // for being slow.
  if (!isBarrenRound(9, 1)) ok("one novel call is enough to count as progress");
  else bad("one novel call is enough to count as progress");

  // A round that called NOTHING while asking to continue is the worst case, not
  // an exempt one.
  //
  // The first version of this rule required two or more calls before a round
  // could count as barren, on the reasoning that a round making no calls had
  // answered from what it already knew. A later run spent nine rounds proving
  // that wrong: zero tool calls, a flat "I cannot do this with my available
  // tools", and a continuation marker every time — each round exempt from the
  // check precisely because it had done nothing. The predicate is only consulted
  // after a continuation has been parsed, so the model has already claimed work
  // remains; zero calls at that point is not thrift.
  if (isBarrenRound(0, 0)) ok("a round that asks to continue and calls nothing is barren");
  else bad("a round that asks to continue and calls nothing is barren", "the call-count floor is back");

  // Same reasoning for one repeated call: no new information is no progress.
  if (isBarrenRound(1, 0)) ok("a single repeated call is also no progress");
  else bad("a single repeated call is also no progress");

  // Tolerance exists, and is finite. Twelve rounds of nothing was the bug.
  if (BARREN_ROUNDS_BEFORE_STOP >= 2 && BARREN_ROUNDS_BEFORE_STOP < 5) {
    ok("the run tolerates a re-verifying round but not a loop", `stops after ${BARREN_ROUNDS_BEFORE_STOP}`);
  } else {
    bad("the run tolerates a re-verifying round but not a loop", `threshold ${BARREN_ROUNDS_BEFORE_STOP}`);
  }

  // The server has to be counting novel calls per round and consulting the rule,
  // or the exported predicate is decoration.
  const server = fs.readFileSync(new URL("../dist/core/server.js", import.meta.url), "utf-8");
  const wired =
    /seenCalls/.test(server) &&
    /isBarrenRound\(/.test(server) &&
    /BARREN_ROUNDS_BEFORE_STOP/.test(server);
  if (wired) ok("the auto-continue loop tracks novel calls and applies the rule");
  else bad("the auto-continue loop tracks novel calls and applies the rule");
}

// ---------------------------------------------------------------------------
// 6. "Continue: I am finished" must not become the next round's task.
// ---------------------------------------------------------------------------
//
// Whatever follows the marker is written verbatim into the next round's prompt
// by decideContinuation and then restated as the task by anchorRequest. So a
// model that ends with `[[CONTINUE]] Task complete, nothing further` has made
// "Task complete" its own next instruction, which it answers by asserting
// completion, with the marker attached. Observed: nine rounds, every one of them
// summarised as "next: Task complete all required functionality implemented…".
//
// The discriminator has to be grammatical. A completion CLAIM has a subject
// before the word; an INSTRUCTION has an object after it. Rejecting the bare
// imperative would stop real work, which is worse than the loop.

{
  const { parseContinuation, CONTINUE_MARKER } = session;
  const withMarker = (text) => parseContinuation(`Some answer text.\n${CONTINUE_MARKER} ${text}`);

  // Verbatim from the run that looped.
  const mustStop = [
    "Task complete all required functionality implemented and documented.",
    "Task cannot be completed No Unity Editor access available.",
    "The system is functionally complete and ready for manual implementation.",
    "System ready for manual implementation by user in Unity Editor.",
    "Nothing further I can do with the available tools.",
    "Already implemented in the previous turn.",
    "Unable to proceed without Editor access.",
    "Everything is done.",
  ];

  // Real next steps, several chosen specifically because they START with a word
  // that appears in the stop list.
  const mustResume = [
    "Add the Rigidbody component to PlayerBike",
    "Save PlayerBike as a prefab in Assets/Prefabs",
    "Complete the trail renderer setup on the bike",
    "Complete implementation of the pickup spawner",
    "Finish wiring the score UI",
    "Implement the boost pad trigger",
    "Done with the script, now add the collider",
    "Compile the project and fix any errors",
  ];

  const leaked = mustStop.filter((t) => withMarker(t) !== null);
  if (leaked.length === 0) {
    ok("a completion or impossibility claim does not resume", `${mustStop.length} phrasings`);
  } else {
    bad("a completion or impossibility claim does not resume", `still resumes on: ${leaked.join(" | ")}`);
  }

  const blocked = mustResume.filter((t) => withMarker(t) === null);
  if (blocked.length === 0) {
    ok("a real next step still resumes, including imperatives", `${mustResume.length} phrasings`);
  } else {
    bad(
      "a real next step still resumes, including imperatives",
      `wrongly stopped on: ${blocked.join(" | ")} — this is worse than the loop it prevents`
    );
  }
}

// ---------------------------------------------------------------------------
// 7. Compaction must not launder a tool failure into a missing capability.
// ---------------------------------------------------------------------------
//
// The summary marker told the model to treat every fact as established and not
// redo the steps described. Applied to a finding that is correct; applied to
// "cannot connect to the Unity Editor Pipeline server at 127.0.0.1:7800" it
// freezes a transient outage into a permanent limitation. The user then opened
// the Editor and said so, and the model — holding a summary stating the
// capability was absent — spent nine rounds explaining the task was impossible,
// while the same tools succeeded every time it actually called them.

{
  const compaction = fs.readFileSync(
    new URL("../dist/core/compaction.js", import.meta.url),
    "utf-8"
  );

  // The reducer must be told to record outages as point-in-time.
  if (/point-in-time|at the time|ENVIRONMENT AT THE TIME/i.test(compaction)) {
    ok("the reducer records outages as point-in-time, not as properties of the world");
  } else {
    bad("the reducer records outages as point-in-time, not as properties of the world");
  }

  // And the marker must carve out the exemption, or the instruction to trust the
  // summary re-freezes it.
  const carveOut =
    /may be running|unreachable may|not how they are now|only way to find out/i.test(compaction);
  if (carveOut) {
    ok("the summary marker exempts tool and connection failures from 'established'");
  } else {
    bad("the summary marker exempts tool and connection failures from 'established'");
  }

  // The blanket phrasing must be gone: "every fact" included the outage.
  if (!/treat every fact in it as\s*` \+\s*`established/.test(compaction) &&
      !/treat every fact in it as established/.test(compaction)) {
    ok("the blanket 'treat every fact as established' phrasing is gone");
  } else {
    bad("the blanket 'treat every fact as established' phrasing is gone");
  }
}

console.log(
  failures === 0
    ? "\nPASS: a whole-file write fits the cap, the cap does not resize the window, a truncated output is retried with more room, the meter and the round loop report honestly, a completion claim does not resume, and compaction does not freeze an outage into a limitation."
    : `\n${failures} check(s) failed.`
);

fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

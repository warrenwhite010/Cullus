// What the model is told about a tool call has to be true.
//
// Four ways it was not, all of them found in one lost session. None of these
// crashed anything — each one quietly handed the model a false picture and let
// it reason on from there, which is far more expensive than an error.
//
//   1. TRUNCATION KEPT THE HEAD AND THREW AWAY THE TAIL. A 5.8KB source file was
//      read to diagnose a compiler error on line 100; the result was cut at 8k
//      of serialised JSON and line 100 was in the discarded part. The model
//      diagnosed a different, real, error from the half it could see — three
//      times, because every re-read truncated identically. The cut also carried
//      no way to get the rest, and was appended after JSON.stringify, so the
//      result was not even valid JSON.
//
//   2. UNKNOWN ARGUMENTS WERE ACCEPTED SILENTLY. `console({command: "..."})` —
//      where console takes only tail/level/since — was passed through, the
//      server ignored the key it did not know, and a normal-looking result came
//      back. Two steps of reasoning followed from "I issued a command".
//
//   3. THE REPETITION GUARD BANNED POLLING. Its key is tool name + arguments, so
//      for a no-argument status tool the signature is a constant and the second
//      call of the turn was permanently blocked. Waiting for a compile is done
//      by polling; the model was reduced to "no parameters to vary" and started
//      contriving other calls to get around the guard.
//
//   4. THE TOOL RANKER COULD NOT SEE TOOL OUTPUT. It ranked on the user's
//      messages only, so the turn's tool list was frozen at the wording of the
//      opening request. `attach_script` failed with "run `recompile`, poll
//      `recompile_status`" and the ranker could not read that sentence — the two
//      tools the model had just been told to call stayed out of its list.
//
// Usage: node scripts/verify-tool-fidelity.mjs
// Requires: npm run build

import fs from "fs";
import os from "os";
import path from "path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cullus-fidelity-"));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

let failures = 0;
const ok = (l, d = "") => console.log(`ok  ${l}${d ? ` — ${d}` : ""}`);
const bad = (l, d = "") => { console.error(`FAIL ${l}${d ? ` — ${d}` : ""}`); failures++; };

const ollama = (await import("ollama")).default;
const provider = await import("../dist/core/provider.js");
const { mcpManager } = await import("../dist/core/mcpManager.js");
const { localToolRegistry } = await import("../dist/core/tools.js");
const toolResults = await import("../dist/core/toolResults.js");

const MODEL = "test-model";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  if (url.includes("/api/tags")) {
    return new Response(JSON.stringify({ models: [{ name: MODEL }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};
ollama.show = async () => ({});

function stream(chunks) {
  const iterator = (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
  iterator.abort = () => {};
  return iterator;
}

const call = (name, args = {}) =>
  stream([
    { message: { content: "", tool_calls: [{ function: { name, arguments: args } }] } },
    { done: true, prompt_eval_count: 10, eval_count: 5 },
  ]);

const answer = (text) =>
  stream([{ message: { content: text } }, { done: true, prompt_eval_count: 10, eval_count: 5 }]);

const realChat = ollama.chat.bind(ollama);
const realGetTools = mcpManager.getAllOllamaTools.bind(mcpManager);
const realCallTool = mcpManager.callTool.bind(mcpManager);
const realServerMap = mcpManager.getToolServerMap.bind(mcpManager);

function scriptModel(script) {
  let turn = 0;
  ollama.chat = async () => script[Math.min(turn++, script.length - 1)]();
}

function restore() {
  ollama.chat = realChat;
  mcpManager.getAllOllamaTools = realGetTools;
  mcpManager.callTool = realCallTool;
  mcpManager.getToolServerMap = realServerMap;
}

const toolSchema = (name, properties = {}, required = []) => ({
  type: "function",
  function: { name, description: `${name} for the test`, parameters: { type: "object", properties, required } },
});

/** The tool messages a turn put into the transcript, in order. */
function toolReplies(capture) {
  return capture.map((c) => {
    try {
      return JSON.parse(c);
    } catch {
      return { UNPARSEABLE: c };
    }
  });
}

// --- 1. truncation keeps both ends, and the rest stays readable ------------
{
  // A file whose interesting line is near the END — the shape that broke.
  const body = [
    "using UnityEngine;",
    ...Array.from({ length: 400 }, (_, i) => `    // filler line ${i} padding padding padding`),
    "        bolt.numPoints = 9;   // THE ACTUAL ERROR",
    "}",
  ].join("\n");

  const captured = [];
  mcpManager.getAllOllamaTools = async () => [toolSchema("read_file", { path: { type: "string" } })];
  mcpManager.getToolServerMap = () => new Map([["read_file", "testserver"]]);
  mcpManager.callTool = async () => ({ contents: body });

  scriptModel([() => call("read_file", { path: "StormSky.cs" }), () => answer("read it")]);

  const originalPush = Array.prototype.push;
  // Capture what actually lands in the transcript by watching the tool replies
  // the turn produces. The provider hands them to saveTurn; isolated turns skip
  // that, so read them back off the result of a non-isolated turn instead.
  const sessions = await import("../dist/core/sessions.js");
  sessions.createSession("truncation test");

  await provider.getAiResponse("read the file", MODEL, undefined, undefined, { maxSteps: 3 });

  const stored = sessions.getActiveSession();
  const toolMessage = stored.history.filter((m) => m.role === "tool").pop();
  const parsed = (() => {
    try {
      return JSON.parse(toolMessage.content);
    } catch {
      return null;
    }
  })();

  if (parsed) {
    ok("a truncated result is still valid JSON");
  } else {
    bad("a truncated result is still valid JSON", "it did not parse");
  }

  if (parsed?.truncated === true && typeof parsed.resultId === "string") {
    ok("truncation is announced in a field, not appended prose", parsed.resultId);
  } else {
    bad("truncation is announced in a field, not appended prose", JSON.stringify(parsed)?.slice(0, 120));
  }

  if (parsed?.tail?.includes("numPoints")) {
    ok("the end of a long result survives truncation", "the error line is visible");
  } else {
    bad("the end of a long result survives truncation", "the tail was discarded — the old bug");
  }

  // ...and the omitted middle is readable rather than gone.
  const page = toolResults.readToolResult(parsed.resultId, 0, 20_000);
  if (page && page.totalChars > (parsed.head.length + parsed.tail.length)) {
    ok("the full result is kept and readable", `${page.totalChars} chars stored`);
  } else {
    bad("the full result is kept and readable", JSON.stringify(page)?.slice(0, 120));
  }

  // Paging walks to the end and stops.
  let offset = 0;
  let pages = 0;
  while (offset !== null && pages < 200) {
    const p = toolResults.readToolResult(parsed.resultId, offset, 2_000);
    if (!p) break;
    offset = p.nextOffset;
    pages++;
  }
  if (offset === null && pages > 1) {
    ok("nextOffset pages to the end and stops", `${pages} page(s)`);
  } else {
    bad("nextOffset pages to the end and stops", `stopped at ${offset} after ${pages} page(s)`);
  }

  Array.prototype.push = originalPush;
  restore();
}

// --- 1b. read_tool_result is a real, registered tool -----------------------
{
  const tool = localToolRegistry.get("read_tool_result");
  if (tool) {
    ok("read_tool_result is registered");
  } else {
    bad("read_tool_result is registered", "the id would be unusable");
  }

  const id = toolResults.stashToolResult("read_file", "0123456789abcdefghij");
  const page = await tool.handler({ resultId: id, offset: 10, length: 5 });
  if (page?.content === "abcde" && page.nextOffset === 15) {
    ok("it reads the window it was asked for", `"${page.content}" then ${page.nextOffset}`);
  } else {
    bad("it reads the window it was asked for", JSON.stringify(page));
  }

  const missing = await tool.handler({ resultId: "res_does_not_exist" });
  if (missing?.error === true && Array.isArray(missing.available)) {
    ok("an aged-out id is refused with the ids that remain");
  } else {
    bad("an aged-out id is refused with the ids that remain", JSON.stringify(missing)?.slice(0, 120));
  }
}

// --- 2. unknown arguments are refused, not passed through ------------------
{
  const dispatched = [];

  mcpManager.getAllOllamaTools = async () => [
    toolSchema("console", { tail: { type: "number" }, level: { type: "string" } }),
  ];
  mcpManager.getToolServerMap = () => new Map([["console", "testserver"]]);
  mcpManager.callTool = async (name, args) => {
    dispatched.push({ name, args });
    return { entries: [] };
  };

  // The exact call from the lost session: `command` is not in console's schema.
  scriptModel([() => call("console", { command: "recompile_status" }), () => answer("gave up")]);

  await provider.getAiResponse("check the console", MODEL, undefined, undefined, {
    isolated: true,
    maxSteps: 3,
  });

  if (dispatched.length === 0) {
    ok("a call with an undeclared argument is not dispatched", '"command" is not in console\'s schema');
  } else {
    bad("a call with an undeclared argument is not dispatched", JSON.stringify(dispatched[0]));
  }

  restore();
}

// --- 2b. ...but a legitimate call still goes through -----------------------
//
// The guard has to be narrow. A tool with no declared properties, or one that
// opts into extras, must keep working.
{
  const dispatched = [];

  mcpManager.getAllOllamaTools = async () => [
    toolSchema("console", { tail: { type: "number" }, level: { type: "string" } }),
    toolSchema("passthrough"),
  ];
  mcpManager.getToolServerMap = () =>
    new Map([["console", "testserver"], ["passthrough", "testserver"]]);
  mcpManager.callTool = async (name, args) => {
    dispatched.push({ name, args });
    return { ok: true };
  };

  scriptModel([
    () => call("console", { tail: 8, level: "error" }),
    () => call("passthrough", { anything: "at all" }),
    () => answer("done"),
  ]);

  await provider.getAiResponse("check the console", MODEL, undefined, undefined, {
    isolated: true,
    maxSteps: 4,
  });

  if (dispatched.some((d) => d.name === "console" && d.args.tail === 8)) {
    ok("declared arguments still dispatch normally");
  } else {
    bad("declared arguments still dispatch normally", JSON.stringify(dispatched));
  }

  if (dispatched.some((d) => d.name === "passthrough" && d.args.anything === "at all")) {
    ok("a tool that declares no properties still takes anything");
  } else {
    bad("a tool that declares no properties still takes anything", JSON.stringify(dispatched));
  }

  restore();
}

// --- 3. polling a status tool is allowed; spinning on it is not ------------
{
  let calls = 0;

  mcpManager.getAllOllamaTools = async () => [toolSchema("editor_status"), toolSchema("wait")];
  mcpManager.getToolServerMap = () =>
    new Map([["editor_status", "unity"], ["wait", "local"]]);
  mcpManager.callTool = async (name) => {
    if (name === "editor_status") calls++;
    return { status: "ready", compiling: false };
  };

  // status, status, status — the poll loop that used to be banned outright at
  // the second call, since a no-argument tool's signature never varies.
  scriptModel([
    () => call("editor_status"),
    () => call("editor_status"),
    () => call("editor_status"),
    () => answer("still compiling"),
  ]);

  await provider.getAiResponse("wait for the compile", MODEL, undefined, undefined, {
    isolated: true,
    maxSteps: 5,
  });

  if (calls >= 3) {
    ok("a no-argument status tool can be polled", `${calls} calls got through`);
  } else {
    bad("a no-argument status tool can be polled", `only ${calls} of 3 dispatched`);
  }

  restore();
}

// --- 3a. the read/write classifier does not misread a status tool ----------
//
// This is what actually broke polling: the classifier matched `edit` as a bare
// substring, so `editor_status` — a read — was treated as a write and banned
// from repeating.
{
  const { isMutatingTool } = await import("../dist/core/session.js");

  const reads = ["editor_status", "editor_play", "get_editor", "console", "read_text_file"];
  const writes = ["edit_file", "write_file", "create_script", "execute_shell_command", "obsidian_patch_note"];

  const misread = reads.filter((n) => isMutatingTool(n));
  const missed = writes.filter((n) => !isMutatingTool(n));

  if (misread.length === 0) {
    ok("status and read tools are classified as reads", reads.join(", "));
  } else {
    bad("status and read tools are classified as reads", `misread: ${misread.join(", ")}`);
  }

  if (missed.length === 0) {
    ok("writes are still classified as writes", writes.join(", "));
  } else {
    bad("writes are still classified as writes", `missed: ${missed.join(", ")}`);
  }
}

// --- 3b. ...and a model spinning on it is still stopped --------------------
{
  let calls = 0;

  mcpManager.getAllOllamaTools = async () => [toolSchema("editor_status")];
  mcpManager.getToolServerMap = () => new Map([["editor_status", "unity"]]);
  mcpManager.callTool = async () => {
    calls++;
    return { status: "ready" };
  };

  scriptModel([...Array.from({ length: 8 }, () => () => call("editor_status")), () => answer("gave up")]);

  await provider.getAiResponse("wait for the compile", MODEL, undefined, undefined, {
    isolated: true,
    maxSteps: 8,
  });

  if (calls <= 4) {
    ok("an unbroken run of identical calls is cut off", `${calls} dispatched before the guard`);
  } else {
    bad("an unbroken run of identical calls is cut off", `${calls} got through`);
  }

  restore();
}

// --- 3c. wait is a real tool, so a poll loop can actually wait -------------
{
  const tool = localToolRegistry.get("wait");
  if (!tool) {
    bad("wait is registered", "sleep via the shell was the only option");
  } else {
    const began = Date.now();
    const result = await tool.handler({ seconds: 1, reason: "the compile" });
    const elapsed = Date.now() - began;

    if (result?.ok === true && elapsed >= 900) {
      ok("wait is registered and actually waits", `${elapsed}ms`);
    } else {
      bad("wait is registered and actually waits", `${elapsed}ms, ${JSON.stringify(result)}`);
    }

    const capped = await tool.handler({ seconds: 9999 });
    if (capped.waitedSeconds <= 60) {
      ok("wait is capped", `${capped.waitedSeconds}s`);
    } else {
      bad("wait is capped", `${capped.waitedSeconds}s`);
    }
  }
}

// --- 4. the ranker reads tool output, not just the user's wording ----------
//
// The turn's opening request says nothing about recompiling. The FIRST tool
// result does — exactly as attach_script's real error does. That has to be
// enough to bring `recompile` into the list.
{
  const dispatched = [];

  const many = [
    toolSchema("attach_script"),
    ...Array.from({ length: 40 }, (_, i) => toolSchema(`filler_${String(i).padStart(2, "0")}`)),
    toolSchema("recompile"),
  ];

  mcpManager.getAllOllamaTools = async () => many;
  mcpManager.getToolServerMap = () => new Map(many.map((t) => [t.function.name, "testserver"]));
  mcpManager.callTool = async (name) => {
    dispatched.push(name);
    if (name === "attach_script") {
      return {
        error: true,
        message:
          "Script has no resolvable class. If you just edited this script it is not " +
          "compiled yet: run 'recompile', poll 'recompile_status', then retry attach_script.",
      };
    }
    return { ok: true };
  };

  // Step 1 calls attach_script and gets that error. Step 2 asks for the tool
  // list again — and `recompile` has to be in it.
  scriptModel([() => call("attach_script"), () => call("recompile"), () => answer("done")]);

  await provider.getAiResponse("attach the script to Arena", MODEL, undefined, undefined, {
    isolated: true,
    maxSteps: 4,
  });

  if (dispatched.includes("recompile")) {
    ok("a tool named in an error becomes reachable", "the ranker read the tool output");
  } else {
    bad("a tool named in an error becomes reachable", `only ran ${JSON.stringify(dispatched)}`);
  }

  restore();
}

console.log(
  failures === 0
    ? "\nPASS: truncation keeps both ends and stays readable, bad arguments are refused, polling works, and the ranker reads tool output."
    : `\n${failures} check(s) failed.`
);

fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

// The Unity path, and the two guards added alongside it.
//
// All of this exists because of one measured run: `Assets/Scripts/StormSky.cs
// (71,37): error CS0103: The name 'RenderQueue' does not exist in the current
// context` was handed to a five-worker fan-out, which spent 23 minutes, failed
// web_search on every call, hand-fetched three search engines through fetch_url,
// and had four of its five workers independently read the same file. The answer
// was `using UnityEngine.Rendering;`.
//
// Four things had to change for that run to go differently, and each is asserted
// here rather than assumed:
//
//   1. unity_symbol resolves the namespace offline, from the installed editor.
//   2. isSingleDiagnostic keeps a one-error goal out of the fan-out entirely.
//   3. isSearchResultsPage refuses the hand-rolled search that follows a failed
//      web_search.
//   4. parseCompilerDiagnostics turns an editor log back into structured errors,
//      deduplicated — Unity prints each one several times.
//
// The unity_symbol assertions need a real Unity install and SKIP without one, so
// this stays runnable on a machine that has never had Unity on it. Everything
// else is pure and always runs.
//
// Usage: node scripts/verify-unity-tools.mjs
// Requires: npm run build

import fs from "fs";
import os from "os";
import path from "path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cullus-unity-test-"));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

let failures = 0;
let skipped = 0;
const ok = (l, d = "") => console.log(`ok  ${l}${d ? ` — ${d}` : ""}`);
const bad = (l, d = "") => {
  console.error(`FAIL ${l}${d ? ` — ${d}` : ""}`);
  failures++;
};
const skip = (l, d = "") => {
  console.log(`skip ${l}${d ? ` — ${d}` : ""}`);
  skipped++;
};

const unity = await import("../dist/core/unityTools.js");
const pool = await import("../dist/core/agentPool.js");
const web = await import("../dist/core/webTools.js");

// The error that started all of this, verbatim.
const REAL_ERROR =
  "Assets/Scripts/StormSky.cs(71,37): error CS0103: The name 'RenderQueue' does not exist in the current context";

// ---------------------------------------------------------------------------
// 1. Finding a Unity project
// ---------------------------------------------------------------------------
{
  const root = path.join(sandbox, "SomeGame");
  fs.mkdirSync(path.join(root, "ProjectSettings"), { recursive: true });
  fs.mkdirSync(path.join(root, "Assets", "Scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.12f1\nm_EditorVersionWithRevision: 6000.3.12f1 (fca03ac9b0d5)\n"
  );

  const found = unity.findUnityProject(path.join(root, "Assets", "Scripts"));
  if (found?.root === root) ok("a project is found from a file deep inside it", "Assets/Scripts -> root");
  else bad("a project is found from a file deep inside it", JSON.stringify(found));

  if (found?.version === "6000.3.12f1") ok("the editor version is read from ProjectVersion.txt", found.version);
  else bad("the editor version is read from ProjectVersion.txt", String(found?.version));

  if (unity.findUnityProject(sandbox) === null) ok("a directory that is not a Unity project is not claimed");
  else bad("a directory that is not a Unity project is not claimed");
}

// ---------------------------------------------------------------------------
// 2. unity_symbol: the actual answer, offline
// ---------------------------------------------------------------------------
{
  const editor = unity.findEditor("6000.3.12f1");

  if (!editor) {
    skip("RenderQueue resolves to UnityEngine.Rendering", "no Unity editor installed on this machine");
    skip("a symbol that is not a Unity type is reported as absent", "no Unity editor installed");
  } else {
    const index = unity.buildSymbolIndex(editor.path);

    if (index.size > 1000) ok("the symbol index built from the editor's XML docs", `${index.size} types`);
    else bad("the symbol index built from the editor's XML docs", `only ${index.size} types`);

    const matches = index.get("RenderQueue") ?? [];
    const rendering = matches.find((m) => m.fullName === "UnityEngine.Rendering.RenderQueue");

    if (rendering) {
      ok("RenderQueue resolves to UnityEngine.Rendering", `using ${rendering.namespace}; (${rendering.assembly})`);
    } else {
      bad("RenderQueue resolves to UnityEngine.Rendering", JSON.stringify(matches));
    }

    // A type that certainly exists and one that certainly does not, so a broken
    // index cannot pass by returning something for everything.
    if ((index.get("MonoBehaviour") ?? []).some((m) => m.namespace === "UnityEngine")) {
      ok("a second known type resolves too", "MonoBehaviour -> UnityEngine");
    } else {
      bad("a second known type resolves too");
    }

    if (!index.has("NotARealUnityTypeXyzzy")) ok("a symbol that is not a Unity type is reported as absent");
    else bad("a symbol that is not a Unity type is reported as absent");

    // The handler, not just the index: this is what a model actually calls, and
    // the error text is what a model actually passes.
    const { registerUnityTools } = unity;
    const { localToolRegistry } = await import("../dist/core/tools.js");
    registerUnityTools();
    const tool = localToolRegistry.get("unity_symbol");

    if (!tool) {
      bad("unity_symbol is registered as a callable tool");
    } else {
      ok("unity_symbol is registered as a callable tool");

      const answer = await tool.handler({ name: REAL_ERROR });

      // Unity ships an umbrella UnityEngine.dll forwarding to the module DLLs,
      // so every type is listed at least twice. Reporting that as an ambiguity
      // sends the model to the web to break a tie that does not exist.
      if (answer.found && answer.matches?.length === 1) {
        ok("the pasted error resolves to exactly one type", answer.matches[0].usingDirective);
      } else {
        bad("the pasted error resolves to exactly one type", JSON.stringify(answer.matches));
      }

      if (answer.matches?.[0]?.usingDirective === "using UnityEngine.Rendering;") {
        ok("the handler returns the using directive that fixes the file");
      } else {
        bad("the handler returns the using directive that fixes the file", JSON.stringify(answer));
      }

      if ((answer.matches?.[0]?.assemblies ?? []).includes("UnityEngine.CoreModule")) {
        ok("the forwarding assemblies are reported together", answer.matches[0].assemblies.join(" + "));
      } else {
        bad("the forwarding assemblies are reported together", JSON.stringify(answer.matches?.[0]));
      }

      const vague = await tool.handler({ name: "this sentence has no symbol in it at all" });
      if (vague.error) ok("a prompt with no identifier is refused, not guessed at");
      else bad("a prompt with no identifier is refused, not guessed at", JSON.stringify(vague));
    }
  }
}

// ---------------------------------------------------------------------------
// 3. The fan-out gate
// ---------------------------------------------------------------------------
{
  if (pool.isSingleDiagnostic(REAL_ERROR)) ok("the StormSky error is kept out of the fan-out");
  else bad("the StormSky error is kept out of the fan-out");

  if (pool.isSingleDiagnostic("src/app.ts(12,3): error TS2304: Cannot find name 'foo'")) {
    ok("a TypeScript diagnostic is caught too");
  } else {
    bad("a TypeScript diagnostic is caught too");
  }

  // Two distinct sites is real work to split, and must NOT be collapsed.
  const two =
    "Assets/A.cs(10,1): error CS0103: The name 'X' does not exist\n" +
    "Assets/B.cs(22,4): error CS0246: could not find type 'Y'";
  if (!pool.isSingleDiagnostic(two)) ok("two separate errors still fan out", "2 distinct file:line sites");
  else bad("two separate errors still fan out");

  // The same error pasted twice is still one problem.
  if (pool.isSingleDiagnostic(`${REAL_ERROR}\n${REAL_ERROR}`)) {
    ok("the same error pasted twice is still one problem");
  } else {
    bad("the same error pasted twice is still one problem");
  }

  const ordinary = "Compare Unity's URP and HDRP for a racing game, and recommend one.";
  if (!pool.isSingleDiagnostic(ordinary)) ok("an ordinary research goal still fans out");
  else bad("an ordinary research goal still fans out");
}

// ---------------------------------------------------------------------------
// 4. The hand-rolled-search guard
// ---------------------------------------------------------------------------
{
  // Exactly the URLs the observed run fetched after web_search failed.
  const refuse = [
    "https://html.duckduckgo.com/html/?q=Unity+RenderQueue",
    "https://www.mojeek.com/search?q=Unity+CS0103+RenderQueue",
    "https://www.ecosia.org/search?q=Unity+RenderQueue+namespace",
    "https://www.google.com/search?q=unity+renderqueue",
    "https://lite.duckduckgo.com/lite/?q=unity",
  ];

  let allRefused = true;
  for (const url of refuse) {
    if (!web.isSearchResultsPage(new URL(url))) {
      allRefused = false;
      bad("a search results page is refused", url);
    }
  }
  if (allRefused) ok("every search engine the run tried is refused", `${refuse.length}/${refuse.length}`);

  // Documentation and ordinary pages must still be fetchable, including on a
  // search engine's own domain.
  const allow = [
    "https://docs.unity3d.com/6000.0/Documentation/Manual/class-RenderQueue.html",
    "https://docs.unity3d.com/ScriptReference/Rendering.RenderQueue.html",
    "https://duckduckgo.com/privacy",
    "https://forum.unity.com/threads/renderqueue.123456/",
  ];

  let allAllowed = true;
  for (const url of allow) {
    if (web.isSearchResultsPage(new URL(url))) {
      allAllowed = false;
      bad("a real page is still fetchable", url);
    }
  }
  if (allAllowed) ok("documentation pages are still fetchable", `${allow.length}/${allow.length}`);
}

// ---------------------------------------------------------------------------
// 5. unity_symbol survives the tool budget on the question that needs it
// ---------------------------------------------------------------------------
//
// A local tool has no server, so it lands in the lowest-confidence ranking band
// and is the first thing the tool budget cuts. With a Unity Editor connected
// that is 55 MCP tools ranking above the one tool that answers the question
// offline — which would have made all of this useless in exactly the case it
// was built for.
{
  const { selectRelevantTools } = await import("../dist/core/provider.js");

  const tool = (name, description = "") => ({ type: "function", function: { name, description } });

  // A realistic over-budget spread: Unity's authoring set, GitHub, the vault.
  const tools = [
    tool("unity_symbol", "Resolve a Unity/C# type name to its namespace"),
    tool("unity_compile", "Compile a Unity project and return compiler errors"),
    ...Array.from({ length: 40 }, (_, i) => tool(`unity_mcp_tool_${i}`)),
    ...Array.from({ length: 20 }, (_, i) => tool(`gh_tool_${i}`)),
    ...Array.from({ length: 10 }, (_, i) => tool(`vault_tool_${i}`)),
  ];

  const serverOf = new Map();
  for (const t of tools) {
    const name = t.function.name;
    if (name.startsWith("unity_mcp")) serverOf.set(name, "unity");
    else if (name.startsWith("gh_")) serverOf.set(name, "github");
    else if (name.startsWith("vault_")) serverOf.set(name, "obsidian-live");
    // unity_symbol / unity_compile deliberately absent: they are local tools.
  }

  const kept = (prompt, budget = 28) =>
    selectRelevantTools(tools, prompt, serverOf, budget).tools.map((t) => t.function.name);

  const onError = kept(REAL_ERROR);
  if (onError.includes("unity_symbol")) {
    ok("unity_symbol survives the budget on a raw compiler error", `${onError.length} tools sent`);
  } else {
    bad("unity_symbol survives the budget on a raw compiler error", `${onError.length} tools, not among them`);
  }

  const onUnity = kept("add a glowing cyan grid to the scene in Unity");
  if (onUnity.includes("unity_symbol")) ok("and on an ordinary Unity question");
  else bad("and on an ordinary Unity question", onUnity.join(", "));

  // The other half of the bargain: it must NOT be sent on unrelated questions,
  // or it is just permanent prompt weight.
  const onVault = kept("summarise my obsidian vault notes from this week");
  if (!onVault.includes("unity_symbol")) ok("and is withheld from an unrelated question", "vault query");
  else bad("and is withheld from an unrelated question", "sent anyway");

  // unity_commands is the catalogue: 149 Editor commands against a budget of
  // 28 means most of them are never attached, and this is the only tool that
  // names the missing ones. Losing it to the budget is the failure that made
  // "create a cube" answerable only as "no such tool exists", so it is pinned
  // on a Unity question — and, like the rest, absent from an unrelated one.
  const catalogue = [tool("unity_commands", "List or search every Unity Editor command"), ...tools];
  const keptWith = (prompt, budget = 28) =>
    selectRelevantTools(catalogue, prompt, serverOf, budget).tools.map((t) => t.function.name);

  const onCube = keptWith("create a cube and save the scene");
  if (onCube.includes("unity_commands")) ok("unity_commands survives the budget on a Unity task");
  else bad("unity_commands survives the budget on a Unity task", `${onCube.length} tools, not among them`);

  const catalogueOnVault = keptWith("summarise my obsidian vault notes from this week");
  if (!catalogueOnVault.includes("unity_commands")) ok("and is withheld from an unrelated question");
  else bad("and is withheld from an unrelated question", "sent anyway");

  // Naming a path is asking about the filesystem. Measured failure: asked to
  // compile `/Users/…/Assets/Scripts/PlayerMovement.cs`, the prompt contained
  // none of the filesystem keywords — "Scripts" is not "script" — so all 14
  // filesystem tools were ranked out, and the model spent ten steps reading the
  // file with `cat` and trying to edit it with `sed` through the shell.
  //
  // The fixture is the machine's real shape at the time — 20 local tools and a
  // 14-tool filesystem server, over a budget of 28 — because that is what makes
  // the filesystem set the thing on the margin. `execute_shell_command` is in
  // it deliberately: it is never dropped, so it is always the fallback the
  // model reaches for when the right tool is missing.
  const fsTools = [
    tool("execute_shell_command", "Run a shell command"),
    tool("unity_compile", "Compile a Unity project and return compiler errors"),
    tool("unity_symbol", "Resolve a Unity/C# type name to its namespace"),
    ...Array.from({ length: 17 }, (_, i) => tool(`local_tool_${i}`)),
    ...["read_text_file", "edit_file", "list_directory"].map((n) => tool(n, "Work with files")),
    ...Array.from({ length: 11 }, (_, i) => tool(`fs_tool_${i}`, "Work with files")),
  ];

  const fsServerOf = new Map();
  for (const t of fsTools) {
    const name = t.function.name;
    if (name.startsWith("fs_tool_") || ["read_text_file", "edit_file", "list_directory"].includes(name)) {
      fsServerOf.set(name, "filesystem");
    }
  }

  const fsKept = (prompt) =>
    selectRelevantTools(fsTools, prompt, fsServerOf, 28).tools.map((t) => t.function.name);

  const onPath = fsKept(
    'unity_compile the Tron Game, im getting "Assets/Scripts/PlayerMovement.cs(59,25): ' +
      'error CS0019" at /Users/warrenwhite/TronGame/Assets/Scripts/PlayerMovement.cs'
  );
  if (onPath.includes("read_text_file") && onPath.includes("unity_compile")) {
    ok("a bare file path makes the filesystem tools relevant", `${onPath.length} tools sent`);
  } else {
    bad(
      "a bare file path makes the filesystem tools relevant",
      `read_text_file=${onPath.includes("read_text_file")} unity_compile=${onPath.includes("unity_compile")}`
    );
  }

  const noPath = fsKept("what is the weather like today");
  if (!noPath.includes("read_text_file")) ok("and a question naming no path still withholds them");
  else bad("and a question naming no path still withholds them", "sent anyway");
}

// ---------------------------------------------------------------------------
// 5b. The command catalogue
// ---------------------------------------------------------------------------
// Needs a running Editor, so it SKIPS without one. What it must never do is
// invent an answer: with no Editor the tool has to say so and tell the caller
// to stop, rather than returning an empty list that reads like "Unity can do
// nothing".
{
  const { localToolRegistry } = await import("../dist/core/tools.js");
  unity.registerUnityTools();
  const catalogue = localToolRegistry.tools.get("unity_commands");

  if (!catalogue) {
    bad("unity_commands is registered as a callable tool");
  } else {
    ok("unity_commands is registered as a callable tool");

    const all = await catalogue.handler({});
    if (all.error) {
      if (/actionRequired/.test(JSON.stringify(all)) && all.total === undefined) {
        ok("with no Editor answering, the empty catalogue is reported as an error");
      } else {
        bad("with no Editor answering, the empty catalogue is reported as an error");
      }
      skip("the catalogue's contents", "no Unity Editor is running");
    } else {
      if (all.total > 50) ok("the catalogue lists the Editor's commands", `${all.total} commands`);
      else bad("the catalogue lists the Editor's commands", `only ${all.total}`);

      const cube = await catalogue.handler({ query: "create a cube" });
      if (cube.commands?.[0]?.name === "create_gameobject") {
        ok("a plain-English task finds the command that does it", "create a cube -> create_gameobject");
      } else {
        bad("a plain-English task finds the command that does it", cube.commands?.[0]?.name ?? "no match");
      }

      // The filler word is the whole point of the length filter: "a" appears in
      // nearly every command name, so scoring it returns the full list.
      if (cube.matched < all.total / 2) ok("a filler word does not match everything", `${cube.matched} of ${all.total}`);
      else bad("a filler word does not match everything", `${cube.matched} of ${all.total}`);

      const exact = await catalogue.handler({ query: "create_gameobject" });
      if (exact.command?.parameters?.some((p) => p.name === "primitive")) {
        ok("an exact name returns the arguments needed to call it", `${exact.command.parameters.length} parameters`);
      } else {
        bad("an exact name returns the arguments needed to call it");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5c. The two modes, stated wherever one of them is missing
// ---------------------------------------------------------------------------
// The Editor's MCP tools live inside the Editor; unity_compile needs the Editor
// gone. Both facts are true at once and each surface only ever shows one of
// them, so "no Unity tools" reads as "Unity is broken" and "the Editor has this
// project open" reads as "the project cannot be compiled". Every surface that
// reports one half must state the other.
{
  const { unityModeTradeoff } = await import("../dist/core/mcpServers.js");
  const text = unityModeTradeoff();

  // Both directions, named, in one string — this is the sentence the user asked
  // to see stated explicitly rather than inferred.
  const states = [/Editor open →.*no unity_compile/, /Editor closed →.*unity_compile works.*0 Unity MCP tools/];
  if (states.every((re) => re.test(text))) ok("both modes are stated explicitly", text.split(".")[0] + ".");
  else bad("both modes are stated explicitly", text);

  const { localToolRegistry } = await import("../dist/core/tools.js");

  // The locked-project refusal is the one the Tron run hit. It must carry the
  // tradeoff AND a route that exists on this Editor, or it is a dead end.
  const compile = localToolRegistry.tools.get("unity_compile");
  const locked = path.join(sandbox, "LockedGame");
  fs.mkdirSync(path.join(locked, "ProjectSettings"), { recursive: true });
  fs.mkdirSync(path.join(locked, "Temp"), { recursive: true });
  fs.writeFileSync(path.join(locked, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.12f1\n");
  const lockfile = path.join(locked, "Temp", "UnityLockfile");
  fs.writeFileSync(lockfile, "");

  // HOLD the lockfile, do not merely create it.
  //
  // `lockedBy` stopped trusting the file's existence on purpose: Unity leaves
  // the lockfile behind when it crashes, so a 0-byte file nothing holds means
  // the opposite of locked. This fixture wrote exactly that file and then
  // asserted the locked branch, so once the staleness check landed the test
  // could no longer reach the branch it was written to cover — it failed with
  // `lock branch not reached`, and because npm test chains with &&, took the
  // four suites after it down with it.
  //
  // An open descriptor in THIS process is what makes lsof report a holder, which
  // is the evidence the real check looks for.
  const lockHandle = fs.openSync(lockfile, "r");

  // The consent gate runs before the lock check — correctly, batch mode writes
  // Library/ and Temp/ — so the sandbox project has to be granted or the branch
  // under test is never reached.
  const { saveConfig } = await import("../dist/core/config.js");
  saveConfig({ allowedPaths: [locked] });

  const refusal = await compile.handler({ projectPath: locked });
  fs.closeSync(lockHandle);

  // A real Editor running on THIS machine changes which branch the tool takes.
  //
  // With one live, `editorCompileRoute()` finds a route and unity_compile tries
  // to recompile through it rather than refusing — so it reports that attempt's
  // failure instead of the lock refusal this check is about. That is correct
  // behaviour and nothing to do with the property under test, so skip rather
  // than fail, the same way the catalogue check below already does.
  // Classify the outcome rather than pattern-match each one.
  //
  // This fixture cannot produce a genuinely locked project. It holds the
  // lockfile open from THIS node process, which is enough for lsof to report a
  // holder — but there is no Unity behind it, and the real code is smart enough
  // to notice. So which branch unity_compile takes depends on the machine:
  //
  //   live Editor elsewhere   → takes the compile route, reports that failure
  //   no Editor answering     → reports the contradiction ("locked, but no
  //                             Editor is answering — the two do not agree")
  //   genuinely locked Editor → the pure refusal this check is about
  //
  // Only the third lets the assertion run, and the user's actual Editor state
  // decides which we get. Chasing each phrasing with its own regex broke twice
  // in one day, so: if the lock was DETECTED but the wording is not the pure
  // refusal, the environment is wrong for this check — skip, naming what came
  // back. If the lock was not detected at all, that IS a defect.
  const message = String(refusal.message ?? "");
  const lockDetected = /\block(?:ed)?\b|has this project open/i.test(message);
  const pureRefusal = /Editor currently has this project open/.test(message);

  if (lockDetected && !pureRefusal) {
    const why = `lock seen, machine took another branch: "${message.slice(0, 80)}"`;
    skip("the locked-project refusal names the other mode", why);
    skip("and forbids reporting the project as uncompilable", why);
  } else if (!pureRefusal) {
    bad("the locked-project refusal names the other mode", `lock not detected at all: ${message}`);
  } else if (states.every((re) => re.test(String(refusal.modes)))) {
    ok("the locked-project refusal names the other mode");
    if (/Do NOT report that the project cannot be compiled/.test(refusal.actionRequired)) {
      ok("and forbids reporting the project as uncompilable");
    } else {
      bad("and forbids reporting the project as uncompilable", refusal.actionRequired);
    }
  } else {
    bad("the locked-project refusal names the other mode", String(refusal.modes));
  }

  // The mirror image: no Editor, so no catalogue. The tool must not let that
  // read as "Unity is unavailable" while unity_compile is sitting there working.
  const cat = await localToolRegistry.tools.get("unity_commands").handler({});
  if (!cat.error) {
    skip("the empty-catalogue error names the other mode", "an Editor is running");
  } else if (states.every((re) => re.test(String(cat.modes)))) {
    ok("the empty-catalogue error names the other mode");
  } else {
    bad("the empty-catalogue error names the other mode", String(cat.modes));
  }
}

// ---------------------------------------------------------------------------
// 5d. Package types, which is where the questions actually are
// ---------------------------------------------------------------------------
// The editor's XML docs cover the install, not packages — and a model asked to
// wire up a camera-look script spent ~2000 tokens of visible reasoning
// ("I'm not 100% sure", "I genuinely am not certain") guessing at Input System
// APIs, then settled on the type `InputActionsAsset` in namespace
// `Unity.InputSystem`. Neither exists: it is `InputActionAsset`, in
// `UnityEngine.InputSystem`, and it was in Library/PackageCache all along.
//
// Synthetic tree so this runs on a machine that has never had Unity on it.
{
  const root = path.join(sandbox, "PackagedGame");
  const pkg = path.join(root, "Library", "PackageCache", "com.unity.inputsystem@21a28c3a");
  fs.mkdirSync(path.join(pkg, "InputSystem", "Actions"), { recursive: true });
  fs.mkdirSync(path.join(root, "Assets", "Scripts"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "Tests~"), { recursive: true });

  fs.writeFileSync(
    path.join(pkg, "InputSystem", "Actions", "InputActionAsset.cs"),
    "using UnityEngine;\n\nnamespace UnityEngine.InputSystem\n{\n" +
      "    public class InputActionAsset : ScriptableObject { }\n" +
      "    internal class NotForYou { }\n}\n"
  );
  // A second namespace in one file: the type must bind to the one that opened
  // before it, not to the first in the file.
  fs.writeFileSync(
    path.join(pkg, "InputSystem", "PlayerInput.cs"),
    "namespace UnityEngine.InputSystem\n{\n    public sealed partial class PlayerInput { }\n}\n\n" +
      "namespace UnityEngine.InputSystem.Editor\n{\n    public class InputActionAssetEditor { }\n}\n"
  );
  // Excluded from compilation by Unity, so it must not be offered as an answer.
  fs.writeFileSync(
    path.join(pkg, "Tests~", "Fake.cs"),
    "namespace Should.Not.Appear\n{\n    public class GhostType { }\n}\n"
  );
  fs.writeFileSync(
    path.join(root, "Assets", "Scripts", "PlayerMovement.cs"),
    "using UnityEngine;\n\npublic class PlayerMovement : MonoBehaviour { }\n"
  );

  const index = unity.buildPackageIndex(root);

  const playerInput = index.get("PlayerInput")?.[0];
  if (playerInput?.namespace === "UnityEngine.InputSystem") {
    ok("a package type resolves to its namespace", `PlayerInput -> using ${playerInput.namespace};`);
  } else {
    bad("a package type resolves to its namespace", JSON.stringify(playerInput));
  }

  const editorType = index.get("InputActionAssetEditor")?.[0];
  if (editorType?.namespace === "UnityEngine.InputSystem.Editor") {
    ok("a second namespace in the same file binds correctly", editorType.namespace);
  } else {
    bad("a second namespace in the same file binds correctly", JSON.stringify(editorType));
  }

  // The exact hallucination, and the exact correction.
  if (!index.has("InputActionsAsset") && index.has("InputActionAsset")) {
    ok("the invented type is reported missing while the real one resolves", "InputActionsAsset -> InputActionAsset");
  } else {
    bad("the invented type is reported missing while the real one resolves");
  }

  if (!index.has("NotForYou")) ok("an internal type is not offered as an answer");
  else bad("an internal type is not offered as an answer");

  if (!index.has("GhostType")) ok("a Tests~ directory is excluded, as Unity excludes it");
  else bad("a Tests~ directory is excluded, as Unity excludes it");

  const own = index.get("PlayerMovement")?.[0];
  if (own && own.namespace === "") ok("the project's own scripts are indexed too", "global namespace");
  else bad("the project's own scripts are indexed too", JSON.stringify(own));

  // Without a projectPath nothing but the editor is searched, and saying so is
  // the difference between "look again properly" and "the API does not exist".
  const { localToolRegistry: reg } = await import("../dist/core/tools.js");
  unity.registerUnityTools();
  const symbol = reg.tools.get("unity_symbol");
  if (symbol) {
    const blind = await symbol.handler({ name: "PlayerInput" });
    if (blind.found) {
      skip("a projectless lookup says what it did not search", "resolved from the editor install");
    } else if (/projectPath/.test(String(blind.actionRequired))) {
      ok("a projectless lookup says what it did not search and asks for the project");
    } else {
      bad("a projectless lookup says what it did not search", String(blind.actionRequired));
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Reading an editor log back
// ---------------------------------------------------------------------------
{
  // Shaped like a real Unity log: the same diagnostic appears three times, and
  // warnings and unrelated chatter surround it.
  const log = [
    "Refreshing native plugins compatible for Editor in 1.23 ms",
    `${REAL_ERROR}`,
    "Assets/Scripts/StormSky.cs(88,12): warning CS0414: The field 'x' is assigned but never used",
    `${REAL_ERROR}`,
    "Compilation failed: 1 error(s), 1 warnings",
    "Assets/Scripts/Other.cs(4,9): error CS0246: The type or namespace name 'Foo' could not be found",
    `${REAL_ERROR}`,
  ].join("\n");

  const diagnostics = unity.parseCompilerDiagnostics(log);

  if (diagnostics.length === 2) ok("repeated diagnostics are collapsed", "3 printings + 1 other -> 2 errors");
  else bad("repeated diagnostics are collapsed", `${diagnostics.length} found`);

  const first = diagnostics[0];
  if (
    first?.file === "Assets/Scripts/StormSky.cs" &&
    first?.line === 71 &&
    first?.column === 37 &&
    first?.code === "CS0103"
  ) {
    ok("the file, line, column and code are parsed", `${first.file}:${first.line}:${first.column} ${first.code}`);
  } else {
    bad("the file, line, column and code are parsed", JSON.stringify(first));
  }

  if (!diagnostics.some((d) => d.code === "CS0414")) ok("warnings are not reported as errors");
  else bad("warnings are not reported as errors");

  if (unity.parseCompilerDiagnostics("Everything compiled fine.\n").length === 0) {
    ok("a clean log produces no errors");
  } else {
    bad("a clean log produces no errors");
  }
}

fs.rmSync(sandbox, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}

console.log(
  `\nPASS: a Unity compiler error is answered offline, kept out of the fan-out, and not ` +
    `chased through a search engine.${skipped > 0 ? ` (${skipped} skipped: no Unity install)` : ""}`
);

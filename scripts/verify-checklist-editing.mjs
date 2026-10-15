// The checklist has to be editable, and the Stop button has to be wired.
//
// Both were reported from a live run: the panel read "Nothing in progress"
// while the turn was on step 13, and there was no way to stop it short of
// /reset. The stop control existed as markup — `#stop-button`, display:none,
// no listener, and nothing anywhere that unhid it — which is worse than absent,
// because it looks like a feature.
//
// Usage: node scripts/verify-checklist-editing.mjs
// Requires: npm run build

import fs from "fs";

const tasks = await import("../dist/core/tasks.js");

let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  🟢 ${label}`);
    return;
  }
  console.log(`  🔴 ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
}

const before = tasks.listTasks();

try {
  console.log("\nAdding, editing and deleting one task:");

  tasks.clearTasks();
  tasks.setTasks([{ subject: "first" }, { subject: "second" }, { subject: "third" }]);

  const added = tasks.addTask("a step I typed myself");
  check("addTask returns the new task", added?.subject === "a step I typed myself", JSON.stringify(added));
  check("it lands at the end", tasks.listTasks().at(-1)?.subject === "a step I typed myself");
  check("it starts pending", added?.status === "pending");

  const edited = tasks.updateTask(added.id, { subject: "the step, rewritten" });
  check("updateTask rewrites the subject", edited?.subject === "the step, rewritten");
  check("the rewrite is visible in the list", tasks.listTasks().some((t) => t.subject === "the step, rewritten"));

  const activated = tasks.updateTask(added.id, { status: "active" });
  check("status can be set to active", activated?.status === "active");
  check("activating stamps startedAt", typeof activated?.startedAt === "number");

  // A task pushed back to pending has not started, and a stale startedAt makes
  // the elapsed figure in the panel lie.
  const reset = tasks.updateTask(added.id, { status: "pending" });
  check("pending clears startedAt", reset?.startedAt === undefined, JSON.stringify(reset));
  check("pending clears endedAt", reset?.endedAt === undefined);

  const done = tasks.updateTask(added.id, { status: "done" });
  check("done stamps endedAt", typeof done?.endedAt === "number");

  check("removeTask deletes it", tasks.removeTask(added.id) === true);
  check("it is gone from the list", !tasks.listTasks().some((t) => t.id === added.id));
  check("removing a second time reports failure", tasks.removeTask(added.id) === false);
  check("the other tasks survived", tasks.listTasks().length === 3);

  console.log("\nIds must not collide after a delete:");

  // setTasks numbers from 1, so `length + 1` would hand out an id that already
  // exists the moment anything in the middle is deleted.
  tasks.clearTasks();
  tasks.setTasks([{ subject: "one" }, { subject: "two" }, { subject: "three" }]);
  tasks.removeTask("2");
  const filled = tasks.addTask("filling the gap");
  check("the freed id is reused rather than duplicated", filled?.id === "2", `got ${filled?.id}`);

  const ids = tasks.listTasks().map((t) => t.id);
  check("every id is unique", new Set(ids).size === ids.length, ids.join(","));

  console.log("\nBad input is refused, not stored:");

  check("an empty subject is refused", tasks.addTask("   ") === null);
  check("an unknown id cannot be updated", tasks.updateTask("nope", { subject: "x" }) === null);
  check("an empty rewrite leaves the subject alone", tasks.updateTask("1", { subject: "  " })?.subject === "one");

  const long = "y".repeat(400);
  check("a long subject is truncated, not rejected", (tasks.addTask(long)?.subject.length ?? 0) <= 120);

  console.log("\nThe server exposes all three operations:");
  {
    const js = fs.readFileSync("./dist/core/server.js", "utf-8");
    check("POST /api/tasks", /app\.post\("\/api\/tasks"/.test(js));
    check("PATCH /api/tasks/:id", /app\.patch\("\/api\/tasks\/:id"/.test(js));
    check("DELETE /api/tasks/:id", /app\.delete\("\/api\/tasks\/:id"/.test(js));
    check("an unknown status is refused", /Unknown status/.test(js));
    // The panel mirrors server state, so every mutation must broadcast.
    check("task changes are broadcast to the browser", /taskEvents\.on\("changed"/.test(js));
  }

  console.log("\nThe Stop button is actually wired:");
  {
    const html = fs.readFileSync("./src/public/index.html", "utf-8");
    check("a stop control sits beside the status badge", /id="status-stop"/.test(html));
    check("it has a click listener", /getElementById\("status-stop"\)\.addEventListener\("click"/.test(html));
    check("it emits cancel-turn", /socket\.emit\("cancel-turn"\)/.test(html));
    // The bug this replaces: visibility driven by nothing at all.
    check("visibility follows the status text", /RESTING_STATUSES\.has\(text\)/.test(html));
    check(
      "resting states hide it",
      /RESTING_STATUSES = new Set\(\["Ready", "Error", "Stopped"\]\)/.test(html)
    );

    const server = fs.readFileSync("./dist/core/server.js", "utf-8");
    check("the server handles cancel-turn", /socket\.on\("cancel-turn"/.test(server));
  }

  console.log("\nThe checklist renders the live step:");
  {
    const js = fs.readFileSync("./src/public/js/checklist.js", "utf-8");
    check("it listens for turn-progress", /socket\.on\("turn-progress"/.test(js));
    check("the line clears when the answer arrives", /kind === "answer"/.test(js));
    // A stopped turn emits neither ai-response nor fix-complete, and leaving the
    // spinner up afterwards is how the panel starts lying.
    check("a stopped turn clears it too", /socket\.on\("turn-finished"/.test(js));
    check("an errored turn clears it too", /socket\.on\("assistant-error"/.test(js));
    check("the box cycles status on click", /NEXT_STATUS/.test(js));
    check("the text is click-to-edit", /editing = task\.id/.test(js));
    check("there is an add row", /\+ add a step/.test(js));
    check("mutations go through the API, not local state", /await mutate\(/.test(js));
  }
} finally {
  // Put back whatever was there, so running the tests does not wipe a live run's
  // checklist.
  tasks.clearTasks();
  if (before.length > 0) {
    tasks.setTasks(before.map((t) => ({ subject: t.subject, activeForm: t.activeForm })));
    for (const task of before) tasks.updateTask(task.id, { status: task.status });
  }
}

console.log(
  failures === 0
    ? "\n🟢 The checklist is editable, the live step shows, and Stop is connected.\n"
    : `\n🔴 ${failures} check(s) failed.\n`
);

process.exit(failures === 0 ? 0 : 1);

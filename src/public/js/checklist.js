// The work checklist, in the shape Claude Code uses in the terminal: one active
// line in bold, the rest as pending boxes, with elapsed time and tokens for the
// current turn.
//
// Two producers push into it (the model via plan_tasks/complete_task, and the
// /fix loop via its phases) but the browser only renders the tasks-updated event,
// so the two can never disagree here.
//
// It is also EDITABLE, which it was not. A display is the wrong thing to be
// looking at when a run is going somewhere you did not want: the case that
// prompted this was a turn spending eight steps polling a compile it could not
// reach, with one line in the panel — the truncated opening of the prompt — and
// no way to say "that step is wrong, do this instead". Click the box to cycle
// status, click the text to rewrite it, ✕ to drop it, and the row at the bottom
// to add one.
//
// And it shows the LIVE STEP. A model that never calls plan_tasks leaves the
// panel holding only the seeded line, which is why "Nothing in progress" was
// what you saw while the run was on step 13 — the panel was telling the truth
// about the task list and saying nothing about the work.

(function () {
  const host = document.getElementById("checklist-panel");
  const meta = document.getElementById("checklist-meta");

  let tasks = [];
  let turnStart = null;
  let turnTokens = 0;
  /** The most recent turn-progress line, or null between turns. */
  let liveStep = null;
  /** Id of the task currently being edited, so a re-render does not close it. */
  let editing = null;

  const MARK = { active: "▪", pending: "☐", done: "☑", failed: "✗" };
  // Clicking the box walks this cycle, which covers the two things you actually
  // want mid-run: marking something done the model forgot to close, and pushing
  // something back to pending so it gets picked up again.
  const NEXT_STATUS = { pending: "active", active: "done", done: "failed", failed: "pending" };

  async function mutate(url, options) {
    const { ok, body } = await safeJson(url, options);
    if (!ok) {
      meta.textContent = body?.error ?? "That change did not stick.";
      return false;
    }
    // The server broadcasts tasks-updated, so no local mutation here — one
    // source of truth, and the panel cannot drift from the list the model sees.
    return true;
  }

  function renderTaskLine(task) {
    const line = document.createElement("div");
    line.className = `task-line ${task.status}`;
    line.style.display = "flex";
    line.style.alignItems = "flex-start";
    line.style.gap = "4px";

    const box = document.createElement("span");
    box.className = "task-box";
    box.textContent = MARK[task.status] ?? "☐";
    box.style.cursor = "pointer";
    box.title = `${task.status} — click for ${NEXT_STATUS[task.status] ?? "pending"}`;
    box.addEventListener("click", () =>
      mutate(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: NEXT_STATUS[task.status] ?? "pending" }),
      })
    );
    line.appendChild(box);

    if (editing === task.id) {
      const input = document.createElement("input");
      input.type = "text";
      input.value = task.subject;
      input.style.cssText =
        "flex:1; font-size:12px; background:var(--surface-2,#222); color:inherit; border:1px solid var(--accent); border-radius:3px; padding:1px 4px;";

      const commit = async () => {
        const next = input.value.trim();
        editing = null;
        if (next && next !== task.subject) {
          await mutate(`/api/tasks/${encodeURIComponent(task.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subject: next, activeForm: next }),
          });
        }
        render();
      };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          editing = null;
          render();
        }
      });
      input.addEventListener("blur", commit);

      line.appendChild(input);
      // Focus after the node is in the document, or the caret goes nowhere.
      setTimeout(() => input.focus(), 0);
    } else {
      const text = document.createElement("span");
      // Present continuous while running, imperative otherwise — same convention
      // as the CLI's spinner line.
      text.textContent =
        task.status === "active" && task.activeForm ? `${task.activeForm}…` : task.subject;
      if (task.status === "done") text.style.textDecoration = "line-through";
      text.style.flex = "1";
      text.style.cursor = "text";
      text.title = "Click to rewrite this step";
      text.addEventListener("click", () => {
        editing = task.id;
        render();
      });
      line.appendChild(text);

      const remove = document.createElement("span");
      remove.textContent = "✕";
      remove.title = "Delete this step";
      remove.style.cssText = "cursor:pointer; color:var(--text-muted); font-size:10px; flex:none;";
      remove.addEventListener("click", () =>
        mutate(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" })
      );
      line.appendChild(remove);
    }

    return line;
  }

  function renderAddRow() {
    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:4px; margin-top:6px;";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "+ add a step";
    input.style.cssText =
      "flex:1; font-size:11px; background:transparent; color:inherit; border:1px dashed var(--text-muted); border-radius:3px; padding:2px 4px;";

    const submit = async () => {
      const subject = input.value.trim();
      if (!subject) return;
      input.value = "";
      await mutate("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, activeForm: subject }),
      });
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    row.appendChild(input);
    return row;
  }

  function render() {
    host.innerHTML = "";

    if (tasks.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--text-muted); font-size:11px;";
      empty.textContent = liveStep ? "No planned steps." : "Nothing in progress.";
      host.appendChild(empty);
    } else {
      for (const task of tasks) host.appendChild(renderTaskLine(task));
    }

    // The live step, below the list. Separate from the tasks because it is not
    // one: it is what the tool loop is doing this second, and it is what the
    // panel was missing entirely while a run was mid-flight.
    if (liveStep) {
      const live = document.createElement("div");
      live.style.cssText =
        "margin-top:6px; padding-top:5px; border-top:1px solid var(--text-muted); font-size:11px; display:flex; gap:4px; align-items:flex-start;";

      const spinner = document.createElement("span");
      spinner.textContent = liveStep.warn ? "⚠" : "⟳";
      spinner.style.flex = "none";
      live.appendChild(spinner);

      const label = document.createElement("span");
      label.textContent =
        (liveStep.step ? `step ${liveStep.step}: ` : "") + String(liveStep.text ?? "").slice(0, 120);
      label.style.color = liveStep.warn ? "var(--warn-text)" : "var(--text-secondary)";
      live.appendChild(label);

      host.appendChild(live);
    }

    host.appendChild(renderAddRow());
  }

  function renderMeta() {
    const done = tasks.filter((t) => t.status === "done").length;
    const parts = [];

    if (tasks.length > 0) parts.push(`${done}/${tasks.length} done`);
    if (turnStart) {
      const seconds = Math.round((Date.now() - turnStart) / 1000);
      parts.push(seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`);
    }
    if (turnTokens > 0) {
      parts.push(`↓ ${turnTokens >= 1000 ? `${(turnTokens / 1000).toFixed(1)}k` : turnTokens} tokens`);
    }

    meta.textContent = parts.join(" · ");
  }

  socket.on("tasks-updated", (updated) => {
    tasks = Array.isArray(updated) ? updated : [];
    render();
    renderMeta();
  });

  // The live step. `tool-done` carries the duration of the call that just
  // finished, which is worth a beat on screen; `answer` means the loop has
  // stopped calling tools, so the line goes.
  socket.on("turn-progress", (event) => {
    if (!event || typeof event !== "object") return;
    if (event.kind === "answer") {
      liveStep = null;
    } else {
      liveStep = { text: event.text, step: event.step, warn: event.warn };
    }
    render();
  });

  // Turn timing is measured in the browser: the elapsed number people care about
  // is wall-clock from pressing Enter, not server-side inference time.
  const originalEmit = socket.emit.bind(socket);
  socket.emit = function (event, ...args) {
    if (event === "send-message" || event === "send-pipeline" || event === "send-fix") {
      turnStart = Date.now();
      turnTokens = 0;
      renderMeta();
    }
    return originalEmit(event, ...args);
  };

  function endOfTurn(payload) {
    turnTokens = payload?.usage?.totalTokens ?? turnTokens;
    turnStart = null;
    liveStep = null;
    render();
    renderMeta();
  }

  socket.on("ai-response", endOfTurn);
  socket.on("fix-complete", () => endOfTurn());
  // A stopped or failed turn emits neither, and leaving the spinner running
  // afterwards is how the panel starts lying about what is happening.
  socket.on("turn-finished", () => endOfTurn());
  socket.on("assistant-error", () => endOfTurn());

  setInterval(() => {
    if (turnStart) renderMeta();
  }, 1000);

  function refresh() {
    return safeJson("/api/tasks").then(({ body }) => {
      tasks = body?.tasks ?? [];
      render();
      renderMeta();
    });
  }

  // Re-read on every connect, not just the first.
  //
  // The list is server-side state and this panel only mirrors it. A refresh, or
  // a dropped socket during a long turn, used to leave the panel showing whatever
  // it held when the page loaded — usually nothing — while the run carried on
  // without it. `connect` fires on the first connection and on every
  // reconnection, so one line covers both.
  socket.on("connect", refresh);
  refresh();
})();

// The composer's mode line and Stop button.
//
// Stop exists because Self-repair had one and the chat box did not: a long turn
// ran to completion no matter what you pressed. It aborts server-side, mid-step,
// via a per-socket AbortController — not just visually.
//
// The mode line mirrors Claude Code's: one label, shift+tab to cycle. It sits
// directly above the input because it changes what pressing Enter permits.

(function () {
  const modeButton = document.getElementById("mode-button");
  const modeDetail = document.getElementById("mode-detail");
  const stopButton = document.getElementById("stop-button");
  const sendButton = document.getElementById("send-button");
  const promptInput = document.getElementById("prompt-input");

  const LABELS = {
    auto: "auto mode on",
    manual: "manual mode",
    acceptEdits: "accept edits on",
    plan: "plan mode on",
  };
  const COLOURS = {
    auto: "var(--warn-bright)",
    manual: "var(--accent-light)",
    acceptEdits: "var(--danger-bright)",
    plan: "var(--violet)",
  };
  const DETAIL = {
    auto: "Tools run without asking. Read-only servers still refuse writes.",
    manual: "Every tool call waits for your approval.",
    acceptEdits: "Tools run without asking AND read-only guards are lifted for this session.",
    plan: "Mutating tools are withheld. The model produces a plan instead.",
  };

  let mode = "auto";
  let running = false;

  function render() {
    modeButton.textContent = `▶▶ ${LABELS[mode] ?? mode}`;
    modeButton.style.color = COLOURS[mode] ?? "var(--warn-bright)";
    modeDetail.textContent = DETAIL[mode] ?? "";
  }

  async function setMode(next) {
    const { ok, body } = await safeJson("/api/session/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });

    if (!ok) {
      appendSystem(`Could not switch mode: ${escapeHtml(body.error ?? "unknown error")}`);
      return;
    }

    mode = body.settings?.mode ?? next;
    render();

    // Accept-edits is the one mode that silently widens what a mistake can do,
    // so it announces itself rather than only changing a label.
    if (mode === "acceptEdits") {
      appendSystem(
        "<strong>Accept edits is on.</strong> Read-only guards are lifted for this session — " +
          "the model can write to your vault and granted directories without asking. " +
          "Press shift+tab to leave this mode."
      );
    }
  }

  async function cycle() {
    const { ok, body } = await safeJson("/api/session/mode/cycle", { method: "POST" });
    if (!ok) return;
    mode = body.settings?.mode ?? mode;
    render();
    if (mode === "acceptEdits") {
      appendSystem(
        "<strong>Accept edits is on.</strong> Read-only guards are lifted for this session."
      );
    }
  }

  modeButton.addEventListener("click", cycle);

  // shift+tab anywhere except inside a text field that wants the keystroke.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !event.shiftKey) return;
    const target = event.target;
    const typing = target === promptInput || target?.tagName === "TEXTAREA";
    if (typing || target === document.body || target === modeButton) {
      event.preventDefault();
      cycle();
    }
  });

  // ---- Stop ---------------------------------------------------------------

  function setRunning(value) {
    running = value;
    stopButton.style.display = value ? "" : "none";

    // Send stays available while a turn runs.
    //
    // It used to be swapped out for Stop, which made Stop the only way to say
    // anything to a run in progress — so steering a thirty-step turn that had
    // gone the wrong way meant destroying everything it had gathered. A message
    // sent now is queued and folded into the running turn at its next step
    // boundary (see pendingInjections in server.ts), so the two buttons mean
    // genuinely different things and both belong here.
    sendButton.style.display = "";
    sendButton.textContent = value ? "Add" : "Send";
    sendButton.title = value
      ? "Send this to the run in progress. It is picked up at the next step."
      : "";
    promptInput.placeholder = value
      ? "Add something to the run in progress…"
      : "Ask assistant, or type / to see commands…";
  }

  stopButton.addEventListener("click", () => {
    socket.emit("cancel-turn");
    stopButton.disabled = true;
    stopButton.textContent = "Stopping…";
    appendSystem("Stopping. The current step is abandoned; nothing further runs.");
  });

  // Esc stops too, but only while something is running — otherwise it is the
  // slash menu's key.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && running && document.getElementById("slash-menu").style.display === "none") {
      socket.emit("cancel-turn");
    }
  });

  socket.on("turn-started", (data) => {
    stopButton.disabled = false;
    stopButton.textContent = "■ Stop";
    setRunning(true);

    // `resumed` means this tab connected to a run that was already going — a
    // refresh mid-turn. Say so, because the transcript above is from before the
    // reload and the run's earlier output is not in it.
    if (data?.resumed && typeof appendSystem === "function") {
      appendSystem(
        `A ${data.kind ?? "chat"} run was already in progress when this tab loaded, and is ` +
        `still going. Output from before the reload is not shown above. ` +
        `<strong>Add</strong> sends a message into it; <strong>Stop</strong> ends it.`
      );
    }
  });
  socket.on("turn-finished", () => setRunning(false));
  // An auto-continue run emits one ai-response per round and keeps working, so
  // the Stop button has to survive the intermediate answers — it is the only way
  // out of the loop. `turn-finished` still ends the run either way.
  socket.on("ai-response", (data) => {
    if (!data?.continuing) setRunning(false);
  });
  socket.on("assistant-error", () => setRunning(false));

  // ---- manual-mode approvals ---------------------------------------------
  //
  // The server pauses before dispatch and waits for this answer, so the prompt
  // must be impossible to miss and must always send something back.
  socket.on("tool-approval-request", ({ id, name, args }) => {
    const detail = JSON.stringify(args ?? {}, null, 2);
    const wrap = document.createElement("div");
    wrap.className = "message warn-msg";
    wrap.innerHTML =
      `<strong>Approve tool call?</strong><br><code>${escapeHtml(name)}</code>` +
      `<pre style="max-height:160px; overflow:auto;">${escapeHtml(detail.slice(0, 1200))}</pre>`;

    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:8px; margin-top:6px;";

    const answer = (approved) => {
      socket.emit("tool-approval-response", { id, approved });
      row.remove();
      const verdict = document.createElement("div");
      verdict.style.cssText = `font-size:11px; margin-top:4px; color:${approved ? "var(--ok-text)" : "var(--danger-light)"};`;
      verdict.textContent = approved ? "Approved." : "Denied — the model was told to try another way.";
      wrap.appendChild(verdict);
    };

    const yes = document.createElement("button");
    yes.textContent = "Approve";
    yes.style.cssText = "padding:5px 12px; font-size:11px;";
    yes.addEventListener("click", () => answer(true));

    const no = document.createElement("button");
    no.className = "secondary";
    no.textContent = "Deny";
    no.style.cssText = "padding:5px 12px; font-size:11px;";
    no.addEventListener("click", () => answer(false));

    row.append(yes, no);
    wrap.appendChild(row);

    document.getElementById("chat-box").appendChild(wrap);
    document.getElementById("chat-box").scrollTop = document.getElementById("chat-box").scrollHeight;
  });

  safeJson("/api/session/settings").then(({ body }) => {
    mode = body.settings?.mode ?? "auto";
    render();
  });

  window.agentMode = () => mode;
  window.setAgentMode = setMode;
})();

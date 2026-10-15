// The Activity log: everything the assistant does, in one list.
//
// Replaces "Executed Tool Calls", which showed only tool calls — so builds,
// applied edits, /fix phases, parallel workers, MCP servers connecting and
// dropping, and stopped turns were all invisible unless you were watching the
// terminal that launched the process.
//
// Rendering is driven by the server's `activity` stream, and a reload replays the
// buffer from /api/activity, so the panel is never out of step with what happened.

(function () {
  const panel = document.getElementById("activity-panel");
  if (!panel) return;

  const ICON = {
    tool: "🔧",
    thinking: "💭",
    command: "▶",
    edit: "✎",
    fix: "🩹",
    worker: "⚙",
    server: "🔌",
    session: "💬",
    turn: "◆",
  };
  const COLOUR = { running: "var(--text-muted)", ok: "var(--text-secondary)", warn: "var(--warn-text)", fail: "var(--danger-light)" };

  let filter = "all";
  let entries = [];

  function time(at) {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function render() {
    const visible = entries.filter((entry) => filter === "all" || entry.kind === filter);

    if (visible.length === 0) {
      // "Nothing of that kind yet" is actively misleading for Thinking: the
      // common reason it is empty is that /effort low and medium switch thinking
      // off entirely, so the user is waiting for something that will never come.
      const empty =
        filter === "thinking"
          ? 'No reasoning captured yet. Only <code>/effort high</code> asks the model to think, ' +
            "and parallel workers never do."
          : entries.length === 0
            ? "Nothing yet."
            : "Nothing of that kind yet.";

      panel.innerHTML = `<span style="color:var(--text-faint);">${empty}</span>`;
      return;
    }

    panel.innerHTML = "";

    // Newest last, like a terminal, and the panel stays pinned to the bottom.
    for (const entry of visible.slice(-120)) {
      const row = document.createElement("div");
      row.style.cssText = "padding:3px 0; border-bottom:1px solid var(--border-subtle);";

      const head = document.createElement("div");
      head.style.cssText = `display:flex; gap:6px; align-items:baseline; color:${COLOUR[entry.status] ?? "var(--text-secondary)"};`;
      head.innerHTML =
        `<span style="flex:none;">${ICON[entry.kind] ?? "·"}</span>` +
        `<span style="flex:1; min-width:0; word-break:break-word;"><strong>${escapeHtml(entry.label)}</strong>` +
        (entry.summary ? ` <span style="color:var(--text-muted);">${escapeHtml(entry.summary)}</span>` : "") +
        `</span>` +
        `<span style="flex:none; font-size:9px; color:var(--surface-3);">${time(entry.at)}</span>`;
      row.appendChild(head);

      // Detail is opt-in: a build log or tool result would swamp the list.
      if (entry.detail) {
        const toggle = document.createElement("button");
        toggle.className = "secondary";
        toggle.textContent = "detail";
        toggle.style.cssText =
          "background:transparent; border:none; color:var(--accent); font-size:9px; padding:1px 0 0 20px; cursor:pointer;";

        // `white-space` matters more here than it looks. A bare <pre> defaults
        // to `pre` — no wrapping — so a 4,000-character tool result became one
        // enormous line scrolling sideways in a narrow column. `pre-wrap` keeps
        // the newlines that make JSON readable while letting long lines fold,
        // and `anywhere` handles unbroken strings (paths, URLs, base64) that
        // have no space to fold at.
        const body = document.createElement("pre");
        body.style.cssText =
          "display:none; margin:4px 0 4px 20px; font-size:10px; line-height:1.45; " +
          "max-height:260px; overflow-y:auto; overflow-x:hidden; " +
          "white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word;";
        body.textContent = entry.detail;

        toggle.addEventListener("click", () => {
          const open = body.style.display !== "none";
          body.style.display = open ? "none" : "block";
          toggle.textContent = open ? "detail" : "hide";
        });

        row.append(toggle, body);
      }

      panel.appendChild(row);
    }

    panel.scrollTop = panel.scrollHeight;
  }

  socket.on("activity", (entry) => {
    entries.push(entry);
    if (entries.length > 400) entries = entries.slice(-400);
    render();
  });

  document.querySelectorAll("[data-akind]").forEach((chip) => {
    chip.addEventListener("click", () => {
      filter = chip.dataset.akind;
      document.querySelectorAll("[data-akind]").forEach((c) => c.classList.toggle("active", c === chip));
      render();
    });
  });

  document.getElementById("activity-clear")?.addEventListener("click", async () => {
    await safeJson("/api/activity", { method: "DELETE" });
    entries = [];
    render();
  });

  safeJson("/api/activity").then(({ body }) => {
    entries = body.entries ?? [];
    render();
  });
})();

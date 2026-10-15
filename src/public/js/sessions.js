// Chat history in the sidebar.
//
// Switching a chat rehydrates the server-side message array and repaints the
// transcript from the stored messages, so continuing an old conversation actually
// continues it rather than starting a fresh one that looks the same.

(function () {
  const listHost = document.getElementById("session-list");

  function when(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  async function refresh() {
    const { body } = await safeJson("/api/sessions");
    const sessions = body.sessions ?? [];
    listHost.innerHTML = "";

    if (sessions.length === 0) {
      listHost.innerHTML = `<div style="color:var(--text-muted); font-size:11px;">No chats yet.</div>`;
      return;
    }

    for (const session of sessions) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex; align-items:center; gap:6px; padding:5px 7px; border-radius:4px; margin-bottom:3px;" +
        (session.active ? "background:var(--surface-0); border-left:3px solid var(--accent);" : "");

      const title = document.createElement("button");
      title.className = "secondary";
      title.style.cssText =
        "flex:1; min-width:0; text-align:left; background:transparent; border:none; padding:0;" +
        "font-size:11px; font-weight:" + (session.active ? "bold" : "normal") + ";" +
        "color:var(--text-bright); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
      title.textContent = session.title;
      title.title = `${session.messages} message(s) · ${when(session.updatedAt)}`;
      title.addEventListener("click", () => activate(session.id));
      row.appendChild(title);

      const stamp = document.createElement("span");
      stamp.style.cssText = "font-size:9px; color:var(--text-faint); flex:none;";
      stamp.textContent = when(session.updatedAt);
      row.appendChild(stamp);

      const rename = document.createElement("button");
      rename.className = "secondary";
      rename.textContent = "✎";
      rename.title = "Rename";
      rename.style.cssText = "padding:1px 5px; font-size:10px; flex:none; background:transparent;";
      rename.addEventListener("click", async (event) => {
        event.stopPropagation();
        const title = prompt("Rename this chat:", session.title);
        if (!title) return;
        await safeJson(`/api/sessions/${session.id}/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        refresh();
      });
      row.appendChild(rename);

      const remove = document.createElement("button");
      remove.className = "secondary";
      remove.textContent = "🗑";
      remove.title = "Delete";
      remove.style.cssText = "padding:1px 5px; font-size:10px; flex:none; background:transparent;";
      remove.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!confirm(`Delete "${session.title}"? This cannot be undone.`)) return;
        await safeJson(`/api/sessions/${session.id}`, { method: "DELETE" });
        refresh();
      });
      row.appendChild(remove);

      listHost.appendChild(row);
    }
  }

  /** Repaint the transcript from a session's stored messages. */
  function paint(messages) {
    const chatBox = document.getElementById("chat-box");
    chatBox.innerHTML = "";

    for (const message of messages ?? []) {
      const content = typeof message.content === "string" ? message.content : "";
      if (!content.trim()) continue;
      if (message.role === "user") appendPlain("You", content, "user-msg");
      else appendMessage("Assistant", renderContent(content), "ai-msg");
    }

    if (!messages || messages.length === 0) {
      appendSystem("New chat. Ask anything, or type <code>/</code> for commands.");
    }
  }

  async function activate(id) {
    const { ok, body } = await safeJson(`/api/sessions/${id}/activate`, { method: "POST" });
    if (!ok) {
      appendSystem(`Could not open that chat: ${escapeHtml(body.error ?? "unknown error")}`);
      return;
    }
    paint(body.messages);
    refresh();
  }

  document.getElementById("session-new").addEventListener("click", async () => {
    await safeJson("/api/sessions", { method: "POST" });
    paint([]);
    refresh();
  });

  window.refreshSessions = refresh;
  refresh();
})();

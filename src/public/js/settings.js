// Settings overlay: tab rail, and the Connections table.
//
// Loaded as a plain script after the inline dashboard script, so it shares the
// same globals (socket, safeJson, escapeHtml, appendSystem). That is deliberate:
// the existing renderers for MCP servers, tokens and granted directories keep
// working unchanged, because this only moved their containers into the overlay.
//
// Connections is generated from /api/connections, which is generated from
// core/connectors.ts. Adding a connector server-side makes a row appear here with
// a working form — there is nothing to add in this file.

(function () {
  const overlay = document.getElementById("settings-overlay");
  const formHost = document.getElementById("connection-form");

  let connectors = [];
  let filter = "all";
  let openConnectorId = null;

  // ---- overlay plumbing ----------------------------------------------------

  function openSettings(tab) {
    overlay.classList.add("open");
    if (tab) selectTab(tab);
    refreshConnections();
    // These live in the overlay now, so refresh on open rather than on a timer.
    if (window.fetchMcpServers) window.fetchMcpServers();
    if (window.fetchAllowedPaths) window.fetchAllowedPaths();
    if (window.refreshVaultSettings) window.refreshVaultSettings();
    if (window.refreshPerformanceSettings) window.refreshPerformanceSettings();
    renderAbout();
  }

  function closeSettings() {
    overlay.classList.remove("open");
  }

  function selectTab(name) {
    document.querySelectorAll(".settings-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === name);
    });
    document.querySelectorAll(".settings-pane").forEach((pane) => {
      pane.style.display = pane.dataset.pane === name ? "" : "none";
    });
  }

  document.getElementById("settings-open").addEventListener("click", () => openSettings());
  document.getElementById("settings-close").addEventListener("click", closeSettings);
  overlay.addEventListener("click", (event) => {
    // Click-through on the backdrop only, never inside the window.
    if (event.target === overlay) closeSettings();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay.classList.contains("open")) closeSettings();
  });
  document.querySelectorAll(".settings-tab").forEach((button) => {
    button.addEventListener("click", () => {
      selectTab(button.dataset.tab);
      // Performance shows live measurements of the current session, so they go
      // stale as soon as a turn runs. Re-measure on entry rather than on open.
      if (button.dataset.tab === "performance" && window.refreshPerformanceSettings) {
        window.refreshPerformanceSettings();
      }
    });
  });
  // The MCP Servers pane points at Connections for anything credential-shaped.
  document.querySelectorAll("[data-goto-connections]").forEach((button) => {
    button.addEventListener("click", () => selectTab("connections"));
  });
  document.querySelectorAll(".chip[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      filter = chip.dataset.filter;
      document.querySelectorAll(".chip[data-filter]").forEach((c) => c.classList.toggle("active", c === chip));
      renderConnections();
    });
  });

  // ---- connections ---------------------------------------------------------

  const STATE_STYLE = {
    connected: { colour: "var(--ok)", label: "Connected" },
    configured: { colour: "var(--accent)", label: "Configured" },
    unavailable: { colour: "var(--warn)", label: "Needs attention" },
    "not-configured": { colour: "var(--surface-3)", label: "Not connected" },
  };

  async function refreshConnections() {
    const { body } = await safeJson("/api/connections");
    connectors = body.connectors ?? [];
    renderConnections();
  }

  function renderConnections() {
    const body = document.getElementById("connections-body");
    body.innerHTML = "";

    const rows = connectors.filter((connector) => {
      if (filter === "connected") return connector.state === "connected";
      if (filter === "not-connected") return connector.state !== "connected";
      return true;
    });

    if (rows.length === 0) {
      body.innerHTML = `<tr><td colspan="3" style="color:var(--text-muted);">Nothing matches this filter.</td></tr>`;
      return;
    }

    for (const connector of rows) {
      const style = STATE_STYLE[connector.state] ?? STATE_STYLE["not-configured"];
      const tr = document.createElement("tr");

      const name = document.createElement("td");
      name.innerHTML =
        `<div style="font-weight:bold;">${escapeHtml(connector.name)}</div>` +
        `<div style="font-size:11px; color:var(--text-muted);">${escapeHtml(connector.detail)}</div>`;

      const type = document.createElement("td");
      type.style.color = "var(--text-muted)";
      type.textContent = connector.type;

      const status = document.createElement("td");
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex; align-items:center; gap:10px;";

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = style.colour;
      wrap.appendChild(dot);

      const label = document.createElement("span");
      label.style.cssText = "font-size:11px; color:var(--text-secondary); min-width:96px;";
      label.textContent = style.label;
      wrap.appendChild(label);

      if (connector.fields.length > 0) {
        const connect = document.createElement("button");
        connect.textContent = connector.state === "connected" ? "Edit" : "Connect";
        connect.style.cssText = "padding:4px 12px; font-size:11px;";
        connect.addEventListener("click", () => openForm(connector.id));
        wrap.appendChild(connect);
      } else {
        const manage = document.createElement("button");
        manage.className = "secondary";
        manage.textContent = connector.id === "filesystem" ? "Manage" : "Details";
        manage.style.cssText = "padding:4px 12px; font-size:11px;";
        manage.addEventListener("click", () =>
          selectTab(connector.id === "filesystem" ? "directories" : "servers")
        );
        wrap.appendChild(manage);
      }

      // Servers the user added are theirs to delete, from the same table.
      if (connector.custom && connector.server) {
        const remove = document.createElement("button");
        remove.className = "secondary";
        remove.textContent = "Remove";
        remove.style.cssText = "padding:4px 10px; font-size:11px;";
        remove.addEventListener("click", async () => {
          if (!confirm(`Remove "${connector.name}"? Its tools stop being available.`)) return;
          const { body } = await safeJson(`/api/mcp/custom/${encodeURIComponent(connector.server)}`, {
            method: "DELETE",
          });
          appendSystem(escapeHtml(body.message ?? "Removed."));
          connectors = body.connectors ?? connectors;
          renderConnections();
          if (window.fetchMcpServers) window.fetchMcpServers();
        });
        wrap.appendChild(remove);
      }

      status.appendChild(wrap);
      tr.append(name, type, status);
      body.appendChild(tr);
    }

    if (openConnectorId) openForm(openConnectorId);
  }

  /**
   * The block under a credential input: where the value is kept, the command
   * that reads it back, and a Remove button when this app owns the copy.
   *
   * Tone matters here. Before the token is entered it is a promise about the
   * destination; after, it is a receipt. Both are the same three facts, so they
   * are the same widget rather than two that can disagree.
   */
  function storageNotice(connector, field) {
    const storage = field.storage ?? {};
    const box = document.createElement("div");
    box.style.cssText =
      `margin-top:6px; padding:7px 9px; border-radius:5px; font-size:10px; line-height:1.6;` +
      `background:${storage.encrypted ? "var(--ok-bg)" : "var(--stone-900)"};` +
      `border:1px solid ${storage.encrypted ? "var(--ok-border)" : "var(--stone-700)"};` +
      `color:${storage.encrypted ? "var(--ok-text)" : "var(--warn-soft)"};`;

    const headline = document.createElement("div");
    headline.innerHTML =
      `${storage.encrypted ? "🔐" : "⚠️"} <strong>${
        field.present ? "Stored in" : "Will be stored in"
      }:</strong> ${escapeHtml(storage.label ?? "unknown")}`;
    box.appendChild(headline);

    const detail = document.createElement("div");
    detail.style.cssText = "color:var(--text-muted); margin-top:3px;";
    detail.textContent = storage.encrypted
      ? "Encrypted at rest by macOS and unlocked with your login keychain. It is never written to ~/.cullus/config.json and never sent back to this page."
      : "Not encrypted at rest. It is still kept out of config.json, but a Mac with the Keychain available is the better home for it.";
    box.appendChild(detail);

    if (storage.command) {
      const command = document.createElement("code");
      command.style.cssText =
        "display:block; margin-top:5px; padding:5px 7px; background:var(--surface-0); border-radius:4px; color:var(--text-secondary); font-size:10px; overflow-x:auto; white-space:nowrap;";
      command.textContent = storage.command;
      command.title = "Click to copy";
      command.style.cursor = "pointer";
      command.addEventListener("click", () => {
        navigator.clipboard?.writeText(storage.command);
        const was = command.textContent;
        command.textContent = "copied";
        setTimeout(() => { command.textContent = was; }, 900);
      });
      box.appendChild(command);
    }

    if (field.removable) {
      const remove = document.createElement("button");
      remove.textContent = "Remove this credential";
      remove.style.cssText =
        "margin-top:7px; background:var(--danger); border:none; color:white; border-radius:3px; padding:3px 9px; cursor:pointer; font-size:10px;";
      remove.addEventListener("click", async () => {
        if (!confirm(`Remove the ${field.label} for ${connector.name}?`)) return;
        const { ok, body } = await safeJson(
          `/api/connections/${encodeURIComponent(connector.id)}/secrets/${encodeURIComponent(field.key)}`,
          { method: "DELETE" }
        );
        appendSystem(escapeHtml(body.message ?? (ok ? "Removed." : "Could not remove it.")));
        if (body.connectors) connectors = body.connectors;
        renderConnections();
        if (window.fetchMcpServers) window.fetchMcpServers();
      });
      box.appendChild(remove);
    }

    return box;
  }

  function openForm(id) {
    const connector = connectors.find((c) => c.id === id);
    if (!connector) return;

    openConnectorId = id;
    formHost.innerHTML = "";

    const card = document.createElement("div");
    card.style.cssText =
      "background:var(--surface-1); border:1px solid var(--surface-2); border-radius:8px; padding:16px;";

    const head = document.createElement("div");
    head.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;";
    head.innerHTML = `<strong style="font-size:14px;">Connect ${escapeHtml(connector.name)}</strong>`;

    const close = document.createElement("button");
    close.className = "secondary";
    close.textContent = "✕";
    close.style.cssText = "padding:2px 8px; font-size:11px;";
    close.addEventListener("click", () => {
      openConnectorId = null;
      formHost.innerHTML = "";
    });
    head.appendChild(close);
    card.appendChild(head);

    if (connector.where) {
      const where = document.createElement("div");
      where.style.cssText = "font-size:11px; color:var(--text-muted); margin-bottom:12px;";
      where.textContent = connector.where;
      card.appendChild(where);
    }

    const inputs = new Map();

    for (const field of connector.fields) {
      const row = document.createElement("div");
      row.style.cssText = "margin-bottom:12px;";

      const label = document.createElement("div");
      label.style.cssText = "font-size:11px; color:var(--text-secondary); margin-bottom:4px; display:flex; gap:8px; align-items:center;";
      label.innerHTML = `<span>${escapeHtml(field.label)}</span>`;

      if (field.secret && field.present) {
        const badge = document.createElement("span");
        badge.style.cssText =
          "background:var(--ok); color:var(--surface-0); font-size:9px; font-weight:bold; padding:1px 6px; border-radius:8px;";
        badge.textContent = `stored ${field.preview ?? ""} (${field.source})`;
        label.appendChild(badge);
      }
      row.appendChild(label);

      const input = document.createElement("input");
      input.type = field.secret ? "password" : "text";
      input.autocomplete = field.secret ? "off" : "on";
      input.spellcheck = !field.secret;
      input.style.cssText = "width:100%; font-size:12px; padding:8px;";
      input.placeholder = field.secret
        ? field.present
          ? "leave blank to keep the stored token"
          : "paste token"
        : field.placeholder ?? "";
      // Never prefill a secret: the value is write-only across this boundary.
      if (!field.secret) input.value = field.value ?? "";
      row.appendChild(input);
      inputs.set(field.key, input);

      // Say where the value goes before it is typed, and prove it afterwards:
      // the reader gets the keychain service, the account name and the exact
      // command that reads it back, so "stored securely" is checkable.
      if (field.secret && field.storage) {
        row.appendChild(storageNotice(connector, field));
      }

      if (field.help) {
        const help = document.createElement("div");
        help.style.cssText = "font-size:10px; color:var(--text-faint); margin-top:3px;";
        help.textContent = field.help;
        row.appendChild(help);
      }

      card.appendChild(row);
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex; gap:8px; align-items:center;";

    const save = document.createElement("button");
    save.textContent = "Save and connect";
    save.style.cssText = "padding:8px 14px; font-size:12px;";
    actions.appendChild(save);

    const result = document.createElement("span");
    result.style.cssText = "font-size:11px; color:var(--text-muted);";
    actions.appendChild(result);

    save.addEventListener("click", async () => {
      const values = {};
      for (const [key, input] of inputs.entries()) values[key] = input.value;

      save.disabled = true;
      result.textContent = "Saving…";

      const { ok, body } = await safeJson(`/api/connections/${connector.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });

      save.disabled = false;
      result.style.color = ok && body.ok ? "var(--ok)" : "var(--danger-light)";
      result.textContent = body.message ?? (ok ? "Saved." : "Failed.");

      if (ok && body.ok) {
        connectors = body.connectors ?? connectors;
        renderConnections();
        if (window.fetchMcpServers) window.fetchMcpServers();
        appendSystem(escapeHtml(body.message));
      }
    });

    card.appendChild(actions);
    formHost.appendChild(card);
  }

  async function renderAbout() {
    const host = document.getElementById("about-body");
    const [{ body: config }, { body: health }] = await Promise.all([
      safeJson("/api/config"),
      safeJson("/api/health"),
    ]);

    host.innerHTML =
      `<strong>Ollama</strong>: ${health.ollama?.running ? "running" : "unreachable"} at ` +
      `<code>${escapeHtml(health.ollama?.url ?? "?")}</code><br>` +
      `<strong>Models</strong>: ${(health.ollama?.models ?? []).length}<br>` +
      `<strong>Active model</strong>: <code>${escapeHtml(config.defaultModel ?? "none")}</code><br>` +
      `<strong>Vault</strong>: ${config.vaultPath ? `<code>${escapeHtml(config.vaultPath)}</code>` : "not set"}<br>` +
      `<strong>Port</strong>: ${config.port}<br><br>` +
      `Run <code>/doctor</code> for a full health report, or <code>/fix &lt;symptom&gt;</code> to repair a project.`;
  }

  // Exposed so the inline script and other modules can refresh or open settings.
  window.refreshConnections = refreshConnections;
  window.openSettings = openSettings;

  refreshConnections();
})();

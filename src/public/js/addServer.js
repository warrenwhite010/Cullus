// "+ Add" on the Connections and MCP Servers panes.
//
// Three ways in, because there are three ways people actually have a server in
// hand: a form for one you know the command for, a paste box for the
// {"mcpServers": {…}} blob every MCP README ships, and an import list for
// anything the Claude CLI is already running on this machine. All three go
// through the same server-side validator, so the failure messages are identical.

(function () {
  const host = document.getElementById("add-server-host");
  if (!host) return;

  let tab = "manual";
  let discovered = [];

  function field(label, id, placeholder, help) {
    return (
      `<div style="margin-bottom:10px;">` +
      `<div style="font-size:11px; color:var(--text-secondary); margin-bottom:3px;">${label}</div>` +
      `<input id="${id}" placeholder="${placeholder ?? ""}" style="width:100%; font-size:12px; padding:7px;" />` +
      (help ? `<div style="font-size:10px; color:var(--text-faint); margin-top:2px;">${help}</div>` : "") +
      `</div>`
    );
  }

  function render() {
    host.innerHTML =
      `<div style="background:var(--surface-1); border:1px solid var(--surface-2); border-radius:8px; padding:14px;">` +
      `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">` +
      `<strong style="font-size:13px;">Add an MCP server</strong>` +
      `<button id="add-close" class="secondary" style="padding:2px 8px; font-size:11px;">✕</button>` +
      `</div>` +
      `<div class="chip-row" style="margin:0 0 12px;">` +
      ["manual", "json", "import"]
        .map(
          (name) =>
            `<button class="chip${tab === name ? " active" : ""}" data-addtab="${name}">` +
            `${name === "manual" ? "Manual" : name === "json" ? "Paste JSON" : "Import from Claude CLI"}</button>`
        )
        .join("") +
      `</div><div id="add-body"></div>` +
      `<div id="add-result" style="font-size:11px; margin-top:10px; color:var(--text-muted);"></div>` +
      `</div>`;

    document.getElementById("add-close").addEventListener("click", () => {
      host.innerHTML = "";
    });
    host.querySelectorAll("[data-addtab]").forEach((chip) => {
      chip.addEventListener("click", () => {
        tab = chip.dataset.addtab;
        render();
      });
    });

    const body = document.getElementById("add-body");

    if (tab === "manual") {
      body.innerHTML =
        field("Name", "add-name", "sqlite", "Lowercase, digits, dash or underscore. Must not clash with a built-in.") +
        `<div style="margin-bottom:10px;">` +
        `<div style="font-size:11px; color:var(--text-secondary); margin-bottom:3px;">Transport</div>` +
        `<select id="add-transport" style="width:100%; font-size:12px; padding:7px;">` +
        `<option value="stdio">stdio — a local command</option>` +
        `<option value="http">http — a URL</option></select></div>` +
        `<div id="add-stdio">` +
        field("Command", "add-command", "npx", "The executable. Arguments go below.") +
        field("Arguments", "add-args", "-y mcp-server-sqlite --db ./data.db", "Space separated.") +
        field("Environment", "add-env", "KEY=value KEY2=value2", "Space separated pairs. Anything named like a credential (TOKEN, KEY, SECRET, PASSWORD…) is moved to your Keychain on save and never written to config.json.") +
        `</div>` +
        `<div id="add-http" style="display:none;">` +
        field("URL", "add-url", "https://example.com/mcp") +
        field("Bearer token (optional)", "add-token", "paste token", "Stored in the Keychain as MCP_&lt;NAME&gt;_TOKEN, never in config.") +
        `<label style="display:flex; gap:6px; align-items:center; font-size:11px; margin-bottom:10px;">` +
        `<input type="checkbox" id="add-selfsigned" style="width:auto; flex:none;">` +
        `<span>Accept a self-signed certificate (localhost only)</span></label>` +
        `</div>` +
        `<label style="display:flex; gap:6px; align-items:center; font-size:11px; margin-bottom:12px;">` +
        `<input type="checkbox" id="add-readonly" checked style="width:auto; flex:none;">` +
        `<span>Start read-only (withhold its mutating tools)</span></label>` +
        `<button id="add-save" style="padding:8px 14px; font-size:12px;">Add and connect</button>`;

      const transport = document.getElementById("add-transport");
      transport.addEventListener("change", () => {
        document.getElementById("add-stdio").style.display = transport.value === "stdio" ? "" : "none";
        document.getElementById("add-http").style.display = transport.value === "http" ? "" : "none";
      });

      document.getElementById("add-save").addEventListener("click", saveManual);
      return;
    }

    if (tab === "json") {
      body.innerHTML =
        `<div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">` +
        `Paste the block from a server's README. Both shapes work: a full ` +
        `<code>{"mcpServers": {…}}</code> object, or one server on its own.</div>` +
        `<textarea id="add-json" rows="10" style="width:100%; font-size:11px; font-family:ui-monospace, Menlo, monospace; padding:8px;" ` +
        `placeholder='{\n  "mcpServers": {\n    "sqlite": {\n      "command": "npx",\n      "args": ["-y", "mcp-server-sqlite", "--db", "./data.db"]\n    }\n  }\n}'></textarea>` +
        `<button id="add-json-save" style="padding:8px 14px; font-size:12px; margin-top:10px;">Add and connect</button>`;

      document.getElementById("add-json-save").addEventListener("click", saveJson);
      return;
    }

    body.innerHTML = `<div style="font-size:11px; color:var(--text-muted);">Loading…</div>`;
    safeJson("/api/mcp/discover").then(({ body: data }) => {
      discovered = data.servers ?? [];

      if (discovered.length === 0) {
        body.innerHTML =
          `<div style="font-size:11px; color:var(--text-muted);">` +
          `Nothing left to import — every server in <code>~/.claude.json</code> is already here.</div>`;
        return;
      }

      body.innerHTML = discovered
        .map(
          (server, index) =>
            `<div style="display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border-subtle);">` +
            `<div style="flex:1; min-width:0;">` +
            `<div style="font-size:12px; font-weight:bold;">${escapeHtml(server.name)}</div>` +
            `<div style="font-size:10px; color:var(--text-faint); overflow:hidden; text-overflow:ellipsis;">` +
            `${escapeHtml(server.transport)} · ${escapeHtml(server.url || [server.command, ...(server.args ?? [])].join(" "))}` +
            `${server.hasToken ? " · token found" : ""}</div></div>` +
            `<button data-import="${index}" style="padding:4px 10px; font-size:11px;">Import</button></div>`
        )
        .join("");

      body.querySelectorAll("[data-import]").forEach((button) => {
        button.addEventListener("click", () => importServer(discovered[Number(button.dataset.import)]));
      });
    });
  }

  function parsePairs(text) {
    const env = {};
    for (const pair of (text ?? "").trim().split(/\s+/).filter(Boolean)) {
      const index = pair.indexOf("=");
      if (index > 0) env[pair.slice(0, index)] = pair.slice(index + 1);
    }
    return env;
  }

  async function post(payload) {
    const result = document.getElementById("add-result");
    result.style.color = "var(--text-muted)";
    result.textContent = "Saving…";

    const { ok, body } = await safeJson("/api/mcp/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const failed = !ok || !body.ok;
    result.style.color = failed ? "var(--danger-light)" : "var(--ok-text)";
    result.innerHTML = failed
      ? escapeHtml([body.message, ...(body.errors ?? [])].filter(Boolean).join(" "))
      : escapeHtml(body.message);

    if (!failed) {
      appendSystem(escapeHtml(body.message));
      if (window.refreshConnections) window.refreshConnections();
      if (window.fetchMcpServers) window.fetchMcpServers();
    }
  }

  function saveManual() {
    const transport = document.getElementById("add-transport").value;
    post({
      name: document.getElementById("add-name").value,
      transport,
      readOnly: document.getElementById("add-readonly").checked,
      ...(transport === "stdio"
        ? {
            command: document.getElementById("add-command").value,
            args: document.getElementById("add-args").value.trim().split(/\s+/).filter(Boolean),
            env: parsePairs(document.getElementById("add-env").value),
          }
        : {
            url: document.getElementById("add-url").value,
            token: document.getElementById("add-token").value,
            allowSelfSigned: document.getElementById("add-selfsigned").checked,
          }),
    });
  }

  function saveJson() {
    post({ json: document.getElementById("add-json").value });
  }

  function importServer(server) {
    post({
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      readOnly: true,
      label: server.name,
    });
  }

  document.querySelectorAll("[data-open-add]").forEach((button) => {
    button.addEventListener("click", () => {
      // Both panes share one form host, which sits in the Connections pane.
      if (window.openSettings) window.openSettings("connections");
      tab = "manual";
      render();
      host.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });
})();

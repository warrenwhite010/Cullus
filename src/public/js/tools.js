// Tools popup.
//
// /tools used to print the whole list into the chat transcript. With MCP
// servers connected that is dozens of lines of noise you then have to scroll
// past for the rest of the session, and it is gone as soon as you send another
// message. A popup is the right shape: it answers "what can I use here?", you
// read it, you dismiss it.
//
// It shows two things the old list did not:
//
//   SOURCE — which MCP server each tool came from, grouped. With several
//   servers connected, "which of these is Obsidian and which is the filesystem"
//   is the first question anyone actually has.
//
//   COST — an approximate token count per tool and in total. Tool schemas are
//   sent on EVERY request, not once per session, so a hundred tools is a
//   hundred schemas in the prompt of every turn. On a local model with a small
//   context window that is the difference between having room to think and not.
//   Hermes keeps its core toolset deliberately small for exactly this reason;
//   this makes the number visible instead of theoretical.

(function () {
  const $ = (id) => document.getElementById(id);
  let cache = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  // Servers that are connected and contributing nothing.
  //
  // Rendered even while filtering, unlike the other footers: someone who types
  // "unity", sees the two local tools and no explanation concludes the Editor
  // integration does not exist. It is the one absence that looks like a lie.
  function silentGroup(needle) {
    const rows = (cache?.silent ?? [])
      // Tolerate both shapes: this used to be a bare list of names.
      .map((entry) => (typeof entry === "string" ? { name: entry, reason: null } : entry))
      .filter(({ name }) => !needle || name.toLowerCase().includes(needle))
      .map(({ name, reason, modes }) => {
        // The server's own diagnosis beats our guess at one. Only the first
        // line: `unity command` follows it with a three-bullet checklist that
        // does not fit a menu row.
        const why = reason
          ? escapeHtml(String(reason).split("\n")[0])
          : "Connected, but offered no tools when it started. If this app was running " +
            "before the Editor was, reconnect to pick them up.";

        // What still works while it is in this state. Without it the row reads
        // as "Unity is broken" when the local tools are fine — and, for
        // unity_compile, working *because* the Editor is closed.
        const tradeoff = modes
          ? `<span class="tool-desc tool-modes">${escapeHtml(modes)}</span>`
          : "";

        return (
          `<div class="tool-row tool-row-off${modes ? " tool-row-modes" : ""}">` +
          `<span class="tool-name">${escapeHtml(name)}</span>` +
          `<span class="tool-desc">${why}</span>` +
          tradeoff +
          `<button class="ghost tools-reconnect" data-source="${escapeHtml(name)}">Reconnect</button>` +
          `</div>`
        );
      });

    if (rows.length === 0) return "";
    return (
      `<div class="tools-group-head"><span>connected, no tools</span>` +
      `<span>${rows.length} server${rows.length === 1 ? "" : "s"}</span></div>` +
      rows.join("")
    );
  }

  function render(filter = "") {
    const body = $("tools-menu-body");
    if (!body || !cache) return;

    const needle = filter.trim().toLowerCase();
    const matches = cache.tools.filter(
      (t) =>
        !needle ||
        t.name.toLowerCase().includes(needle) ||
        (t.description ?? "").toLowerCase().includes(needle) ||
        t.source.toLowerCase().includes(needle)
    );

    if (matches.length === 0) {
      body.innerHTML =
        `<div class="tools-empty">Nothing matches “${escapeHtml(filter)}”.</div>` +
        silentGroup(needle);
      $("tools-menu-count").textContent = `0 of ${cache.tools.length}`;
      return;
    }

    // Group by source so the servers are visually separated. Local built-ins
    // first — they are always present and are the ones you can rely on.
    const groups = new Map();
    for (const t of matches) {
      if (!groups.has(t.source)) groups.set(t.source, []);
      groups.get(t.source).push(t);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) =>
      a === "local" ? -1 : b === "local" ? 1 : a.localeCompare(b)
    );

    // Servers that are configured but down go at the BOTTOM, after the tools
    // that do exist — present enough to answer "where is Obsidian?", quiet
    // enough not to crowd out what actually works.
    // Sources the user switched off. Distinct from "not connected": these work,
    // they are just not being shown to the model. One click brings them back.
    const disabledHtml =
      !needle && cache.disabled?.length
        ? `<div class="tools-group-head"><span>switched off</span>` +
          `<span>${cache.disabled.length} source${cache.disabled.length === 1 ? "" : "s"} · 0 tokens</span></div>` +
          cache.disabled
            .map(
              (d) =>
                `<div class="tool-row tool-row-off">` +
                `<span class="tool-name">${escapeHtml(d)}</span>` +
                `<span class="tool-desc">Not sent to the model. Costs no context.</span>` +
                `<button class="ghost tools-toggle" data-source="${escapeHtml(d)}" data-enabled="false">Enable</button>` +
                `</div>`
            )
            .join("")
        : "";

    const unavailableHtml =
      !needle && cache.unavailable?.length
        ? `<div class="tools-group-head"><span>not connected</span>` +
          `<span>${cache.unavailable.length} server${cache.unavailable.length === 1 ? "" : "s"}</span></div>` +
          cache.unavailable
            .map(
              (u) =>
                `<div class="tool-row tool-row-off" title="${escapeHtml(u.reason)}">` +
                `<span class="tool-name">${escapeHtml(u.name)}</span>` +
                `<span class="tool-desc">${escapeHtml(u.reason)}</span>` +
                `<span class="tool-cost">0 tools</span>` +
                `</div>`
            )
            .join("")
        : "";

    body.innerHTML = ordered
      .map(([source, tools]) => {
        const groupTokens = tools.reduce((n, t) => n + t.approxTokens, 0);
        return (
          `<div class="tools-group-head">` +
          `<span>${escapeHtml(source)}</span>` +
          `<span class="row gap-3">` +
          `<span>${tools.length} tool${tools.length === 1 ? "" : "s"} · ~${groupTokens.toLocaleString()} tokens</span>` +
          `<button class="ghost tools-toggle" data-source="${escapeHtml(source)}" data-enabled="true">Disable</button>` +
          `</span>` +
          `</div>` +
          tools
            .map(
              (t) =>
                `<div class="tool-row" title="${escapeHtml(t.description ?? "")}">` +
                `<span class="tool-name">${escapeHtml(t.name)}</span>` +
                `<span class="tool-desc">${escapeHtml(t.description ?? "")}</span>` +
                `<span class="tool-cost">~${t.approxTokens}t</span>` +
                `</div>`
            )
            .join("")
        );
      })
      .join("") + silentGroup(needle) + disabledHtml + unavailableHtml;

    $("tools-menu-count").textContent =
      needle ? `${matches.length} of ${cache.tools.length}` : `${cache.tools.length} tools`;
  }

  async function open() {
    const menu = $("tools-menu");
    if (!menu) return;
    menu.classList.add("open");

    const body = $("tools-menu-body");
    body.innerHTML = `<div class="tools-empty">Loading…</div>`;

    try {
      const res = await fetch("/api/tools");
      cache = await res.json();
    } catch (err) {
      body.innerHTML = `<div class="tools-empty c-danger">Could not load tools: ${escapeHtml(err.message)}</div>`;
      return;
    }

    if (!cache.tools?.length) {
      const why = cache.unavailable?.length
        ? `<br><br>` +
          cache.unavailable
            .map((u) => `<strong>${escapeHtml(u.name)}</strong> — ${escapeHtml(u.reason)}`)
            .join("<br>")
        : "";
      body.innerHTML =
        `<div class="tools-empty">No tools available.<br>` +
        `Connect an MCP server in Settings → Connections.${why}</div>`;
      $("tools-menu-foot").textContent = "";
      return;
    }

    const s = cache.summary ?? {};
    // Stated plainly, because the per-turn part is the bit people miss.
    $("tools-menu-foot").innerHTML =
      `<span>~${(s.approxTokens ?? 0).toLocaleString()} tokens of schema sent with <strong>every</strong> message</span>` +
      `<span>Esc to close</span>`;

    const search = $("tools-menu-search");
    search.value = "";
    render("");
    search.focus();
  }

  function close() {
    $("tools-menu")?.classList.remove("open");
  }

  function toggle() {
    const menu = $("tools-menu");
    if (!menu) return;
    if (menu.classList.contains("open")) close();
    else open();
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("tools-menu-search")?.addEventListener("input", (e) => render(e.target.value));
    $("tools-menu-close")?.addEventListener("click", close);
  });

  document.addEventListener("click", async (e) => {
    const reconnect = e.target.closest(".tools-reconnect");
    if (reconnect) {
      e.stopPropagation();
      reconnect.disabled = true;
      reconnect.textContent = "Reconnecting…";
      try {
        const res = await fetch("/api/mcp/reconnect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: reconnect.dataset.source }),
        });
        const data = await res.json();
        // A reconnect that succeeds and still finds nothing is a real answer,
        // not a no-op: it means the Editor is genuinely not there.
        if (!data.ok) reconnect.textContent = data.error ?? "Failed";
        else if (!data.tools) {
          // Re-open rather than just relabelling the button: the row now
          // carries the server's own reason, which is the actual answer.
          reconnect.textContent = "Still none";
          if (data.reason || data.modes) await open();
        } else await open();
      } catch (err) {
        reconnect.textContent = "Failed";
      }
      return;
    }

    const btn = e.target.closest(".tools-toggle");
    if (!btn) return;
    e.stopPropagation();
    btn.disabled = true;
    await fetch(`/api/tools/source/${encodeURIComponent(btn.dataset.source)}/enabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: btn.dataset.enabled !== "true" }),
    });
    // Re-fetch rather than patching the DOM: the token totals change and the
    // whole point of this panel is that those numbers are accurate.
    await open();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // Click outside dismisses, matching the slash menu and the model popover.
  document.addEventListener("click", (e) => {
    const menu = $("tools-menu");
    if (!menu?.classList.contains("open")) return;
    if (menu.contains(e.target)) return;
    if (e.target.closest("#tools-button")) return;
    close();
  });

  window.openToolsMenu = open;
  window.toggleToolsMenu = toggle;
})();

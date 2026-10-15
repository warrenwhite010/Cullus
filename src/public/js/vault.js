// Settings → Vault memory.
//
// One path per memory role, each with a Check that reports what is actually there rather than
// accepting the string and failing quietly later. The mode table beside it is the
// answer to "when can this thing write to my notes", which is the question anyone
// pointing an AI at their vault asks first.

(function () {
  const form = document.getElementById("vault-paths-form");
  if (!form) return;

  const FIELDS = {
    context: {
      label: "Context",
      placeholder: "_assistant/context",
      help: "Note or folder injected into every turn as standing instructions.",
    },
    personal: {
      label: "Personal",
      placeholder: "_assistant/personal",
      help: "Your profile — how you work, what you prefer. Injected every turn, and written by profile_update.",
    },
    notes: {
      label: "Notes",
      placeholder: "_assistant/notes",
      help: "Where notes the assistant writes are filed by default.",
    },
    drafts: {
      label: "Drafts",
      placeholder: "_assistant/drafts",
      help: "Unfinished writing you will edit and send yourself. Written by draft_write.",
    },
    briefs: {
      label: "Briefs",
      placeholder: "_assistant/briefs",
      help: "One note per day, appended to by brief_write.",
    },
    tasks: {
      label: "Tasks",
      placeholder: "_assistant/tasks",
      help: "One note per project holding its open tasks. Written by task_write.",
    },
    skills: {
      label: "Skills",
      placeholder: "_assistant/skills",
      help: "Skill notes. A skill here overrides the built-in of the same name.",
    },
    recipes: {
      label: "Recipes",
      placeholder: "_assistant/recipes",
      help: "Notes with a command: line become callable tools.",
    },
  };

  const inputs = new Map();

  function describe(entry) {
    if (!entry.value) return { text: "not set", colour: "var(--text-faint)" };
    if (entry.kind === "folder") {
      return { text: `folder · ${entry.notes} note(s)`, colour: entry.notes > 0 ? "var(--ok-text)" : "var(--warn-text)" };
    }
    if (entry.kind === "file") return { text: "note found", colour: "var(--ok-text)" };
    return { text: entry.error ?? "does not exist yet", colour: "var(--danger-light)" };
  }

  async function save() {
    const payload = {};
    for (const [key, input] of inputs.entries()) payload[key] = input.value.trim() || null;

    const { ok, body } = await safeJson("/api/vault/paths", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!ok) {
      appendSystem(`Could not save vault paths: ${escapeHtml(body.error ?? "unknown error")}`);
      return;
    }

    appendSystem(
      `Vault memory updated. ${body.recipes.ready} recipe(s) loaded` +
        (body.recipes.broken > 0 ? `, ${body.recipes.broken} note(s) ignored — see Activity.` : ".")
    );
    render();
  }

  async function render() {
    const { body } = await safeJson("/api/vault/paths");

    if (!body.vaultPath) {
      form.innerHTML =
        `<div style="color:var(--warn-text); font-size:12px;">No vault folder is set, so none of this can work. ` +
        `Set it in <strong>Connections → Obsidian Vault → Connect</strong> first.</div>`;
      return;
    }

    form.innerHTML = `<div style="font-size:11px; color:var(--text-faint); margin-bottom:10px;">Vault: <code>${escapeHtml(
      body.vaultPath
    )}</code></div>`;
    inputs.clear();

    for (const entry of body.paths) {
      const meta = FIELDS[entry.key];
      const status = describe(entry);

      const row = document.createElement("div");
      row.style.cssText = "margin-bottom:12px;";
      row.innerHTML =
        `<div style="display:flex; gap:8px; align-items:baseline; margin-bottom:3px;">` +
        `<span style="font-size:11px; color:var(--text-secondary);">${escapeHtml(meta.label)}</span>` +
        `<span style="font-size:10px; color:${status.colour};">${escapeHtml(status.text)}</span></div>`;

      const line = document.createElement("div");
      line.style.cssText = "display:flex; gap:6px;";

      const input = document.createElement("input");
      input.value = entry.value ?? "";
      input.placeholder = meta.placeholder;
      input.style.cssText = "flex:1; font-size:12px; padding:7px;";
      inputs.set(entry.key, input);

      const check = document.createElement("button");
      check.className = "secondary";
      check.textContent = "Check";
      check.style.cssText = "padding:7px 11px; font-size:11px; flex:none;";
      check.addEventListener("click", async () => {
        // Save then re-read, so Check reports the truth about what was typed
        // rather than validating a string in the browser.
        await save();
      });

      line.append(input, check);
      row.appendChild(line);

      const help = document.createElement("div");
      help.style.cssText = "font-size:10px; color:var(--text-faint); margin-top:2px;";
      help.textContent = meta.help;
      row.appendChild(help);

      form.appendChild(row);
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex; gap:8px; align-items:center; margin-top:4px;";

    const saveButton = document.createElement("button");
    saveButton.textContent = "Save paths";
    saveButton.style.cssText = "padding:8px 14px; font-size:12px;";
    saveButton.addEventListener("click", save);
    actions.appendChild(saveButton);

    // Both injected blocks are reported, so "why is the model ignoring my
    // profile" is answerable from this screen rather than from the debug log.
    const injected = [
      ["context", body.context],
      ["profile", body.profile],
    ].filter(([, entry]) => entry);

    if (injected.length > 0) {
      const note = document.createElement("span");
      note.style.cssText = "font-size:11px; color:var(--text-muted);";
      note.textContent =
        "Injecting " +
        injected
          .map(
            ([label, entry]) =>
              `${entry.characters} chars of ${label} from ${entry.sources.length} note(s)` +
              (entry.truncated ? " (truncated)" : "")
          )
          .join(" · ");
      actions.appendChild(note);
    }

    form.appendChild(actions);

    // The lock is a separate axis from the modes, and confusing the two is easy.
    const lockNote = document.getElementById("vault-lock-note");
    if (lockNote) {
      lockNote.innerHTML = body.locked
        ? `<span style="color:var(--danger-light);">🔒 <code>obsidian-live</code> is locked read-only, which overrides all of the ` +
          `above: writes are refused with no prompt. Unlock it in Settings → MCP Servers.</span>`
        : `<code>obsidian-live</code> is unlocked, so the table above applies. Locking it in ` +
          `Settings → MCP Servers refuses every vault write outright.`;
    }

    const recipeHost = document.getElementById("vault-recipes");
    if (recipeHost) {
      const ready = body.recipes?.ready ?? [];
      const broken = body.recipes?.broken ?? [];

      recipeHost.innerHTML =
        (ready.length === 0
          ? `<span style="color:var(--text-faint);">No recipes yet. Add a note with <code>command:</code> in its frontmatter.</span>`
          : ready
              .map(
                (r) =>
                  `<div style="margin-bottom:4px;"><code>${escapeHtml(r.tool)}</code> → ` +
                  `<code>${escapeHtml(r.command)}</code><br>` +
                  `<span style="font-size:10px; color:var(--text-faint);">${escapeHtml(r.path)}</span></div>`
              )
              .join("")) +
        (broken.length > 0
          ? `<div style="margin-top:8px; color:var(--warn-text); font-size:11px;">Ignored: ` +
            broken.map((b) => `${escapeHtml(b.vaultPath)} — ${escapeHtml(b.reason)}`).join("<br>") +
            `</div>`
          : "");
    }
  }

  // Rendered on demand: settings.js calls this when the overlay opens.
  window.refreshVaultSettings = render;
})();

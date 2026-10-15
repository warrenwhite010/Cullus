// /fix, driven entirely from the command line.
//
// This used to be a sidebar panel with a target dropdown, a symptom box and a
// rounds picker. It is a command now: `/fix <symptom>` with optional
// `--target <path>` and `--rounds <n>`. Progress goes to the Activity log and the
// transcript, so a job that runs occasionally no longer holds permanent space.
//
// Revert lives on the completion message rather than a standing button: it is only
// ever meaningful for the run that just finished.

(function () {
  let running = false;

  async function targets() {
    const { body } = await safeJson("/api/fix/runs");
    return body.targets ?? [];
  }

  /** Resolve `--target foo` against the known targets, by path or by label. */
  function matchTarget(list, wanted) {
    if (!wanted) {
      return { ok: true, path: null, label: list.find((t) => t.isSelf)?.label ?? "self" };
    }

    const exact = list.find((t) => t.path === wanted);
    if (exact) return { ok: true, path: exact.isSelf ? null : exact.path, label: exact.label };

    const partial = list.filter(
      (t) => t.path.includes(wanted) || t.label.toLowerCase().includes(wanted.toLowerCase())
    );
    if (partial.length === 1) {
      return { ok: true, path: partial[0].isSelf ? null : partial[0].path, label: partial[0].label };
    }
    if (partial.length > 1) {
      return {
        ok: false,
        error: `"${wanted}" matches ${partial.map((t) => t.label).join(", ")}. Be more specific.`,
      };
    }
    return {
      ok: false,
      error:
        `"${wanted}" is not a repairable target. Known: ${list.map((t) => t.label).join(", ")}. ` +
        `Grant a new one in Settings → Directories.`,
    };
  }

  async function start(symptom, targetPath, rounds, label) {
    if (running) {
      appendSystem("A repair is already running. Press Stop first.");
      return;
    }

    // Show what will actually prove the fix BEFORE running: a missing verify
    // command means "fixed" can only ever mean "it compiles".
    const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
    const { ok, body } = await safeJson(`/api/fix/target${query}`);
    if (!ok) {
      appendSystem(escapeHtml(body.error ?? "That target cannot be repaired."));
      return;
    }

    const { build, verify, source } = body.commands;
    appendSystem(
      `Repairing <strong>${escapeHtml(label)}</strong> — up to ${rounds} round(s)<br>` +
        `<span style="font-size:11px; color:var(--text-muted);">build: <code>${escapeHtml(build ?? "(none)")}</code> · ` +
        `verify: <code>${escapeHtml(verify ?? "(none)")}</code> · from ${escapeHtml(source)}</span>` +
        (verify
          ? ""
          : `<br><span style="font-size:11px; color:var(--warn-text);">No verify command: a repair can only be ` +
            `proven to compile, not to work. Set one with <code>/fix set --verify "&lt;cmd&gt;"</code>.</span>`)
    );

    running = true;
    setStatus("Repairing...");

    const usePipeline = document.getElementById("enable-pipeline-toggle").checked;
    const active = document.getElementById("model-select").value;

    socket.emit("send-fix", {
      symptom,
      target: targetPath,
      rounds,
      models: usePipeline
        ? {
            locate: document.getElementById("triage-model-select").value || active,
            plan: document.getElementById("engineer-model-select").value || active,
          }
        : { locate: active, plan: active },
    });
  }

  async function revert(runId) {
    const { body } = await safeJson("/api/fix/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    appendSystem(escapeHtml(body.message ?? "Revert finished."));
  }

  /** `/fix` and its subcommands. */
  window.runFixCommand = async function runFixCommand(args) {
    const trimmed = (args ?? "").trim();

    if (trimmed === "" || trimmed === "runs") {
      const { body } = await safeJson("/api/fix/runs");
      const runs = body.runs ?? [];
      appendSystem(
        (body.running ? "A repair is running now.<br>" : "") +
          (runs.length === 0
            ? `No repairs yet. Try <code>/fix build fails: Cannot find name X</code>.<br>` +
              `Options: <code>--target &lt;path&gt;</code>, <code>--rounds &lt;1-30&gt;</code>. Also ` +
              `<code>/fix runs</code>, <code>/fix revert [id]</code>, <code>/fix targets</code>, <code>/fix set …</code>.`
            : `<strong>Recent repairs</strong><br>` +
              runs
                .slice(0, 5)
                .map(
                  (run) =>
                    `<code>${escapeHtml(run.id)}</code> ${escapeHtml(run.outcome)} — ` +
                    `${escapeHtml(run.label)}: ${escapeHtml(run.summary)}`
                )
                .join("<br>"))
      );
      return;
    }

    if (trimmed === "targets") {
      const list = await targets();
      const rows = await Promise.all(
        list.map(async (target) => {
          const query = target.isSelf ? "" : `?path=${encodeURIComponent(target.path)}`;
          const { body } = await safeJson(`/api/fix/target${query}`);
          const commands = body.commands ?? {};
          return (
            `<strong>${escapeHtml(target.label)}</strong><br>` +
            `<span style="font-size:11px; color:var(--text-muted);">${escapeHtml(target.path)}<br>` +
            `build: <code>${escapeHtml(commands.build ?? "(none)")}</code> · ` +
            `verify: <code>${escapeHtml(commands.verify ?? "(none)")}</code></span>`
          );
        })
      );
      appendSystem(rows.join("<br><br>"));
      return;
    }

    if (trimmed.startsWith("set")) {
      const build = trimmed.match(/--build\s+"([^"]+)"/)?.[1] ?? null;
      const verify = trimmed.match(/--verify\s+"([^"]+)"/)?.[1] ?? null;
      const target = trimmed
        .replace(/^set\s*/, "")
        .replace(/--(build|verify)\s+"[^"]+"/g, "")
        .trim();

      if (!build && !verify) {
        appendSystem('Usage: <code>/fix set [path] --build "&lt;cmd&gt;" --verify "&lt;cmd&gt;"</code>');
        return;
      }

      const { ok, body } = await safeJson("/api/fix/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: target || null, build, verify }),
      });

      appendSystem(
        ok
          ? `Commands for <code>${escapeHtml(body.root)}</code>:<br>build: ` +
              `<code>${escapeHtml(body.commands.build ?? "(none)")}</code><br>verify: ` +
              `<code>${escapeHtml(body.commands.verify ?? "(none)")}</code>`
          : `Could not set commands: ${escapeHtml(body.error ?? "unknown error")}`
      );
      return;
    }

    if (trimmed.startsWith("revert")) {
      const { body: listing } = await safeJson("/api/fix/runs");
      const runId = trimmed.split(/\s+/)[1] ?? listing.runs?.[0]?.id;
      if (!runId) {
        appendSystem("No repair to revert.");
        return;
      }
      await revert(runId);
      return;
    }

    // Bare form: flags anywhere, everything else is the symptom.
    const roundsMatch = trimmed.match(/--rounds\s+(\d+)/);
    const targetMatch = trimmed.match(/--target\s+(\S+)/);
    const rounds = Math.min(Math.max(Number(roundsMatch?.[1] ?? 3), 1), 30);

    const symptom = trimmed
      .replace(/--rounds\s+\d+/, "")
      .replace(/--target\s+\S+/, "")
      .trim();

    if (!symptom) {
      appendSystem(
        "Describe what's wrong: <code>/fix build fails: Cannot find name X</code>. " +
          "An error string, identifier or filename gives it something to search for."
      );
      return;
    }

    const list = await targets();
    const resolved = matchTarget(list, targetMatch?.[1]);
    if (!resolved.ok) {
      appendSystem(escapeHtml(resolved.error));
      return;
    }

    await start(symptom, resolved.path, rounds, resolved.label);
  };

  socket.on("fix-complete", (report) => {
    running = false;
    setStatus("Ready");

    const kept = report.outcome === "kept";
    const wrap = document.createElement("div");
    wrap.className = `message ${kept ? "ai-msg" : "warn-msg"}`;
    wrap.innerHTML =
      `<strong>Self-repair: ${kept ? "✅ fixed" : `⚠️ ${escapeHtml(report.outcome)}`}</strong><br>` +
      escapeHtml(report.summary) +
      (report.touched?.length
        ? `<br><span style="font-size:11px; color:var(--text-muted);">Files: ` +
          report.touched.map((f) => `<code>${escapeHtml(f)}</code>`).join(", ") +
          `</span>`
        : "");

    // Only offer Revert when there is something to undo.
    if (kept && report.touched?.length) {
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = "Revert this run";
      button.style.cssText = "padding:5px 11px; font-size:11px; margin-top:8px;";
      button.addEventListener("click", async () => {
        button.disabled = true;
        await revert(report.id);
        button.textContent = "Reverted";
      });
      wrap.appendChild(document.createElement("br"));
      wrap.appendChild(button);
    }

    const box = document.getElementById("chat-box");
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  });

  socket.on("assistant-error", () => {
    running = false;
  });
})();

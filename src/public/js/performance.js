// Settings → Performance.
//
// The dials that decide how much the model reads before it can answer. They were
// environment variables, which meant a restart to change a timeout and no way to
// see why a turn was slow.
//
// The diagnostics panel above the form is the point of the pane: on its own,
// "max history messages: 40" means nothing. Next to "your session is 124 messages
// and the next turn will spend ~4 minutes reading before it says a word", it means
// something. Numbers are measured from the live session, not illustrative.

(function () {
  const form = document.getElementById("performance-form");
  if (!form) return;

  const diagnosticsHost = document.getElementById("performance-diagnostics");
  const envHost = document.getElementById("performance-env");
  const status = document.getElementById("performance-status");

  // Ordered by how much each one actually moves the needle, worst first.
  const FIELDS = [
    {
      key: "maxHistoryMessages",
      label: "History sent",
      unit: "messages",
      help:
        "How much of the conversation is replayed each turn. The transcript itself is never " +
        "shortened — this only trims what is sent. 0 sends everything.",
    },
    {
      key: "maxToolResultChars",
      label: "Tool result cap",
      unit: "characters",
      help:
        "A long tool result is re-sent on every later step and every later turn, so one " +
        "oversized file read is a tax on the whole session. 0 means no cap.",
    },
    {
      key: "stepRetries",
      label: "Step retries",
      unit: "attempts",
      help:
        "Extra attempts for a failed inference step before the turn gives up. Each retry " +
        "trims the prompt further rather than repeating what just failed, so the turn keeps " +
        "the tool calls it already made. 0 fails on the first error.",
    },
    // ---- Model parameters ------------------------------------------------
    // 0 means "leave it alone" for every one of these, so an untouched install
    // sends exactly what it always sent.
    {
      key: "numCtxOverride",
      label: "Context window (num_ctx)",
      unit: "tokens, 0 = auto",
      help:
        "Pin the window instead of sizing it to the conversation. This is what allocates the " +
        "KV cache (measured: 8k \u2192 2.47 GB resident, 64k \u2192 3.53 GB, 200k \u2192 5.23 GB), and " +
        "changing it makes Ollama reload the model \u2014 so pinning also stops mid-session " +
        "reloads. 0 keeps the automatic bucketing.",
    },
    {
      key: "keepAliveSeconds",
      label: "Keep model loaded",
      unit: "seconds, 0 = Ollama default",
      help:
        "How long Ollama holds the model in memory after a turn. Longer avoids reload latency " +
        "on the next message; shorter frees several GB between sessions.",
    },
    {
      key: "temperature",
      label: "Temperature",
      unit: "0 = model default",
      help:
        "Lower is more deterministic. Worth dropping for tool-driven work, where you want the " +
        "same call made the same way rather than variety. 0 leaves the model's own default \u2014 " +
        "it does NOT mean greedy decoding.",
    },
    {
      key: "topP",
      label: "Top-p",
      unit: "0 = model default",
      help: "Nucleus sampling. Usually left alone; tune temperature first.",
    },
    {
      key: "topK",
      label: "Top-k",
      unit: "0 = model default",
      help: "Caps how many candidate tokens are considered. Usually left alone.",
    },
    {
      key: "repeatPenalty",
      label: "Repeat penalty",
      unit: "0 = model default",
      help:
        "Penalises tokens already generated. This is the dial for a model that loops \u2014 " +
        "re-issuing the same tool call, or restating the same paragraph. Try 1.1 before 1.3.",
    },
    {
      key: "toolBudget",
      label: "Tool budget",
      unit: "tools",
      help:
        "Most tools sent in one turn. Their schemas are prompt too, and a small model aims " +
        "worse the longer the list. Anything cut is named in the prompt, never dropped silently.",
    },
    {
      key: "firstTokenTimeoutMs",
      label: "First-token timeout",
      unit: "ms",
      help:
        "How long the model may spend reading the prompt before producing anything. Nothing " +
        "streams during this phase, so it cannot be told apart from a stall — keep it generous.",
    },
    {
      key: "stepIdleTimeoutMs",
      label: "Idle timeout",
      unit: "ms",
      help:
        "Silence allowed after output has started. Past this the model is treated as wedged, " +
        "not slow.",
    },
    {
      key: "stepTotalTimeoutMs",
      label: "Total step timeout",
      unit: "ms",
      help: "Hard ceiling on one inference step, whatever it is doing. 0 removes the ceiling.",
    },
    {
      key: "toolTimeoutMs",
      label: "Tool timeout",
      unit: "ms",
      help: "A tool call reports no progress, so this one is a plain wall-clock limit.",
    },
  ];

  const inputs = new Map();
  let bounds = {};

  function seconds(ms) {
    if (!ms) return "no limit";
    return ms >= 60000 ? `${Math.round(ms / 6000) / 10} min` : `${Math.round(ms / 1000)}s`;
  }

  function renderDiagnostics(d) {
    const trimmed = d.untrimmedPromptTokens - d.estimatedPromptTokens;
    const slow = d.estimatedPromptEvalSeconds >= 60;

    if (!d.historyMessages) {
      diagnosticsHost.innerHTML =
        `<div style="font-size:12px; color:var(--text-faint);">No active conversation to measure yet. ` +
        `Send a message and reopen this pane.</div>`;
      return;
    }

    const cell = (value, label, colour) =>
      `<div style="flex:1; min-width:110px;">
         <div style="font-size:17px; font-weight:600; color:${colour};">${escapeHtml(String(value))}</div>
         <div style="font-size:10px; color:var(--text-muted); margin-top:2px;">${escapeHtml(label)}</div>
       </div>`;

    diagnosticsHost.innerHTML =
      `<div style="background:var(--surface-0); border:1px solid var(--surface-1); border-radius:8px; padding:12px 14px;">
         <div style="display:flex; gap:14px; flex-wrap:wrap;">
           ${cell(d.estimatedPromptTokens.toLocaleString(), "prompt tokens next turn", slow ? "var(--danger-light)" : "var(--ok-text)")}
           ${cell(`~${d.estimatedPromptEvalSeconds}s`, "spent reading, before the first word", slow ? "var(--danger-light)" : "var(--ok-text)")}
           ${cell(`${d.sentMessages} / ${d.historyMessages}`, "messages sent / in session", "var(--text-secondary)")}
           ${cell(d.toolsAvailable === null ? "—" : d.toolsAvailable, "tools connected", "var(--text-secondary)")}
         </div>
         ${
           trimmed > 0
             ? `<div style="font-size:11px; color:var(--ok-text); margin-top:10px;">
                  Current settings are saving ${trimmed.toLocaleString()} prompt tokens per turn
                  (~${Math.round(trimmed / 250)}s) versus sending the whole transcript.
                </div>`
             : ""
         }
         ${
           slow
             ? `<div style="font-size:11px; color:var(--warn-text); margin-top:8px;">
                  Over a minute of reading per turn. Lowering <b>History sent</b> or
                  <b>Tool result cap</b> is the fastest way down. Starting a new chat clears it entirely.
                </div>`
             : ""
         }
       </div>`;
  }

  function renderForm(values) {
    form.innerHTML = FIELDS.map((field) => {
      const bound = bounds[field.key] ?? {};
      const range =
        `${(bound.min ?? 0).toLocaleString()}–${(bound.max ?? 0).toLocaleString()}` +
        (bound.allowUnlimited ? ", or 0 for no limit" : "");

      return `
        <div style="display:flex; gap:12px; align-items:flex-start; padding:10px 0; border-bottom:1px solid var(--surface-1);">
          <div style="flex:1;">
            <label for="perf-${field.key}" style="font-size:12px; color:var(--text-bright); font-weight:600;">
              ${escapeHtml(field.label)}
            </label>
            <div style="font-size:11px; color:var(--text-muted); margin-top:3px; line-height:1.5;">
              ${escapeHtml(field.help)}
            </div>
            <div style="font-size:10px; color:var(--text-faint); margin-top:3px;">Allowed: ${escapeHtml(range)}</div>
          </div>
          <div style="width:150px; text-align:right;">
            <input type="number" id="perf-${field.key}" value="${Number(values[field.key] ?? 0)}"
                   min="0" max="${bound.max ?? 0}"
                   style="width:120px; font-size:12px; padding:6px; text-align:right;" />
            <div style="font-size:10px; color:var(--text-faint); margin-top:3px;" id="perf-${field.key}-hint">
              ${escapeHtml(field.unit)}
            </div>
          </div>
        </div>`;
    }).join("");

    inputs.clear();
    for (const field of FIELDS) {
      const input = document.getElementById(`perf-${field.key}`);
      inputs.set(field.key, input);

      // Milliseconds are unreadable at a glance; echo the human version as typed.
      if (field.unit === "ms") {
        const hint = document.getElementById(`perf-${field.key}-hint`);
        const show = () => (hint.textContent = `ms · ${seconds(Number(input.value))}`);
        input.addEventListener("input", show);
        show();
      }
    }
  }

  function renderShutdown(shutdown) {
    const host = document.getElementById("performance-shutdown");
    if (!host) return;

    const on = shutdown.exitWhenLastClientDisconnects !== false;

    host.innerHTML = `
      <label style="display:flex; gap:8px; align-items:flex-start; font-size:12px; color:var(--text-bright); cursor:pointer;">
        <input type="checkbox" id="perf-exitOnClose" ${on ? "checked" : ""}
               style="width:auto; flex:none; margin-top:2px;" />
        <span>
          Stop the server when the last window closes
          <div style="font-size:11px; color:var(--text-muted); margin-top:3px; line-height:1.5;">
            The dashboard is the only interface, so a server with nobody attached is usually a
            forgotten process holding the port. A reload looks identical to a close, so the exit
            waits out the grace period below and is cancelled if anything reconnects. A turn that
            is still running defers the exit rather than being killed by it.
          </div>
        </span>
      </label>
      <div style="display:flex; gap:8px; align-items:center; margin-top:10px; font-size:12px; color:var(--text-bright);">
        <label for="perf-exitGrace">Grace period</label>
        <input type="number" id="perf-exitGrace" min="1" max="3600"
               value="${Number(shutdown.exitGraceSeconds ?? 10)}"
               style="width:80px; font-size:12px; padding:6px; text-align:right;" />
        <span style="font-size:11px; color:var(--text-faint);">seconds — long enough to survive a refresh</span>
      </div>`;

    const toggle = document.getElementById("perf-exitOnClose");
    const grace = document.getElementById("perf-exitGrace");
    const sync = () => (grace.disabled = !toggle.checked);
    toggle.addEventListener("change", sync);
    sync();
  }

  function renderEnv(overrides) {
    if (!overrides.length) {
      envHost.innerHTML = "";
      return;
    }
    // A dial that silently does nothing is worse than no dial, so say it plainly.
    envHost.innerHTML =
      `<div style="background:var(--stone-900); border:1px solid var(--warn-deep-bg); border-radius:6px; padding:10px 12px; font-size:11px; color:var(--warn-text);">
         <b>Overridden by the environment.</b> These are set in the shell that started the app and
         win over anything saved here — unset them to use these settings:
         <div style="margin-top:6px; color:var(--warn-peach);">
           ${overrides
             .map((o) => `<code>${escapeHtml(o.env)}=${escapeHtml(String(o.value))}</code>`)
             .join("<br>")}
         </div>
       </div>`;
  }

  async function render() {
    const { ok, body } = await safeJson("/api/performance");
    if (!ok) {
      form.innerHTML = `<div style="font-size:12px; color:var(--danger-light);">Could not load performance settings.</div>`;
      return;
    }
    bounds = body.bounds ?? {};
    renderDiagnostics(body.diagnostics ?? {});
    renderForm(body.performance ?? {});
    renderShutdown(body.shutdown ?? {});
    renderEnv(body.overriddenByEnv ?? []);
    status.textContent = "";
  }

  async function save(payload, note) {
    const { ok, body } = await safeJson("/api/performance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!ok) {
      status.style.color = "var(--danger-light)";
      status.textContent = body.error ?? "Could not save.";
      return;
    }

    status.style.color = "var(--ok-text)";
    status.textContent = note ?? (body.changed?.length ? "Saved. Applies to your next message." : "No changes.");
    await render();
  }

  document.getElementById("performance-save").addEventListener("click", () => {
    const payload = {};
    for (const [key, input] of inputs.entries()) payload[key] = Number(input.value);

    const toggle = document.getElementById("perf-exitOnClose");
    const grace = document.getElementById("perf-exitGrace");
    if (toggle) payload.exitWhenLastClientDisconnects = toggle.checked;
    if (grace) payload.exitGraceSeconds = Number(grace.value);

    save(payload);
  });

  document.getElementById("performance-reset").addEventListener("click", () => {
    // The server clamps and validates anyway; sending the shipped defaults keeps
    // the definition of "default" in one place rather than duplicating it here.
    save(
      {
        toolBudget: 28,
        maxHistoryMessages: 40,
        maxToolResultChars: 8000,
        stepIdleTimeoutMs: 120000,
        firstTokenTimeoutMs: 600000,
        stepTotalTimeoutMs: 900000,
        toolTimeoutMs: 120000,
        stepRetries: 2,
        numCtxOverride: 0,
        keepAliveSeconds: 0,
        temperature: 0,
        topP: 0,
        topK: 0,
        repeatPenalty: 0,
      },
      "Defaults restored."
    );
  });

  // Rendered on demand: settings.js calls this when the overlay opens.
  window.refreshPerformanceSettings = render;
})();

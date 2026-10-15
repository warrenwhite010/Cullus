// Scheduled jobs panel.
//
// Talks to the four /api/cron routes. Built entirely from the classes in
// components.css — no inline styles, which is the point of the design-system
// pass this shipped with.
//
// The one thing this UI has to communicate well is monitor mode, because it is
// the difference between a job that costs one model call a day and one that
// costs ninety-six. The form says so, and a monitor job shows a "no change"
// badge when its last tick was suppressed, so you can see it working.

(function () {
  const $ = (id) => document.getElementById(id);

  function badgeFor(job) {
    if (!job.enabled) return '<span class="badge">disabled</span>';
    if (job.failureCount > 0)
      return `<span class="badge danger">${job.failureCount} failure${job.failureCount > 1 ? "s" : ""}</span>`;
    if (job.lastStatus === "error") return '<span class="badge danger">error</span>';
    if (job.lastStatus === "no_change") return '<span class="badge">no change</span>';
    if (job.lastStatus === "ok") return '<span class="badge ok">ok</span>';
    return '<span class="badge accent">waiting</span>';
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function renderJob(job) {
    const next = job.nextRun ? new Date(job.nextRun).toLocaleString() : "not armed";
    const last = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "never run";
    return `
      <div class="cron-job ${job.enabled ? "" : "disabled"}">
        <div class="cron-job-head">
          <div class="row gap-3">
            <span class="cron-job-name">${escapeHtml(job.name)}</span>
            <span class="badge${job.kind === "monitor" ? " accent" : ""}">${job.kind}</span>
            ${badgeFor(job)}
          </div>
          <div class="cron-job-actions">
            <button class="ghost" data-toggle="${job.id}" data-enabled="${job.enabled}">
              ${job.enabled ? "Disable" : "Enable"}
            </button>
            <button class="ghost" data-remove="${job.id}">Remove</button>
          </div>
        </div>
        <div class="cron-job-meta">
          <code>${escapeHtml(job.schedule)}</code> · next ${escapeHtml(next)} · last ${escapeHtml(last)}
        </div>
      </div>`;
  }

  async function load() {
    const list = $("cronList");
    if (!list) return;
    try {
      const res = await fetch("/api/cron");
      const data = await res.json();
      const jobs = data.jobs ?? [];
      list.innerHTML = jobs.length
        ? jobs.map(renderJob).join("")
        : '<div class="cron-empty">No scheduled jobs yet. Add one below.</div>';
    } catch (err) {
      list.innerHTML = `<div class="cron-empty c-danger">Could not load jobs: ${escapeHtml(err.message)}</div>`;
    }
  }

  function showError(message) {
    const el = $("cronError");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("hidden");
  }

  function clearError() {
    $("cronError")?.classList.add("hidden");
  }

  async function add() {
    clearError();
    const kind = $("cronKind").value;
    const body = {
      name: $("cronName").value.trim(),
      schedule: currentSchedule(),
      prompt: $("cronPrompt").value.trim(),
      kind,
      monitorScript: kind === "monitor" ? $("cronScript").value.trim() : undefined,
    };
    if (!body.name || !body.schedule || !body.prompt) {
      showError("Name, schedule and prompt are all required.");
      return;
    }
    if (kind === "monitor" && !body.monitorScript) {
      showError("A monitor job needs a script to watch.");
      return;
    }

    const res = await fetch("/api/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    // The server enforces both guards — an invalid cron expression and a script
    // that could restart the assistant. Surface its message rather than
    // reimplementing the checks here, so there is one source of truth.
    if (!res.ok) {
      showError(data.error ?? "Could not create the job.");
      return;
    }
    $("cronName").value = "";
    $("cronPrompt").value = "";
    $("cronScript").value = "";
    load();
  }

  function syncKindFields() {
    const isMonitor = $("cronKind")?.value === "monitor";
    $("cronScriptRow")?.classList.toggle("hidden", !isMonitor);
    $("cronMonitorHint")?.classList.toggle("hidden", !isMonitor);
  }

  /**
   * The schedule the form will submit.
   *
   * A cron expression is not something most people should have to write, so the
   * default path is a dropdown of the schedules anyone actually wants. "Custom"
   * reveals the raw field for the cases the presets do not cover.
   */
  function currentSchedule() {
    const preset = $("cronPreset")?.value;
    if (preset && preset !== "custom") return preset;
    return $("cronSchedule")?.value.trim() ?? "";
  }

  function syncScheduleFields() {
    const custom = $("cronPreset")?.value === "custom";
    $("cronCustomRow")?.classList.toggle("hidden", !custom);
    $("cronCustomHint")?.classList.toggle("hidden", !custom);
    updatePreview();
  }

  /** Today / tomorrow / a date, plus the time. Absolute dates read badly for
   *  something firing in ten minutes. */
  function friendlyTime(iso) {
    const when = new Date(iso);
    const now = new Date();
    const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const days = Math.round((when.setHours(0, 0, 0, 0) - now.setHours(0, 0, 0, 0)) / 86400000);
    if (days === 0) return `today ${time}`;
    if (days === 1) return `tomorrow ${time}`;
    return `${new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
  }

  let previewTimer = null;
  function updatePreview() {
    clearTimeout(previewTimer);
    // Debounced: the custom field fires on every keystroke and a half-typed
    // expression is invalid, so showing an error mid-word is just noise.
    previewTimer = setTimeout(async () => {
      const el = $("cronPreview");
      if (!el) return;
      const schedule = currentSchedule();
      if (!schedule) {
        el.textContent = "";
        return;
      }
      try {
        const res = await fetch(`/api/cron/preview?schedule=${encodeURIComponent(schedule)}`);
        const data = await res.json();
        if (!data.valid) {
          el.classList.add("invalid");
          el.textContent = data.error ?? "That schedule is not valid.";
          return;
        }
        el.classList.remove("invalid");
        const times = (data.upcoming ?? []).map(friendlyTime);
        el.innerHTML =
          `Runs <strong>${escapeHtml(times[0] ?? "—")}</strong>` +
          (times.length > 1 ? `, then ${escapeHtml(times.slice(1).join(", "))}` : "") +
          ` <span class="cron-preview-expr">${escapeHtml(schedule)}</span>`;
      } catch {
        el.textContent = "";
      }
    }, 250);
  }

  document.addEventListener("click", async (event) => {
    const toggle = event.target.closest("[data-toggle]");
    if (toggle) {
      await fetch(`/api/cron/${toggle.dataset.toggle}/enabled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: toggle.dataset.enabled !== "true" }),
      });
      load();
      return;
    }
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      if (!confirm("Remove this scheduled job and its run history?")) return;
      await fetch(`/api/cron/${remove.dataset.remove}`, { method: "DELETE" });
      load();
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    $("cronAdd")?.addEventListener("click", add);
    $("cronKind")?.addEventListener("change", syncKindFields);
    $("cronPreset")?.addEventListener("change", syncScheduleFields);
    $("cronSchedule")?.addEventListener("input", updatePreview);
    syncKindFields();
    syncScheduleFields();
    load();
    // Cheap poll. Next-run times tick over and a monitor job flips to
    // "no change" without any user action, so a static panel goes stale.
    setInterval(load, 30_000);
  });

  window.loadCronJobs = load;
})();

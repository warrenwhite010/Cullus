// Diagnostics panel.
//
// /doctor used to print a table into the chat transcript, which has the same
// problem /tools had: it scrolls away, you cannot come back to it, and it is
// competing for space with the conversation. A health report is something you
// read carefully and act on, so it belongs in Settings next to the things it is
// telling you to fix.
//
// The fix line is the point of the whole report. A check that says "Ollama is
// not running" and stops there has told you what you already knew from the
// error; the useful part is the command that resolves it. So fixes get the
// accent treatment rather than being another grey line.

(function () {
  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  // Backticked commands in a fix become <code>. The fixes are written as
  // "Upgrade Node: `brew upgrade node`." and that is the bit to make copyable.
  function formatFix(text) {
    return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function render(data) {
    const body = $("doctorBody");
    if (!body) return;

    const checks = data.checks ?? [];
    const s = data.summary ?? { pass: 0, warn: 0, fail: 0 };

    const state = s.fail > 0 ? "has-fail" : s.warn > 0 ? "has-warn" : "all-clear";
    const verdict =
      s.fail > 0
        ? `${s.fail} thing${s.fail === 1 ? "" : "s"} to fix`
        : s.warn > 0
          ? `${s.warn} warning${s.warn === 1 ? "" : "s"}`
          : "Everything checks out";

    $("doctorSummary").className = `doctor-summary ${state}`;
    $("doctorSummary").innerHTML =
      `<strong>${escapeHtml(verdict)}</strong>` +
      `<span class="c-muted">${s.pass} pass · ${s.warn} warn · ${s.fail} fail</span>`;

    // Failures first, then warnings, then passes. A report you have to scroll
    // to find the problem in is a report that buries its own point.
    const order = { fail: 0, warn: 1, pass: 2 };
    const sorted = [...checks].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

    body.innerHTML = sorted
      .map(
        (c) =>
          `<div class="doctor-check">` +
          `<span class="doctor-dot ${escapeHtml(c.status)}"></span>` +
          `<span class="doctor-name">${escapeHtml(c.name)}</span>` +
          `<span class="doctor-detail">${escapeHtml(c.detail ?? "")}` +
          (c.fix ? `<div class="doctor-fix">${formatFix(c.fix)}</div>` : "") +
          `</span>` +
          `</div>`
      )
      .join("");
  }

  async function run() {
    const body = $("doctorBody");
    const button = $("doctorRun");
    if (!body) return;

    button.disabled = true;
    button.textContent = "Running…";
    body.innerHTML = `<div class="cron-empty">Checking…</div>`;
    $("doctorSummary").className = "doctor-summary";
    $("doctorSummary").textContent = "";

    try {
      const res = await fetch("/api/doctor");
      render(await res.json());
    } catch (err) {
      body.innerHTML = `<div class="cron-empty c-danger">Could not run diagnostics: ${escapeHtml(err.message)}</div>`;
    } finally {
      button.disabled = false;
      button.textContent = "Run diagnostics";
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("doctorRun")?.addEventListener("click", run);

    // Run automatically when the tab is first opened. Making someone click a
    // button to find out whether anything is wrong is one step too many for the
    // panel whose entire job is answering that.
    document.querySelector('[data-tab="doctor"]')?.addEventListener("click", () => {
      if (!$("doctorBody")?.dataset.loaded) {
        $("doctorBody").dataset.loaded = "1";
        run();
      }
    });
  });

  window.openDoctorPanel = () => {
    document.querySelector(".overlay")?.classList.add("open");
    document.querySelector('[data-tab="doctor"]')?.click();
    run();
  };
})();

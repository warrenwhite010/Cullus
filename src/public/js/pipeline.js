// Pipeline mode, the worker dial, and the memory estimate.
//
// The estimate is the whole reason this control is honest. Measured on this
// machine: one model serving 8 concurrent requests stays at 2.83 GB resident,
// while loading a second distinct model costs its full size (2.83 + 4.23 =
// 7.06 GB). So worker count is nearly free and a second model is not — and the
// panel says which one you are about to spend.

(function () {
  const wrap = document.getElementById("pipeline-model-selectors");
  const slider = document.getElementById("worker-count");
  const readout = document.getElementById("worker-count-value");
  const estimate = document.getElementById("worker-estimate");
  const controls = document.getElementById("fanout-controls");
  const roleThird = document.getElementById("role-3-wrap");
  const label1 = document.getElementById("role-1-label");
  const label2 = document.getElementById("role-2-label");
  // The rounds control moved into the /fix command (`--rounds n`), so there is no
  // input here to keep in step.

  let sizes = {};

  function mode() {
    return document.querySelector('input[name="pipeline-mode"]:checked')?.value ?? "fanout";
  }

  function gb(bytes) {
    return `${(bytes / 1e9).toFixed(1)} GB`;
  }

  function renderEstimate() {
    const workers = Number(slider.value);
    const workerModel =
      document.getElementById("engineer-model-select").value ||
      document.getElementById("model-select").value;
    const plannerModel = document.getElementById("triage-model-select").value || workerModel;

    const workerSize = sizes[workerModel] ?? 0;
    const plannerSize = plannerModel === workerModel ? 0 : sizes[plannerModel] ?? 0;

    if (!workerSize) {
      estimate.textContent = `${workers} worker(s) share one copy of the model in memory.`;
      return;
    }

    const total = workerSize + plannerSize;
    estimate.innerHTML =
      `${workers} worker(s) × <code>${workerModel}</code> ≈ <strong>${gb(workerSize)}</strong> ` +
      `— one copy of the weights, whatever N is.` +
      (plannerSize
        ? `<br>Planner <code>${plannerModel}</code> adds ${gb(plannerSize)} → ${gb(total)} total.`
        : `<br>Planner shares the worker model, so nothing extra loads.`) +
      (workers > 4
        ? `<br>Past ~4 the speed gain flattens: Ollama serves a fixed slot count (OLLAMA_NUM_PARALLEL).`
        : "");
  }

  function applyMode() {
    const fanout = mode() === "fanout";
    controls.style.display = fanout ? "" : "none";
    roleThird.style.display = fanout ? "none" : "";
    label1.textContent = fanout ? "Planner" : "Triage / locate";
    label2.textContent = fanout ? "Workers" : "Engineer / plan";
    renderEstimate();
  }

  slider.addEventListener("input", () => {
    readout.textContent = slider.value;
    renderEstimate();
  });

  slider.addEventListener("change", () => {
    safeJson("/api/fanout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workers: Number(slider.value) }),
    });
  });

  document.querySelectorAll('input[name="pipeline-mode"]').forEach((radio) => {
    radio.addEventListener("change", applyMode);
  });
  ["triage-model-select", "engineer-model-select", "model-select"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderEstimate);
  });

  // Fan-out progress lands in the transcript, so a run that takes minutes shows
  // its working rather than sitting silent.
  socket.on("fanout-progress", (event) => {
    if (event.phase === "worker" && event.status === "running") return; // the checklist covers these
    const icon = { ok: "✅", warn: "⚠️", fail: "❌", running: "…" }[event.status] ?? "·";
    appendSystem(`${icon} <strong>${escapeHtml(event.phase)}</strong>: ${escapeHtml(event.message)}`);
  });

  (async () => {
    const [{ body: models }, { body: fanout }] = await Promise.all([
      safeJson("/api/models"),
      safeJson("/api/fanout"),
    ]);

    for (const model of models.details ?? []) {
      if (model?.name && typeof model.size === "number") sizes[model.name] = model.size;
    }

    if (fanout?.workers) {
      slider.value = fanout.workers;
      readout.textContent = fanout.workers;
    }
    if (fanout?.maxWorkers) slider.max = fanout.maxWorkers;

    applyMode();
  })();

  window.pipelineMode = mode;
  window.workerCount = () => Number(slider.value);
})();

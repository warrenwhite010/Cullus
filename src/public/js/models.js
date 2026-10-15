// Model picker in the composer.
//
// The choice of model belongs next to the message you're about to send, not in a
// settings rail — that's why claude.ai puts it there. The hidden <select
// id="model-select"> stays the single source of truth, so every existing caller
// (sendMessage, /model, the pipeline) keeps reading one place; this is purely a
// nicer way to set it.

(function () {
  const button = document.getElementById("model-button");
  const popover = document.getElementById("model-popover");
  const list = document.getElementById("model-popover-list");
  const select = document.getElementById("model-select");

  function currentTag() {
    return select.value || "";
  }

  function label() {
    const tag = currentTag();
    button.textContent = tag ? `${tag} ⌄` : "no model ⌄";
    button.title = tag ? `Active model: ${tag}. Click to change.` : "No model selected";
  }

  function render() {
    list.innerHTML = "";
    const tags = Array.from(select.options).map((option) => option.value).filter(Boolean);

    if (tags.length === 0) {
      list.innerHTML =
        `<div style="padding:10px 12px; font-size:12px; color:var(--text-muted);">` +
        `No models pulled. Run <code>ollama pull qwen3.5:9b</code>.</div>`;
      return;
    }

    for (const tag of tags) {
      const row = document.createElement("div");
      row.className = `model-option${tag === currentTag() ? " selected" : ""}`;

      const name = document.createElement("span");
      name.textContent = tag;
      row.appendChild(name);

      if (tag === currentTag()) {
        const mark = document.createElement("span");
        mark.style.cssText = "color:var(--accent); font-weight:bold;";
        mark.textContent = "active";
        row.appendChild(mark);
      }

      row.addEventListener("click", () => {
        select.value = tag;
        // Dispatch so the inline change handler persists it via /api/config/model.
        select.dispatchEvent(new Event("change"));
        popover.classList.remove("open");
        label();
        render();
      });

      list.appendChild(row);
    }
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    popover.classList.toggle("open");
    if (popover.classList.contains("open")) render();
  });

  document.addEventListener("click", (event) => {
    if (!popover.contains(event.target) && event.target !== button) {
      popover.classList.remove("open");
    }
  });

  // The inline script fills the <select> asynchronously and /model sets it
  // directly, so mirror it rather than tracking every writer.
  select.addEventListener("change", () => {
    label();
    render();
  });
  new MutationObserver(label).observe(select, { childList: true });
  setInterval(label, 1500);

  label();
})();

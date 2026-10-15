// The ask_user prompt: a keyboard-driven option list, like the CLI's.
//
// The model can now ask a question mid-turn and wait for the answer, so the answer
// has to be quick to give: arrow keys to move, Enter to pick, a number key to jump
// straight to one, Esc to let the model decide for itself. Typing anything else
// falls through to the composer, which answers in free text — because "none of
// these, do X instead" is a common and useful reply to a multiple-choice question.
//
// The inference loop is blocked while this is on screen, which drives two rules:
//
//   1. Every exit path sends something back. Esc and dismissal send an explicit
//      "unanswered" so the model assumes a default instead of waiting out its
//      ten-minute timeout.
//   2. Only one question is live at a time. A second request supersedes the first
//      rather than stacking two capture layers over the same keyboard.

(function () {
  let active = null;

  const chatBox = () => document.getElementById("chat-box");

  function scrollToBottom() {
    const box = chatBox();
    box.scrollTop = box.scrollHeight;
  }

  /** Send the answer, tear down the card, and show what was chosen. */
  function answer(chosen, text) {
    if (!active) return;
    const { id, wrap, list, hint } = active;
    active = null;

    socket.emit("user-choice-response", { id, chosen, text });

    list.remove();
    const verdict = document.createElement("div");
    const dismissed = chosen.length === 0 && !text;
    verdict.style.cssText = `font-size:12px; margin-top:6px; color:${dismissed ? "var(--danger-light)" : "var(--ok-text)"};`;
    verdict.textContent = dismissed
      ? "Skipped — the model will pick a default and say what it assumed."
      : `You chose: ${[...chosen, ...(text ? [`"${text}"`] : [])].join(", ")}`;
    if (hint) hint.remove();
    wrap.appendChild(verdict);
    scrollToBottom();

    // Hand the keyboard back to the composer.
    const input = document.getElementById("prompt-input");
    input.placeholder = "Ask anything, or / for commands";
    input.focus();
  }

  function highlight(index) {
    if (!active) return;
    active.index = (index + active.options.length) % active.options.length;
    active.rows.forEach((row, i) => {
      const selected = active.chosen.has(i);
      const current = i === active.index;
      row.style.background = current ? "var(--surface-1)" : "transparent";
      row.style.borderLeft = `3px solid ${current ? "var(--accent)" : "transparent"}`;
      row.querySelector("[data-marker]").textContent = active.multiSelect
        ? selected
          ? "[x]"
          : "[ ]"
        : current
          ? "❯"
          : " ";
    });
    active.rows[active.index]?.scrollIntoView({ block: "nearest" });
  }

  function commit() {
    if (!active) return;
    if (active.multiSelect) {
      const picked = [...active.chosen].sort((a, b) => a - b).map((i) => active.options[i].label);
      // Enter with nothing ticked means "this one", not "none" — the alternative
      // is a prompt that silently does nothing when you press the obvious key.
      answer(picked.length > 0 ? picked : [active.options[active.index].label], undefined);
      return;
    }
    answer([active.options[active.index].label], undefined);
  }

  // Global capture: the card is never focused itself, so the keys work wherever
  // the caret happens to be — including the composer, which stays usable for a
  // free-text reply.
  document.addEventListener(
    "keydown",
    (event) => {
      if (!active || active.options.length === 0) return;

      const input = document.getElementById("prompt-input");
      const typing = document.activeElement === input && input.value.length > 0;

      if (event.key === "Escape") {
        event.preventDefault();
        answer([], undefined);
        return;
      }

      // Once there is text in the composer, Enter belongs to that text: sendMessage
      // routes it here as the free-text answer.
      if (typing) return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        highlight(active.index + (event.key === "ArrowDown" ? 1 : -1));
        return;
      }

      if (event.key === " " && active.multiSelect) {
        event.preventDefault();
        if (active.chosen.has(active.index)) active.chosen.delete(active.index);
        else active.chosen.add(active.index);
        highlight(active.index);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        return;
      }

      // Number keys jump and pick in one press, which is how these get answered
      // in practice once you have read the list.
      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        if (index < active.options.length) {
          event.preventDefault();
          highlight(index);
          if (!active.multiSelect) commit();
        }
      }
    },
    true
  );

  socket.on("user-choice-request", (request) => {
    // A superseded question is answered as unanswered rather than abandoned, so
    // nothing is left waiting on a card the user can no longer see.
    if (active) answer([], undefined);

    const options = Array.isArray(request.options) ? request.options : [];

    const wrap = document.createElement("div");
    wrap.className = "message warn-msg";
    wrap.innerHTML =
      `<strong>❔ ${escapeHtml(request.question)}</strong>` +
      (options.length === 0
        ? `<div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">Type your answer below and press Enter.</div>`
        : "");

    const list = document.createElement("div");
    list.style.cssText = "margin-top:8px; max-height:220px; overflow-y:auto;";

    const rows = options.map((option, i) => {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex; gap:8px; align-items:flex-start; padding:5px 8px; cursor:pointer; " +
        "border-radius:4px; font-size:13px; line-height:1.45;";

      const marker = document.createElement("span");
      marker.setAttribute("data-marker", "");
      marker.style.cssText = "flex:none; width:14px; color:var(--accent); font-weight:bold;";

      const label = document.createElement("span");
      label.innerHTML =
        `<span style="color:var(--text-faint);">${i + 1}.</span> ${escapeHtml(option.label)}` +
        (option.description
          ? `<div style="color:var(--text-muted); font-size:11px;">${escapeHtml(option.description)}</div>`
          : "");

      row.append(marker, label);
      row.addEventListener("mouseenter", () => highlight(i));
      row.addEventListener("click", () => {
        highlight(i);
        if (active?.multiSelect) {
          if (active.chosen.has(i)) active.chosen.delete(i);
          else active.chosen.add(i);
          highlight(i);
        } else {
          commit();
        }
      });

      list.appendChild(row);
      return row;
    });

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:11px; color:var(--text-muted); margin-top:6px;";
    hint.innerHTML =
      options.length > 0
        ? `↑↓ move · <strong>Enter</strong> choose · <strong>1-${Math.min(options.length, 9)}</strong> pick directly` +
          (request.multiSelect ? " · <strong>Space</strong> toggle" : "") +
          ` · type below for a different answer · <strong>Esc</strong> let the model decide`
        : `<strong>Enter</strong> to send · <strong>Esc</strong> to let the model decide`;

    wrap.append(list, hint);
    chatBox().appendChild(wrap);

    active = {
      id: request.id,
      question: request.question,
      options,
      rows,
      wrap,
      list,
      hint,
      index: 0,
      chosen: new Set(),
      multiSelect: request.multiSelect === true,
    };

    highlight(0);

    const input = document.getElementById("prompt-input");
    input.placeholder = "Type a different answer, or use ↑↓ and Enter";
    input.focus();
    scrollToBottom();
  });

  // index.html's sendMessage checks this: while a question is open, what you type
  // is the answer to it, not a new turn. Sending a second turn instead would leave
  // the first one blocked on a question nobody is answering.
  window.pendingChoice = () => (active ? { id: active.id } : null);
  window.answerPendingChoice = (text) => {
    if (!active) return false;
    answer([], text);
    return true;
  };
})();

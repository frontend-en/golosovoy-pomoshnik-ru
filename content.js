(() => {
  if (globalThis.__RU_VOICE_ASSISTANT_LOADED__) return;
  globalThis.__RU_VOICE_ASSISTANT_LOADED__ = true;

  let recognition = null;
  let dictationTarget = null;
  let overlay = null;
  let inputPosition = null;
  let contentRange = null;
  let pendingFinal = "";
  let pendingInterim = "";
  let commitPendingOnEnd = false;
  let recognitionHadError = false;
  let stopRequested = false;
  let pushToTalkActive = false;
  const settings = {
    voiceCommands: true,
    pushToTalk: true
  };

  chrome.storage.sync.get(settings).then((stored) => Object.assign(settings, stored));
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (changes.voiceCommands) settings.voiceCommands = changes.voiceCommands.newValue;
    if (changes.pushToTalk) settings.pushToTalk = changes.pushToTalk.newValue;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && recognition) {
      pushToTalkActive = false;
      stopDictation();
      return;
    }

    const isModifier = event.key === "Control" || event.key === "Alt";
    if (
      settings.pushToTalk &&
      isModifier &&
      event.ctrlKey &&
      event.altKey &&
      !pushToTalkActive &&
      !event.repeat
    ) {
      pushToTalkActive = true;
      startDictation({ target: event.target, pushToTalk: true }).then((result) => {
        if (!result.ok) pushToTalkActive = false;
      });
    }
  }, true);

  document.addEventListener("keyup", (event) => {
    if (pushToTalkActive && (!event.ctrlKey || !event.altKey)) {
      pushToTalkActive = false;
      stopDictation({ commitPending: true });
    }
  }, true);

  window.addEventListener("blur", () => {
    if (!pushToTalkActive) return;
    pushToTalkActive = false;
    stopDictation({ commitPending: true });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_SELECTION") {
      sendResponse({ ok: true, text: getSelectedText() });
      return;
    }
    if (message?.type === "START_DICTATION") {
      startDictation().then(sendResponse);
      return true;
    }
    if (message?.type === "STOP_DICTATION") {
      stopDictation();
      sendResponse({ ok: true });
    }
  });

  function getSelectedText() {
    const active = document.activeElement;
    if (isTextInput(active) && active.selectionStart !== active.selectionEnd) {
      return active.value.slice(active.selectionStart, active.selectionEnd).trim();
    }
    return String(window.getSelection() || "").trim();
  }

  async function startDictation({ target = document.activeElement, pushToTalk = false } = {}) {
    if (recognition) {
      if (pushToTalk) {
        return { ok: false, error: "Диктовка уже запущена" };
      }
      stopDictation();
      return { ok: true };
    }

    dictationTarget = findEditableTarget(target) || findEditableTarget(document.activeElement);
    if (!dictationTarget) {
      showToast("Поставьте курсор в обычное текстовое поле", "error");
      return { ok: false, error: "Не найдено активное поле ввода" };
    }

    if (dictationTarget instanceof HTMLInputElement && dictationTarget.type === "password") {
      showToast("Диктовка в поле пароля отключена", "error");
      return { ok: false, error: "Диктовка в поле пароля запрещена" };
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      showToast("Эта версия Chrome не поддерживает распознавание речи", "error");
      return { ok: false, error: "Speech Recognition API недоступен" };
    }

    captureInsertionPoint();
    pendingFinal = "";
    pendingInterim = "";
    commitPendingOnEnd = pushToTalk;
    recognitionHadError = false;
    stopRequested = false;
    const activeRecognition = new Recognition();
    recognition = activeRecognition;
    activeRecognition.lang = "ru-RU";
    activeRecognition.continuous = true;
    activeRecognition.interimResults = true;
    activeRecognition.maxAlternatives = 1;

    activeRecognition.onstart = () => {
      const subtitle = pushToTalk
        ? "Отпустите Ctrl или Alt — вставить текст"
        : "Говорите по-русски";
      showDictationOverlay("Слушаю…", subtitle);
      chrome.runtime.sendMessage({ type: "DICTATION_STATE", status: "listening" }).catch(() => {});
    };

    activeRecognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0].transcript;
        if (event.results[index].isFinal) finalText += transcript;
        else interimText += transcript;
      }

      pendingInterim = interimText.trim();
      const subtitle = pushToTalk ? "Отпустите клавиши — вставить" : "Esc — остановить";
      updateDictationOverlay(interimText || "Слушаю…", finalText ? "Добавляю текст" : subtitle);
      if (finalText) {
        if (pushToTalk) {
          pendingFinal = `${pendingFinal} ${finalText}`.trim();
        } else {
          const normalized = settings.voiceCommands ? applyVoiceCommands(finalText) : finalText.trim();
          insertText(normalized);
        }
      }
    };

    activeRecognition.onerror = (event) => {
      if (event.error === "aborted") return;
      recognitionHadError = true;
      const errors = {
        "not-allowed": "Разрешите Chrome доступ к микрофону",
        "audio-capture": "Микрофон не найден или занят",
        "network": "Для распознавания нужен интернет",
        "no-speech": "Речь не распознана"
      };
      const message = errors[event.error] || `Ошибка распознавания: ${event.error}`;
      showToast(message, "error");
      chrome.runtime.sendMessage({
        type: "DICTATION_STATE",
        status: "idle",
        error: message
      }).catch(() => {});
    };

    activeRecognition.onend = () => {
      const pendingText = pushToTalk
        ? `${pendingFinal} ${pendingInterim}`.trim()
        : pendingInterim;
      if (commitPendingOnEnd && pendingText && !recognitionHadError) {
        const normalized = settings.voiceCommands
          ? applyVoiceCommands(pendingText)
          : pendingText.trim();
        insertText(normalized);
      }
      pendingFinal = "";
      pendingInterim = "";
      if (recognition === activeRecognition) recognition = null;
      stopRequested = false;
      pushToTalkActive = false;
      removeOverlay();
      chrome.runtime.sendMessage({ type: "DICTATION_STATE", status: "idle" }).catch(() => {});
    };

    try {
      activeRecognition.start();
      return { ok: true };
    } catch (error) {
      recognition = null;
      showToast("Не удалось запустить микрофон", "error");
      return { ok: false, error: error.message };
    }
  }

  function stopDictation({ commitPending = true } = {}) {
    if (!recognition || stopRequested) return;
    stopRequested = true;
    commitPendingOnEnd = commitPending;
    updateDictationOverlay("Обрабатываю…", "Вставляю распознанный текст");
    try {
      recognition.stop();
    } catch {
      commitPendingOnEnd = false;
      recognition.abort();
    }
  }

  function findEditableTarget(element) {
    if (!element) return null;
    if (isTextInput(element) || element.isContentEditable) return element;
    return element.closest?.("[contenteditable='true']") || null;
  }

  function isTextInput(element) {
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    return ["text", "search", "email", "url", "tel", "password"].includes(element.type);
  }

  function captureInsertionPoint() {
    dictationTarget.focus();
    if (isTextInput(dictationTarget)) {
      inputPosition = {
        start: dictationTarget.selectionStart ?? dictationTarget.value.length,
        end: dictationTarget.selectionEnd ?? dictationTarget.value.length
      };
      contentRange = null;
      return;
    }

    const selection = window.getSelection();
    if (selection?.rangeCount && dictationTarget.contains(selection.anchorNode)) {
      contentRange = selection.getRangeAt(0).cloneRange();
    } else {
      contentRange = document.createRange();
      contentRange.selectNodeContents(dictationTarget);
      contentRange.collapse(false);
    }
    inputPosition = null;
  }

  function insertText(rawText) {
    if (!dictationTarget?.isConnected) {
      stopDictation();
      return;
    }
    const text = String(rawText || "").trim();
    if (!text) return;
    dictationTarget.focus();

    if (isTextInput(dictationTarget)) {
      const value = dictationTarget.value;
      const start = inputPosition?.start ?? value.length;
      const end = inputPosition?.end ?? start;
      const addition = addNaturalSpacing(value.slice(0, start), text);
      dictationTarget.setRangeText(addition, start, end, "end");
      inputPosition = {
        start: dictationTarget.selectionStart,
        end: dictationTarget.selectionEnd
      };
      dictationTarget.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: addition
      }));
      return;
    }

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(contentRange);
    const before = contentRange.startContainer.textContent?.slice(0, contentRange.startOffset) || "";
    const addition = addNaturalSpacing(before, text);
    contentRange.deleteContents();
    const node = document.createTextNode(addition);
    contentRange.insertNode(node);
    contentRange.setStartAfter(node);
    contentRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(contentRange);
    dictationTarget.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: addition
    }));
  }

  function addNaturalSpacing(before, text) {
    if (!before || /[\s\n]$/.test(before) || /^[,.:;!?\n]/.test(text)) return text;
    return ` ${text}`;
  }

  function applyVoiceCommands(text) {
    return text
      .trim()
      .replace(/(?<![\p{L}\p{N}_])новая строка(?![\p{L}\p{N}_])/giu, "\n")
      .replace(/(?<![\p{L}\p{N}_])вопросительный знак(?![\p{L}\p{N}_])/giu, "?")
      .replace(/(?<![\p{L}\p{N}_])восклицательный знак(?![\p{L}\p{N}_])/giu, "!")
      .replace(/(?<![\p{L}\p{N}_])двоеточие(?![\p{L}\p{N}_])/giu, ":")
      .replace(/(?<![\p{L}\p{N}_])точка с запятой(?![\p{L}\p{N}_])/giu, ";")
      .replace(/(?<![\p{L}\p{N}_])запятая(?![\p{L}\p{N}_])/giu, ",")
      .replace(/(?<![\p{L}\p{N}_])точка(?![\p{L}\p{N}_])/giu, ".")
      .replace(/\s+([,.:;!?])/g, "$1")
      .replace(/[ \t]*\n[ \t]*/g, "\n");
  }

  function showDictationOverlay(title, subtitle) {
    removeOverlay();
    overlay = document.createElement("div");
    overlay.setAttribute("role", "status");
    overlay.style.cssText = [
      "position:fixed", "right:20px", "bottom:20px", "z-index:2147483647",
      "display:flex", "align-items:center", "gap:12px", "max-width:360px",
      "padding:12px 14px", "border:1px solid rgba(255,255,255,.16)",
      "border-radius:14px", "background:#111827", "color:#fff",
      "box-shadow:0 14px 38px rgba(0,0,0,.32)",
      "font:13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif"
    ].join(";");
    overlay.innerHTML = `
      <span data-rva-dot style="width:12px;height:12px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 5px rgba(239,68,68,.18);flex:none"></span>
      <span style="min-width:0;flex:1">
        <strong data-rva-title style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></strong>
        <small data-rva-subtitle style="display:block;color:#9ca3af;margin-top:2px"></small>
      </span>
      <button data-rva-stop type="button" style="border:0;border-radius:9px;background:#374151;color:#fff;padding:7px 10px;cursor:pointer">Стоп</button>`;
    document.documentElement.appendChild(overlay);
    overlay.querySelector("[data-rva-stop]").addEventListener("click", stopDictation);
    updateDictationOverlay(title, subtitle);
  }

  function updateDictationOverlay(title, subtitle) {
    if (!overlay) return;
    overlay.querySelector("[data-rva-title]").textContent = title;
    overlay.querySelector("[data-rva-subtitle]").textContent = subtitle;
  }

  function removeOverlay() {
    overlay?.remove();
    overlay = null;
  }

  function showToast(text, type = "info") {
    const toast = document.createElement("div");
    toast.textContent = text;
    toast.style.cssText = [
      "position:fixed", "right:20px", "bottom:20px", "z-index:2147483647",
      "max-width:360px", "padding:12px 14px", "border-radius:12px",
      `background:${type === "error" ? "#991b1b" : "#111827"}`,
      "color:#fff", "box-shadow:0 14px 38px rgba(0,0,0,.28)",
      "font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif"
    ].join(";");
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }
})();

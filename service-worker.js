const DEFAULT_SETTINGS = Object.freeze({
  rate: 1,
  pitch: 1,
  volume: 1,
  voiceName: "",
  voiceCommands: true,
  pushToTalk: true
});

const MENU = Object.freeze({
  ROOT: "voice-root",
  READ: "voice-read",
  PAUSE: "voice-pause",
  STOP: "voice-stop",
  DICTATE: "voice-dictate",
  STOP_DICTATION: "voice-stop-dictation"
});

const initialState = {
  ttsStatus: "idle",
  dictationStatus: "idle",
  currentText: "",
  dictationTabId: null,
  dictationFrameId: null,
  error: ""
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(existing);
  await chrome.storage.session.set(initialState);
  await createContextMenus();
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await createContextMenus();
  await chrome.storage.session.set(initialState);
  await updateBadge();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.dictationTabId === tabId) {
    await setState({ dictationStatus: "idle", dictationTabId: null, dictationFrameId: null });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  const state = await getState();
  if (state.dictationTabId === tabId) {
    await setState({ dictationStatus: "idle", dictationTabId: null, dictationFrameId: null });
  }
});

async function createContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU.ROOT,
    title: "Голосовой помощник RU",
    contexts: ["all"]
  });
  chrome.contextMenus.create({
    id: MENU.READ,
    parentId: MENU.ROOT,
    title: "▶ Озвучить выделенное",
    contexts: ["selection"]
  });
  chrome.contextMenus.create({
    id: MENU.DICTATE,
    parentId: MENU.ROOT,
    title: "🎙 Начать диктовку сюда",
    contexts: ["editable"]
  });
  chrome.contextMenus.create({
    id: MENU.PAUSE,
    parentId: MENU.ROOT,
    title: "⏯ Пауза / продолжить",
    contexts: ["all"]
  });
  chrome.contextMenus.create({
    id: MENU.STOP,
    parentId: MENU.ROOT,
    title: "■ Остановить озвучивание",
    contexts: ["all"]
  });
  chrome.contextMenus.create({
    id: MENU.STOP_DICTATION,
    parentId: MENU.ROOT,
    title: "⏹ Остановить диктовку",
    contexts: ["all"]
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab?.id;
  if (info.menuItemId === MENU.READ && info.selectionText) {
    if (tabId) await ensurePageHelper(tabId, info.frameId);
    await speakText(info.selectionText);
    return;
  }

  if (info.menuItemId === MENU.PAUSE) {
    await toggleSpeechPause();
    return;
  }

  if (info.menuItemId === MENU.STOP) {
    await stopSpeech();
    return;
  }

  if (info.menuItemId === MENU.DICTATE && tabId) {
    await startDictation(tabId, info.frameId);
    return;
  }

  if (info.menuItemId === MENU.STOP_DICTATION) {
    await stopDictation();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === "read-selection") {
    const ready = await ensurePageHelper(tab.id);
    if (!ready) return;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_SELECTION" });
      if (response?.text) await speakText(response.text);
      else await setError("Сначала выделите текст на странице");
    } catch {
      await setError("На этой странице расширение недоступно");
    }
  }

  if (command === "toggle-dictation") {
    const state = await getState();
    if (state.dictationStatus === "listening") await stopDictation();
    else await startDictation(tab.id);
  }

  if (command === "stop-all") {
    await stopSpeech();
    await stopDictation();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "SPEAK_TEXT":
      await speakText(message.text);
      return { ok: true };
    case "TOGGLE_SPEECH_PAUSE":
      await toggleSpeechPause();
      return { ok: true };
    case "STOP_SPEECH":
      await stopSpeech();
      return { ok: true };
    case "START_DICTATION": {
      const tabId = message.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: "Нет активной вкладки" };
      return { ok: await startDictation(tabId, message.frameId) };
    }
    case "STOP_DICTATION":
      await stopDictation();
      return { ok: true };
    case "SELECTION_CHANGED":
      // Старые скрипты в открытых вкладках могут отправлять эти сообщения.
      // Смена выделения больше не влияет на озвучивание.
      return { ok: true };
    case "DICTATION_STATE":
      await setState({
        dictationStatus: message.status || "idle",
        dictationTabId: message.status === "listening" ? sender.tab?.id ?? null : null,
        dictationFrameId: message.status === "listening" ? sender.frameId ?? 0 : null,
        error: message.error || ""
      });
      return { ok: true };
    case "GET_STATE":
      return { ok: true, state: await getState() };
    default:
      return { ok: false, error: "Неизвестная команда" };
  }
}

async function speakText(rawText) {
  const text = cleanText(rawText);
  if (!text) {
    await setError("Нет текста для озвучивания");
    return;
  }

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  chrome.tts.stop();
  await setState({ ttsStatus: "speaking", currentText: text, error: "" });

  const options = {
    lang: "ru-RU",
    rate: Number(settings.rate),
    pitch: Number(settings.pitch),
    volume: Number(settings.volume),
    onEvent: async (event) => {
      if (event.type === "start") {
        await setState({ ttsStatus: "speaking", error: "" });
      }
      if (event.type === "pause") await setState({ ttsStatus: "paused" });
      if (event.type === "resume") await setState({ ttsStatus: "speaking" });
      if (["end", "interrupted", "cancelled"].includes(event.type)) {
        await setState({ ttsStatus: "idle", currentText: "" });
      }
      if (event.type === "error") {
        await setState({
          ttsStatus: "idle",
          currentText: "",
          error: event.errorMessage || "Ошибка синтеза речи"
        });
      }
    }
  };

  if (settings.voiceName) options.voiceName = settings.voiceName;

  try {
    await chrome.tts.speak(text.slice(0, 32768), options);
  } catch (error) {
    await setState({
      ttsStatus: "idle",
      currentText: "",
      error: error.message || "Не удалось запустить озвучивание"
    });
  }
}

async function toggleSpeechPause() {
  const state = await getState();
  if (state.ttsStatus === "paused") {
    chrome.tts.resume();
    await setState({ ttsStatus: "speaking", error: "" });
    return;
  }
  if (state.ttsStatus === "speaking") {
    chrome.tts.pause();
    await setState({ ttsStatus: "paused", error: "" });
  }
}

async function stopSpeech() {
  chrome.tts.stop();
  await setState({ ttsStatus: "idle", currentText: "", error: "" });
}

async function startDictation(tabId, frameId) {
  const ready = await ensurePageHelper(tabId, frameId);
  if (!ready) return false;
  await stopDictation();
  try {
    const response = await sendToTab(tabId, { type: "START_DICTATION" }, frameId);
    if (!response?.ok) await setError(response?.error || "Не удалось включить диктовку");
    return Boolean(response?.ok);
  } catch {
    await setError("Диктовка недоступна на этой странице");
    return false;
  }
}

async function stopDictation() {
  const state = await getState();
  if (state.dictationTabId) {
    try {
      const options = Number.isInteger(state.dictationFrameId)
        ? { frameId: state.dictationFrameId }
        : {};
      await chrome.tabs.sendMessage(
        state.dictationTabId,
        { type: "STOP_DICTATION" },
        options
      );
    } catch {
      // Вкладка могла быть закрыта или перезагружена.
    }
  }
  await setState({ dictationStatus: "idle", dictationTabId: null, dictationFrameId: null });
}

async function ensurePageHelper(tabId, frameId) {
  try {
    const target = { tabId };
    if (Number.isInteger(frameId)) target.frameIds = [frameId];
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
    return true;
  } catch {
    await setError("Chrome запрещает расширениям работать на этой странице");
    return false;
  }
}

async function sendToTab(tabId, message, frameId) {
  const options = Number.isInteger(frameId) ? { frameId } : {};
  return chrome.tabs.sendMessage(tabId, message, options);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function getState() {
  return chrome.storage.session.get(initialState);
}

async function setState(patch) {
  await chrome.storage.session.set(patch);
  await updateBadge();
}

async function setError(error) {
  await setState({ error });
}

async function updateBadge() {
  const state = await getState();
  let text = "";
  let color = "#2563EB";
  if (state.dictationStatus === "listening") {
    text = "REC";
    color = "#DC2626";
  } else if (state.ttsStatus === "paused") {
    text = "Ⅱ";
    color = "#D97706";
  } else if (state.ttsStatus === "speaking") {
    text = "▶";
  }
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

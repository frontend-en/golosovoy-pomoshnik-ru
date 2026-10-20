const DEFAULTS = {
  rate: 1,
  pitch: 1,
  volume: 1,
  voiceName: "",
  voiceCommands: true,
  pushToTalk: true
};

const elements = {
  status: document.querySelector("#status"),
  voice: document.querySelector("#voice"),
  rate: document.querySelector("#rate"),
  rateValue: document.querySelector("#rate-value"),
  pitch: document.querySelector("#pitch"),
  pitchValue: document.querySelector("#pitch-value"),
  voiceCommands: document.querySelector("#voice-commands"),
  pushToTalk: document.querySelector("#push-to-talk"),
  test: document.querySelector("#test"),
  pause: document.querySelector("#pause"),
  stop: document.querySelector("#stop"),
  dictate: document.querySelector("#dictate"),
  stopDictation: document.querySelector("#stop-dictation")
};

init();

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  elements.rate.value = settings.rate;
  elements.pitch.value = settings.pitch;
  elements.voiceCommands.checked = settings.voiceCommands;
  elements.pushToTalk.checked = settings.pushToTalk;
  updateRangeLabels();
  await loadVoices(settings.voiceName);
  await refreshStatus();
}

async function loadVoices(selectedName) {
  const voices = await chrome.tts.getVoices();
  const russian = voices.filter((voice) => voice.lang?.toLowerCase().startsWith("ru"));
  const other = voices.filter((voice) => !voice.lang?.toLowerCase().startsWith("ru"));

  appendVoiceGroup("Русские голоса Windows", russian);
  if (other.length) appendVoiceGroup("Другие установленные голоса", other);
  elements.voice.value = selectedName;
  if (selectedName && !elements.voice.value) {
    elements.voice.value = "";
    await chrome.storage.sync.set({ voiceName: "" });
  }
}

function appendVoiceGroup(label, voices) {
  if (!voices.length) return;
  const group = document.createElement("optgroup");
  group.label = label;
  for (const voice of voices) {
    const option = document.createElement("option");
    option.value = voice.voiceName || "";
    option.textContent = `${voice.voiceName || "Без названия"} · ${voice.lang || "?"}${voice.remote ? " · онлайн" : ""}`;
    group.appendChild(option);
  }
  elements.voice.appendChild(group);
}

elements.voice.addEventListener("change", () => save({ voiceName: elements.voice.value }));
elements.rate.addEventListener("input", () => {
  updateRangeLabels();
  save({ rate: Number(elements.rate.value) });
});
elements.pitch.addEventListener("input", () => {
  updateRangeLabels();
  save({ pitch: Number(elements.pitch.value) });
});
elements.voiceCommands.addEventListener("change", () => save({ voiceCommands: elements.voiceCommands.checked }));
elements.pushToTalk.addEventListener("change", () => save({ pushToTalk: elements.pushToTalk.checked }));

elements.test.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "SPEAK_TEXT",
    text: "Привет! Я готова озвучивать русский текст с выбранной скоростью."
  });
  await refreshStatus();
});

elements.pause.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "TOGGLE_SPEECH_PAUSE" });
  await refreshStatus();
});

elements.stop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_SPEECH" });
  await refreshStatus();
});

elements.dictate.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const response = await chrome.runtime.sendMessage({ type: "START_DICTATION", tabId: tab?.id });
  if (!response?.ok) showLocalStatus(response?.error || "Не удалось начать диктовку", "error");
  else showLocalStatus("Диктовка включена — вернитесь на страницу", "active");
});

elements.stopDictation.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_DICTATION" });
  await refreshStatus();
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === "session") refreshStatus();
});

async function save(patch) {
  await chrome.storage.sync.set(patch);
  showLocalStatus("Настройки сохранены", "");
}

function updateRangeLabels() {
  elements.rateValue.textContent = `${Number(elements.rate.value).toFixed(1)}×`;
  elements.pitchValue.textContent = Number(elements.pitch.value).toFixed(1);
}

async function refreshStatus() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  const state = response?.state;
  if (!state) return;
  if (state.error) return showLocalStatus(state.error, "error");
  if (state.dictationStatus === "listening") return showLocalStatus("Микрофон слушает", "active");
  if (state.ttsStatus === "paused") return showLocalStatus("Озвучивание на паузе", "active");
  if (state.ttsStatus === "speaking") return showLocalStatus("Читаю текст в фоне", "active");
  showLocalStatus("Готов к работе", "");
}

function showLocalStatus(text, className) {
  elements.status.textContent = text;
  elements.status.className = `status ${className}`.trim();
}

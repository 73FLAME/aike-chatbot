import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

// ---------- Persisted settings ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
// NOTE: localStorage is fine here — this is a plain static site (not a claude.ai artifact),
// deployed on GitHub Pages, so browser storage works normally.

const state = {
  groqKey: store.get("groqKey", ""),
  groqModel: store.get("groqModel", "llama-3.3-70b-versatile"),
  charName: store.get("charName", "Yuki"),
  persona: store.get("persona", "You are a warm, playful companion who chats casually and briefly, like a close friend texting. Keep replies short (1-3 sentences) unless asked for more."),
  ttsOn: store.get("ttsOn", true),
  vrmDataUrl: store.get("vrmDataUrl", null), // small models only; large ones stay session-only
};

const history = []; // {role, content}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const setupPanel = $("setup");
const settingsBtn = $("settingsBtn");
const saveBtn = $("saveBtn");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const log = $("log");
const charname = $("charname");
const statusEl = $("status");
const ring = $("ring");
const vrmFileInput = $("vrmFile");

function openSetup() { setupPanel.classList.add("open"); }
function closeSetup() { setupPanel.classList.remove("open"); }

settingsBtn.onclick = openSetup;

function hydrateSetupForm() {
  $("groqKey").value = state.groqKey;
  $("groqModel").value = state.groqModel;
  $("charNameInput").value = state.charName;
  $("personaInput").value = state.persona;
  $("ttsToggle").checked = state.ttsOn;
  charname.textContent = state.charName;
}
hydrateSetupForm();

if (!state.groqKey) openSetup();

let pendingVrmFile = null;
vrmFileInput.onchange = (e) => { pendingVrmFile = e.target.files[0] || null; };

saveBtn.onclick = async () => {
  state.groqKey = $("groqKey").value.trim();
  state.groqModel = $("groqModel").value.trim() || "llama-3.3-70b-versatile";
  state.charName = $("charNameInput").value.trim() || "Companion";
  state.persona = $("personaInput").value.trim();
  state.ttsOn = $("ttsToggle").checked;
  store.set("groqKey", state.groqKey);
  store.set("groqModel", state.groqModel);
  store.set("charName", state.charName);
  store.set("persona", state.persona);
  store.set("ttsOn", state.ttsOn);
  charname.textContent = state.charName;

  if (pendingVrmFile) {
    $("setupError").textContent = "Loading avatar...";
    try {
      const buf = await pendingVrmFile.arrayBuffer();
      await loadVrmFromArrayBuffer(buf.slice(0));
      $("setupError").textContent = "";
    } catch (err) {
      $("setupError").textContent = "Couldn't load that VRM file: " + err.message;
      return;
    }
  }

  if (!state.groqKey) {
    $("setupError").textContent = "Add a Groq API key to start chatting.";
    return;
  }
  closeSetup();
};

// ---------- Three.js / VRM scene ----------
const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, window.innerWidth / window.innerHeight, 0.1, 20);
camera.position.set(0, 1.35, 2.2);

const light1 = new THREE.DirectionalLight(0xffffff, 1.2);
light1.position.set(1, 2, 2);
scene.add(light1);
scene.add(new THREE.AmbientLight(0x8b7fd6, 0.6));

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let currentVrm = null;
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

async function loadVrmFromArrayBuffer(arrayBuffer) {
  return new Promise((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      "",
      (gltf) => {
        const vrm = gltf.userData.vrm;
        if (currentVrm) {
          scene.remove(currentVrm.scene);
          VRMUtils.deepDispose(currentVrm.scene);
        }
        VRMUtils.rotateVRM0(vrm); // face camera if old VRM0 export
        vrm.scene.rotation.y = Math.PI; // most VRM face -Z; rotate to face camera
        scene.add(vrm.scene);
        currentVrm = vrm;
        resolve(vrm);
      },
      (err) => reject(err)
    );
  });
}

// idle animation: gentle breathing sway + blink
let blinkTimer = 0;
let nextBlinkAt = 2 + Math.random() * 3;
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();

  if (currentVrm) {
    // idle sway (breathing)
    const chest = currentVrm.humanoid?.getNormalizedBoneNode("chest");
    if (chest) chest.rotation.x = Math.sin(t * 1.2) * 0.02;
    const head = currentVrm.humanoid?.getNormalizedBoneNode("head");
    if (head) head.rotation.y = Math.sin(t * 0.4) * 0.05;

    // blink
    blinkTimer += dt;
    if (blinkTimer > nextBlinkAt) {
      blinkTimer = 0;
      nextBlinkAt = 2 + Math.random() * 3;
      blink();
    }

    decayExpression(dt);
    currentVrm.update(dt);
  }

  renderer.render(scene, camera);
}
animate();

function blink() {
  if (!currentVrm?.expressionManager) return;
  const em = currentVrm.expressionManager;
  let v = 0;
  const start = performance.now();
  const dur = 140;
  function step() {
    const p = (performance.now() - start) / dur;
    if (p >= 1) { em.setValue("blink", 0); return; }
    v = p < 0.5 ? p * 2 : (1 - p) * 2;
    em.setValue("blink", v);
    requestAnimationFrame(step);
  }
  step();
}

// ---------- Emotion -> VRM expression mapping ----------
const EXPR_MAP = {
  happy: "happy",
  sad: "sad",
  angry: "angry",
  surprised: "surprised",
  relaxed: "relaxed",
  neutral: "neutral",
};
let currentExpression = null;
let expressionHoldUntil = 0;

function applyExpression(tag) {
  if (!currentVrm?.expressionManager) return;
  const em = currentVrm.expressionManager;
  const name = EXPR_MAP[tag] || "neutral";
  if (currentExpression && currentExpression !== name) em.setValue(currentExpression, 0);
  em.setValue(name, 1);
  currentExpression = name;
  expressionHoldUntil = performance.now() + 4000;
}

function decayExpression(dt) {
  if (!currentVrm?.expressionManager || !currentExpression) return;
  if (performance.now() > expressionHoldUntil && currentExpression !== "neutral") {
    currentVrm.expressionManager.setValue(currentExpression, 0);
    currentExpression = null;
  }
}

// simple mouth-flap while audio plays (crude lipsync)
let talkInterval = null;
function startTalking() {
  if (!currentVrm?.expressionManager) return;
  stopTalking();
  const em = currentVrm.expressionManager;
  talkInterval = setInterval(() => {
    em.setValue("aa", Math.random() * 0.6 + 0.2);
  }, 90);
}
function stopTalking() {
  if (talkInterval) clearInterval(talkInterval);
  talkInterval = null;
  currentVrm?.expressionManager?.setValue("aa", 0);
}

// ---------- Chat log UI ----------
function appendMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "user" : "bot");
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ---------- Groq chat ----------
async function askGroq(userText) {
  const sys = `${state.persona}\n\nStart every reply with exactly one emotion tag from this list in square brackets: [happy] [sad] [angry] [surprised] [relaxed] [neutral]. Example: "[happy] That sounds fun!"`;
  const messages = [
    { role: "system", content: sys },
    ...history,
    { role: "user", content: userText },
  ];

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.groqKey}`,
    },
    body: JSON.stringify({
      model: state.groqModel,
      messages,
      temperature: 0.8,
      max_tokens: 300,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq API error (${res.status}): ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "...";
}

function parseEmotion(text) {
  const m = text.match(/^\s*\[(\w+)\]\s*/);
  if (m) return { tag: m[1].toLowerCase(), clean: text.slice(m[0].length).trim() };
  return { tag: "neutral", clean: text };
}

// ---------- Kokoro TTS (loaded lazily, runs fully in-browser) ----------
let ttsEngine = null;
let ttsLoading = null;

async function getTts() {
  if (ttsEngine) return ttsEngine;
  if (ttsLoading) return ttsLoading;
  statusEl.textContent = "loading voice model...";
  ttsLoading = (async () => {
    const { KokoroTTS } = await import("kokoro-js");
    const engine = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8",
      device: "wasm",
    });
    ttsEngine = engine;
    statusEl.textContent = "";
    return engine;
  })().catch((err) => {
    console.error("Kokoro load failed", err);
    statusEl.textContent = "voice model unavailable (text-only)";
    ttsLoading = null;
    throw err;
  });
  return ttsLoading;
}

function rawAudioToWavBlob(raw) {
  // Fallback WAV encoder for the transformers.js RawAudio shape:
  // { audio: Float32Array (mono, -1..1), sampling_rate: number }
  const samples = raw.audio;
  const sr = raw.sampling_rate;
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function speak(text) {
  if (!state.ttsOn || !text) return;
  try {
    const tts = await getTts();
    const raw = await tts.generate(text, { voice: "af_heart" });
    let blob;
    if (typeof raw.toBlob === "function") {
      blob = await raw.toBlob();
    } else {
      blob = rawAudioToWavBlob(raw);
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    ring.classList.add("speaking");
    startTalking();
    audio.onended = audio.onerror = () => {
      ring.classList.remove("speaking");
      stopTalking();
      URL.revokeObjectURL(url);
    };
    await audio.play();
  } catch (err) {
    console.warn("Kokoro TTS failed, falling back to browser speech synthesis", err);
    fallbackSpeak(text);
  }
}

function fallbackSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  ring.classList.add("speaking");
  startTalking();
  u.onend = u.onerror = () => { ring.classList.remove("speaking"); stopTalking(); };
  speechSynthesis.speak(u);
}

// ---------- Chat submit ----------
chatForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  if (!state.groqKey) { openSetup(); return; }

  chatInput.value = "";
  appendMsg("user", text);
  history.push({ role: "user", content: text });
  statusEl.textContent = "thinking...";

  try {
    const reply = await askGroq(text);
    const { tag, clean } = parseEmotion(reply);
    applyExpression(tag);
    appendMsg("bot", clean);
    history.push({ role: "assistant", content: reply });
    if (history.length > 20) history.splice(0, history.length - 20);
    statusEl.textContent = "";
    speak(clean);
  } catch (err) {
    console.error(err);
    appendMsg("bot", "(trouble reaching Groq — check your API key / connection)");
    statusEl.textContent = "error";
  }
};

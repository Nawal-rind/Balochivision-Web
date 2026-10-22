const $ = (id) => document.getElementById(id);
const MAX_BYTES = 25 * 1024 * 1024;

const el = {
  drop: $("drop"), input: $("fileInput"), dropInner: $("dropInner"), preview: $("preview"),
  fileLine: $("fileLine"), fileName: $("fileName"), clear: $("clearBtn"),
  run: $("runBtn"), runLabel: $("runLabel"), cancel: $("cancelBtn"),
  progress: $("progress"), bar: $("bar"), fill: $("fill"), pLabel: $("pLabel"), pTime: $("pTime"), pNote: $("pNote"),
  alert: $("alert"), result: $("result"),
  copy: $("copyBtn"), copyLabel: $("copyLabel"), txt: $("txtBtn"), docx: $("docxBtn"), docxLabel: $("docxLabel"),
  fontSel: $("fontSel"), fMinus: $("fMinus"), fPlus: $("fPlus"),
  status: $("status"), statusText: $("statusText"),
  modal: $("modal"), apiInput: $("apiInput"), apiMsg: $("apiMsg"),
};

let apiBase = (sessionStorage.getItem("bs_api") || window.BS_API || "").trim().replace(/\/+$/, "");
let file = null, previewUrl = null, pages = [], total = 0;
let controller = null, timer = null, startedAt = 0, running = false;
let fontSize = 26;

/* ---------- helpers ---------- */
const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const baseName = () => (file ? file.name.replace(/\.[^.]+$/, "") : "balochi-text");
const allText = () => pages.filter((p) => p && p.text).map((p) => p.text.trim()).join("\n\n");

function showAlert(node, msg, ok = false) {
  node.textContent = msg;
  node.classList.toggle("ok", ok);
  node.hidden = false;
}
const hideAlert = (node) => (node.hidden = true);

async function fetchT(url, opts = {}, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}

/* ---------- server status ---------- */
async function checkHealth() {
  if (!apiBase) return setStatus("offline", "No API URL set");
  try {
    const r = await fetchT(apiBase + "/health", {}, 8000);
    if (!r.ok) throw new Error("bad status " + r.status);
    const j = await r.json();
    if (j.model_loaded) setStatus("online", "Server online");
    else setStatus("loading", "Model loading…");
    return !!j.model_loaded;
  } catch {
    setStatus("waking", "Server waking up / offline");
    return false;
  }
}
function setStatus(state, text) {
  el.status.dataset.state = state;
  el.statusText.textContent = text;
}

async function waitForServer(maxSeconds = 420) {
  const end = Date.now() + maxSeconds * 1000;
  while (Date.now() < end) {
    if (controller && controller.signal.aborted) throw new Error("cancelled");
    if (await checkHealth()) return true;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/* ---------- file handling ---------- */
function setFile(f) {
  hideAlert(el.alert);
  if (!f) return;
  const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const isImg = f.type.startsWith("image/");
  if (!isPdf && !isImg) return showAlert(el.alert, "Unsupported file. Please upload an image or a PDF.");
  if (f.size > MAX_BYTES) return showAlert(el.alert, "File is larger than 25 MB. Please use a smaller file.");

  clearFile(true);
  file = f;
  previewUrl = URL.createObjectURL(f);
  el.preview.innerHTML = "";
  if (isPdf) {
    const fr = document.createElement("iframe");
    fr.src = previewUrl + "#toolbar=0&navpanes=0";
    el.preview.appendChild(fr);
  } else {
    const im = document.createElement("img");
    im.src = previewUrl; im.alt = "Preview";
    el.preview.appendChild(im);
  }
  el.dropInner.hidden = true;
  el.preview.hidden = false;
  el.fileName.textContent = `${f.name} · ${(f.size / 1024 / 1024).toFixed(2)} MB`;
  el.fileLine.hidden = false;
  el.run.disabled = false;
}
function clearFile(keepResult = false) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  file = null; previewUrl = null;
  el.input.value = "";
  el.preview.hidden = true; el.preview.innerHTML = "";
  el.dropInner.hidden = false;
  el.fileLine.hidden = true;
  el.run.disabled = true;
  if (!keepResult) hideAlert(el.alert);
}

el.input.addEventListener("change", () => setFile(el.input.files[0]));
el.clear.addEventListener("click", (e) => { e.preventDefault(); if (!running) clearFile(); });
["dragenter", "dragover"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove("over"); }));
el.drop.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));
el.drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.input.click(); } });

/* ---------- rendering ---------- */
function render() {
  el.result.innerHTML = "";
  if (!total && !pages.length) {
    el.result.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg><p>Your text will appear here.</p></div>';
    return;
  }
  const n = Math.max(total, pages.length);
  for (let i = 0; i < n; i++) {
    const p = pages[i];
    if (!p) {
      const s = document.createElement("div");
      s.className = "skel";
      el.result.appendChild(s);
      continue;
    }
    const card = document.createElement("div");
    card.className = "page";
    const h = document.createElement("div");
    h.className = "page-h";
    h.innerHTML = `<span>Page ${i + 1}</span><span>${n > 1 ? `of ${n}` : ""}</span>`;
    const b = document.createElement("div");
    b.className = "page-b" + (p.error ? " err" : "");
    b.textContent = p.error ? "⚠ " + p.error : p.text || "(no text found)";
    card.append(h, b);
    el.result.appendChild(card);
  }
}
function updateButtons() {
  const has = allText().length > 0;
  el.copy.disabled = !has; el.txt.disabled = !has; el.docx.disabled = !has;
}

/* ---------- OCR run ---------- */
function setProgress(label, pct, note = "") {
  el.pLabel.textContent = label;
  el.pNote.textContent = note;
  if (pct === null) el.bar.classList.add("indet");
  else { el.bar.classList.remove("indet"); el.fill.style.width = pct + "%"; }
}

async function runOcr() {
  if (!file || running) return;
  if (!apiBase) { openModal(); return showAlert(el.alert, "Please set the API URL first (gear icon)."); }

  running = true; pages = []; total = 0;
  hideAlert(el.alert); render(); updateButtons();
  el.run.disabled = true; el.runLabel.textContent = "Working…";
  el.cancel.hidden = false; el.progress.hidden = false;
  controller = new AbortController();
  startedAt = Date.now();
  timer = setInterval(() => (el.pTime.textContent = fmtTime(Math.floor((Date.now() - startedAt) / 1000))), 500);

  try {
    setProgress("Server waking up…", null, "The GPU server may need up to a few minutes to start.");
    const ready = await waitForServer();
    if (!ready) throw new Error("The server did not respond. Check the API URL or make sure the backend is running.");

    setProgress("Reading your file…", null, "Each page can take 1–2 minutes on the GPU. Please keep this tab open.");
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(apiBase + "/ocr", { method: "POST", body: fd, signal: controller.signal });
    if (!r.ok) {
      let detail = "";
      try { const j = await r.json(); detail = j.detail || JSON.stringify(j); } catch { detail = await r.text().catch(() => ""); }
      throw new Error(`Server error ${r.status}${detail ? ": " + String(detail).slice(0, 200) : ""}`);
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder("utf-8");
    let buf = "", finished = false;

    const handle = (line) => {
      line = line.trim();
      if (!line) return;
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.done) { finished = true; return; }
      if (m.page) {
        total = m.total || total;
        pages[m.page - 1] = m.error ? { error: m.error } : { text: m.text || "" };
        const done = pages.filter(Boolean).length;
        setProgress(`Page ${done} of ${total} done`, Math.round((done / total) * 100),
          done < total ? "Reading the next page…" : "");
        render(); updateButtons();
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop();
      parts.forEach(handle);
    }
    handle(buf);

    if (!finished && !pages.length) throw new Error("The connection closed before any text was returned.");
    setProgress("Finished", 100, finished ? "" : "Connection ended early, some pages may be missing.");
    if (pages.some((p) => p && p.error)) showAlert(el.alert, "Some pages could not be read. See the details in the result panel.");
    else showAlert(el.alert, "Done. Please proofread the text before using it.", true);
  } catch (e) {
    if (e.name === "AbortError" || e.message === "cancelled") {
      showAlert(el.alert, "Cancelled.");
    } else {
      showAlert(el.alert, e.message || "Something went wrong.");
    }
    setProgress("Stopped", pages.length && total ? Math.round((pages.filter(Boolean).length / total) * 100) : 0);
  } finally {
    clearInterval(timer);
    running = false; controller = null;
    el.run.disabled = !file; el.runLabel.textContent = "Extract text";
    el.cancel.hidden = true;
    el.bar.classList.remove("indet");
    updateButtons();
  }
}
el.run.addEventListener("click", runOcr);
el.cancel.addEventListener("click", () => controller && controller.abort());

/* ---------- result actions ---------- */
el.copy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(allText()); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = allText(); document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  el.copy.classList.add("done"); el.copyLabel.textContent = "Copied!";
  setTimeout(() => { el.copy.classList.remove("done"); el.copyLabel.textContent = "Copy"; }, 1600);
});

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
el.txt.addEventListener("click", () => {
  saveBlob(new Blob(["\ufeff" + allText()], { type: "text/plain;charset=utf-8" }), baseName() + ".txt");
});
el.docx.addEventListener("click", async () => {
  const texts = pages.filter((p) => p && p.text).map((p) => p.text.trim());
  if (!texts.length) return;
  el.docx.disabled = true; el.docxLabel.textContent = "Building…";
  try {
    const r = await fetchT(apiBase + "/export/docx", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pages: texts }),
    }, 60000);
    if (!r.ok) throw new Error("Server error " + r.status);
    saveBlob(await r.blob(), baseName() + ".docx");
  } catch (e) {
    showAlert(el.alert, "Could not create the DOCX: " + (e.message || "server unreachable"));
  } finally {
    el.docxLabel.textContent = "DOCX"; updateButtons();
  }
});

/* ---------- font controls ---------- */
el.fontSel.addEventListener("change", () => el.result.classList.toggle("nastaliq", el.fontSel.value === "nastaliq"));
const applySize = () => document.documentElement.style.setProperty("--result-size", fontSize + "px");
el.fMinus.addEventListener("click", () => { fontSize = Math.max(16, fontSize - 2); applySize(); });
el.fPlus.addEventListener("click", () => { fontSize = Math.min(48, fontSize + 2); applySize(); });

/* ---------- settings modal ---------- */
function openModal() { el.apiInput.value = apiBase; hideAlert(el.apiMsg); el.modal.hidden = false; el.apiInput.focus(); }
function closeModal() { el.modal.hidden = true; }
$("settingsBtn").addEventListener("click", openModal);
$("closeModal").addEventListener("click", closeModal);
el.modal.addEventListener("click", (e) => { if (e.target === el.modal) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
$("saveApi").addEventListener("click", async () => {
  let v = el.apiInput.value.trim().replace(/\/+$/, "");
  if (v && !/^https?:\/\//i.test(v)) v = "https://" + v;
  apiBase = v;
  sessionStorage.setItem("bs_api", apiBase);
  showAlert(el.apiMsg, "Testing…", true);
  const ok = await checkHealth();
  if (ok) showAlert(el.apiMsg, "Connected. The model is loaded and ready.", true);
  else showAlert(el.apiMsg, "Could not reach a ready server at this URL. It may be waking up or the URL may be wrong.");
});

/* ---------- init ---------- */
render();
checkHealth();
setInterval(() => { if (!running) checkHealth(); }, 20000);
if (!apiBase) setTimeout(openModal, 600);
"use strict";

// หน้าเว็บรันจาก VS Code ได้ ใช้ Apps Script เป็นตัวกลาง ไม่มี Google OAuth บนหน้าเว็บ
const $ = (id) => document.getElementById(id);
const STORAGE = "berkdee.bridge.v1";

// ลิงก์เริ่มต้น เปลี่ยนได้จากหน้าตั้งค่า
const SHARED_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbzg6yxu0tWOqMJiyXPFkVLu680624tmT9BEwkqIR3Ja2IA1p7oW0GkwVRHtuV_UrvML/exec";
const APPROVED_ENDPOINTS = new Set([SHARED_ENDPOINT,
  "https://script.google.com/macros/s/AKfycbyyXOPUf94XA9-5sJIRNS2u-4nWSzt9QoFUpn13if2pHDdM1wJIPubjBuSVwEg9Qsih/exec"]);

let products = [];
let items = [];
let settings = null;
let saved = false;
let editing = false;
let savedRevision = "original";
let currentDocumentStatus = "จัดเตรียม";
let busy = false;
let pending = null;
let catalogLoaded = false;
let requestId = newId();
let selectedProduct = null;
let activeUser = null;
let preparationBusy = false;
let preparationRequests = [];
let appConfig = null;
let documentHistory = [];
let historyBusy = false;
let historyReloadQueued = false;
let displayedHistoryId = "";
let validationTarget = null;

function viewingHistoryDocument() {
  return !!displayedHistoryId && displayedHistoryId === requestId && (saved || editing || pending?.operation === "update");
}

function editableDocumentStatus(status) {
  return ["ขอเบิก", "รอเตรียม", "กำลังเตรียม", "จัดเตรียม", "กำลังจัดเตรียม", "อนุมัติ"].includes(String(status).trim());
}

function documentStage(status) {
  return editableDocumentStatus(status) ? "จัดเตรียม" : String(status).trim();
}

function bangkokToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok", calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function historyControls() {
  const locked = busy || !!pending || editing || historyBusy;
  for (const id of ["historySearch", "historyStatus", "historySelect", "historyRefreshBtn"]) $(id).disabled = locked;
}

function renderHistoryOptions() {
  const search = $("historySearch").value.trim().toLowerCase();
  const stage = $("historyStatus").value || "all";
  const select = $("historySelect");
  const selected = select.value || displayedHistoryId;
  const matches = documentHistory.filter((doc) => {
    const docStage = doc.stage || documentStage(doc.status);
    return (stage === "all" || (stage === "other" ? !["จัดเตรียม", "เตรียมส่งมอบ"].includes(docStage) : docStage === stage)) &&
      [doc.number, doc.requester, doc.department, doc.date].join(" ").toLowerCase().includes(search);
  });
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = matches.length ? "เลือกใบเบิกเพื่อดูรายการ" : "ไม่พบใบเบิกที่ตรงกับตัวกรอง";
  select.append(placeholder);
  for (const doc of matches) {
    const option = document.createElement("option");
    option.value = doc.requestId;
    option.textContent = [doc.number, doc.date, doc.requester, doc.stage || documentStage(doc.status)].filter(Boolean).join(" · ");
    select.append(option);
  }
  select.value = matches.some((doc) => doc.requestId === selected) ? selected : "";
}

async function loadRequisitionHistory(refreshAfterBusy = false) {
  if (historyBusy) {
    if (refreshAfterBusy) historyReloadQueued = true;
    return;
  }
  if (!settings || pending || editing) return;
  const source = { ...settings };
  const sameSource = () => settings?.id === source.id && settings?.endpoint === source.endpoint;
  historyBusy = true;
  historyControls();
  $("historyMessage").textContent = "กำลังโหลดใบเบิก…";
  try {
    const result = await readBridge(source, "documents");
    if (!Array.isArray(result.documents)) throw new Error("กรุณาอัปเดต Code.gs ให้รองรับการเลือกใบเบิกย้อนหลัง");
    if (!sameSource()) return;
    documentHistory = result.documents;
    const current = documentHistory.find((doc) => doc.requestId === requestId);
    if (saved && current && !editing && !pending) {
      currentDocumentStatus = current.status;
      state();
    }
    renderHistoryOptions();
    $("historyMessage").textContent = `พบ ${documentHistory.length} ใบเบิก · แก้ไขได้เฉพาะสถานะจัดเตรียม`;
  } catch (error) {
    if (!sameSource()) return;
    documentHistory = [];
    renderHistoryOptions();
    $("historyMessage").textContent = "โหลดใบเบิกไม่สำเร็จ: " + error.message;
  } finally {
    historyBusy = false;
    historyControls();
    if (!sameSource() || historyReloadQueued) {
      historyReloadQueued = false;
      loadRequisitionHistory();
    }
  }
}

function showSavedDocument(doc) {
  items = doc.items.map(({ barcode, name, qty, unit }) => ({ barcode, name, qty, unit }));
  for (const key of ["requester", "department", "date", "reason"]) $(key).value = doc[key] || "";
  requestId = doc.requestId;
  $("docno").value = doc.number;
  savedRevision = doc.revision;
  currentDocumentStatus = doc.status;
  displayedHistoryId = doc.requestId;
  $("results").replaceChildren();
  $("search").value = "";
}

async function loadSelectedRequisition() {
  if (busy || pending || editing || historyBusy) return;
  const id = $("historySelect").value;
  if (!id) return;
  if (!saved && items.length && !confirm("เปิดใบเบิกที่เลือกแทนรายการที่ยังไม่ได้บันทึกหรือไม่?")) {
    $("historySelect").value = displayedHistoryId;
    return;
  }
  busy = true;
  state();
  try {
    const result = await readBridge(settings, "document", { requestId: id });
    const doc = result.document;
    if (!doc || doc.requestId !== id || !Array.isArray(doc.items) || !doc.revision) throw new Error("ข้อมูลใบเบิกไม่ถูกต้อง");
    showSavedDocument(doc);
    saved = true;
    editing = false;
    $("historyMessage").textContent = `${doc.number} · ${documentStage(doc.status)} · ` +
      (editableDocumentStatus(doc.status) ? "กดแก้ไขรายการเพื่อเริ่มแก้ไข" : "ดูรายการได้ แต่ไม่สามารถแก้ไขได้");
  } catch (error) {
    $("historySelect").value = displayedHistoryId;
    $("historyMessage").textContent = "เปิดใบเบิกไม่สำเร็จ: " + error.message;
  } finally {
    busy = false;
    render();
  }
}

async function loadAppConfig() {
  appConfig = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("./config.json", { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("โหลด config.json ไม่สำเร็จ");
    const config = await response.json();
    appConfig = {
      settingsEndpoint: endpointUrl(config.settingsEndpoint),
      defaultDataEndpoint: endpointUrl(config.defaultDataEndpoint),
    };
    return appConfig;
  } catch (error) {
    throw new Error("อ่านการตั้งค่าเว็บไซต์ไม่สำเร็จ กรุณาเปิดผ่านเว็บเซิร์ฟเวอร์และตรวจ config.json: " + error.message);
  } finally {
    clearTimeout(timer);
  }
}

function setCatalogStatus(text) {
  $("welcomeCatalogStatus").textContent = text;
  $("preparationCatalogStatus").textContent = text;
}

function openWelcome() {
  if (busy || pending || preparationBusy || editing) return;
  $("userName").value = activeUser?.name || "";
  $("userName").setCustomValidity("");
  if (activeUser) {
    document.querySelector(`input[name="userRole"][value="${activeUser.role}"]`).checked = true;
  }
  $("welcomeDialog").showModal();
}

function enterWorkspace(event) {
  event.preventDefault();
  const name = $("userName").value.trim();
  if (!name) {
    $("userName").setCustomValidity("กรุณากรอกชื่อผู้ใช้งาน");
    $("userName").reportValidity();
    return;
  }
  const role = document.querySelector('input[name="userRole"]:checked').value;
  if (pending && role !== "requisition") {
    $("welcomeCatalogStatus").textContent = "มีใบเบิกรอยืนยันผล กรุณาเลือกสำหรับเบิกและตรวจผลบันทึกก่อน";
    return;
  }
  activeUser = { name, role };
  const preparing = role === "preparation";
  $("requisitionWorkspace").hidden = preparing;
  $("preparationWorkspace").hidden = !preparing;
  $("workspaceTitle").textContent = preparing ? "เตรียมสินค้าตามใบเบิก" : "สร้างใบเบิกสินค้า";
  $("workspaceDescription").textContent = preparing
    ? "เลือกใบเบิกที่รอเตรียม แล้วติ๊กรายการสินค้าที่เตรียมแล้ว"
    : "เลือกสินค้า ระบุจำนวน แล้วจัดทำเอกสารขอเบิกได้ในที่เดียว";
  $("activeUser").hidden = false;
  $("activeUser").textContent = "ผู้ใช้งาน: " + name + " · " + (preparing ? "สำหรับเตรียมของ" : "สำหรับเบิก");
  $("newBtn").hidden = preparing;
  if (!preparing && !pending && !saved) $("requester").value = name;
  $("welcomeDialog").close();
  if (preparing) loadPreparation();
  else if (!busy) loadRequisitionHistory();
}

async function loadPreparation() {
  if (preparationBusy) return;
  if (!settings || busy) {
    $("preparationMessage").textContent = busy
      ? "กำลังเชื่อมต่อชีต ระบบจะโหลดใบเบิกให้เมื่อเชื่อมต่อสำเร็จ"
      : "ยังเชื่อมต่อชีตไม่ได้ กรุณาตั้งค่าชีตแล้วกดโหลดใบเบิกใหม่";
    $("preparationSummaryState").textContent = $("preparationMessage").textContent;
    return;
  }
  preparationBusy = true;
  $("loadPreparationBtn").disabled = true;
  $("preparationMessage").textContent = "กำลังโหลดใบเบิกที่รอเตรียม…";
  $("preparationSummaryState").textContent = "กำลังโหลดใบเบิก…";
  try {
    const result = await readBridge(settings, "requisitions");
    if (!Array.isArray(result.requisitions)) throw new Error("กรุณาอัปเดต Apps Script ให้รองรับหน้าเตรียมของ");
    preparationRequests = result.requisitions;
    renderPreparation();
    $("preparationMessage").textContent = preparationRequests.length
      ? "พบ " + preparationRequests.length + " ใบเบิกที่รอเตรียม"
      : "ไม่มีใบเบิกที่รอเตรียม";
  } catch (error) {
    preparationRequests = [];
    $("preparationRequests").replaceChildren();
    $("preparationMessage").textContent = "โหลดใบเบิกไม่สำเร็จ: " + error.message;
    updatePreparationSummary();
    $("preparationSummaryState").textContent = "โหลดสรุปไม่สำเร็จ กรุณาโหลดใบเบิกใหม่";
  } finally {
    preparationBusy = false;
    $("loadPreparationBtn").disabled = false;
  }
}

function renderPreparation() {
  updatePreparationSummary();
  const root = $("preparationRequests");
  root.replaceChildren();
  for (const request of preparationRequests) {
    const card = document.createElement("section");
    card.className = "preparation-request";
    const heading = document.createElement("h3");
    heading.textContent = request.number + " · " + request.requester + " · " + (request.status || "จัดเตรียม");
    const details = document.createElement("p");
    details.className = "muted";
    details.textContent = [request.department, request.date, request.reason].filter(Boolean).join(" · ");
    card.append(heading, details);
    for (const item of request.items) {
      const label = document.createElement("label");
      label.className = "preparation-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = item.prepared === true;
      checkbox.disabled = request.items.every((entry) => entry.prepared);
      checkbox.addEventListener("change", () => savePreparation(request, item, checkbox));
      const text = document.createElement("span");
      text.textContent = `${item.name} · ${item.barcode} · ${item.qty} ${item.unit}`;
      label.append(checkbox, text);
      card.append(label);
    }
    root.append(card);
  }
}

function updatePreparationSummary() {
  const allItems = preparationRequests.flatMap((request) => request.items);
  const waiting = preparationRequests.filter((request) => request.items.some((item) => !item.prepared)).length;
  $("preparationDocumentTotal").textContent = waiting;
  $("preparationItemTotal").textContent = allItems.length;
  $("preparationDoneTotal").textContent = allItems.filter((item) => item.prepared).length;
  $("preparationSummaryState").textContent = waiting ? "สรุปจากใบเบิกที่โหลดล่าสุด" : "ไม่มีใบเบิกที่รอเตรียม";
}

async function savePreparation(request, item, checkbox) {
  if (preparationBusy || !activeUser || activeUser.role !== "preparation") {
    checkbox.checked = item.prepared === true;
    return;
  }
  const prepared = checkbox.checked;
  preparationBusy = true;
  $("userBtn").disabled = true;
  $("settingsBtn").disabled = true;
  $("loadPreparationBtn").disabled = true;
  $("preparationRequests").querySelectorAll("input").forEach((input) => { input.disabled = true; });
  $("preparationMessage").textContent = "กำลังบันทึกสถานะเตรียมของ…";
  const writeId = newId();
  try {
    const body = { action: "prepare", sheetId: settings.id,
      requestId: request.requestId, itemId: item.itemId, prepared,
      preparedBy: activeUser.name, writeId };
    authorizeEndpointRequest(settings.endpoint, body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      await fetch(settings.endpoint, {
        method: "POST", mode: "no-cors", credentials: "omit",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
    } catch {
      // ตรวจผลฝั่งเซิร์ฟเวอร์แม้การส่งคำขอหมดเวลา
    } finally {
      clearTimeout(timer);
    }
    let confirmed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await readBridge(settings, "preparationStatus", { writeId });
      if (result.status === "rejected") throw new Error(result.message);
      if (result.status === "saved") { confirmed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!confirmed) throw new Error("ยังยืนยันผลไม่ได้ กรุณาโหลดใบเบิกใหม่เพื่อตรวจสถานะก่อนทำต่อ");
    item.prepared = prepared;
    if (request.items.every((entry) => entry.prepared)) request.status = "เตรียมส่งมอบ";
    updatePreparationSummary();
    $("preparationMessage").textContent = "บันทึกสถานะแล้ว · ผู้เตรียม: " + activeUser.name;
  } catch (error) {
    checkbox.checked = item.prepared === true;
    $("preparationMessage").textContent = "บันทึกไม่สำเร็จหรือยังยืนยันผลไม่ได้: " + error.message;
  } finally {
    preparationBusy = false;
    $("userBtn").disabled = false;
    $("settingsBtn").disabled = busy || !!pending;
    $("loadPreparationBtn").disabled = false;
    renderPreparation();
  }
}

function newId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  // รองรับหน้า preview ที่ไม่มี randomUUID โดยยังใช้เลขสุ่มจากเบราว์เซอร์
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function notify(text, error = false) {
  $("message").textContent = text;
  $("message").className = "toast" + (error ? " error" : "");
  $("message").style.display = "block";
  if ($("scannerDialog")?.open) scannerMessage(text, error);
  if (error && !["welcomeDialog", "scannerDialog", "productDialog", "settings", "validationDialog"].some((id) => $(id)?.open)) {
    $("message").scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function preventPinchZoom(event) {
  if (event.type === "gesturestart" || event.type === "gesturechange" || event.touches?.length > 1) {
    event.preventDefault();
  }
}

function validationFailure(message, input) {
  validationTarget = input || null;
  if (input) input.setCustomValidity(message);
  $("validationMessage").textContent = message;
  if (!$("validationDialog").open) $("validationDialog").showModal();
  return false;
}

function focusValidationTarget() {
  const input = validationTarget;
  validationTarget = null;
  if (!input || input.isConnected === false || input.disabled) return;
  input.scrollIntoView({ behavior: "instant", block: "center" });
  input.focus({ preventScroll: true });
}

function sheetId(value) {
  const text = String(value || "").trim();
  const match = text.match(
    /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)(?:[/?#]|$)/,
  );

  if (match) return match[1];
  if (/^[\w-]{20,}$/.test(text)) return text;

  throw new Error("กรุณาวางลิงก์ Google Sheet หรือ Spreadsheet ID ที่ถูกต้อง");
}

function endpointUrl(value) {
  const url = new URL(String(value || "").trim());

  if (
    url.protocol !== "https:" ||
    url.hostname !== "script.google.com" ||
    !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error("กรุณาวางลิงก์ Apps Script Web app ที่ลงท้าย /exec");
  }

  return url.href;
}

function authorizeEndpointRequest(endpoint, payload) {
  const url = endpointUrl(endpoint);
  if (APPROVED_ENDPOINTS.has(url)) return;
  // ลิงก์อื่นต้องยืนยันปลายทางและข้อมูลจริงก่อนส่งแต่ละคำขอ ไม่จำสิทธิ์ข้ามคำขอ
  if (!confirm("ยืนยันส่งข้อมูลต่อไปนี้ไปยัง Apps Script นี้หรือไม่?\n\n" + url +
      "\n\nข้อมูลที่จะส่ง:\n" + JSON.stringify(payload, null, 2))) {
    throw new Error("ยกเลิกการส่งข้อมูลไปยัง Apps Script");
  }
}

// JSONP ใช้เฉพาะการอ่านสินค้าและตรวจผล เพื่อรองรับเว็บคนละโดเมน
function readBridge(cfg, action, params = {}) {
  return new Promise((resolve, reject) => {
    const callback = "__berkdee_" + newId().replace(/-/g, "");
    const script = document.createElement("script");
    const url = new URL(endpointUrl(cfg.endpoint));

    const query = {
      action,
      ...(cfg.id ? { sheetId: cfg.id, tab: cfg.tab } : {}),
      callback,
      ...params,
      timestamp: String(Date.now()),
    };
    authorizeEndpointRequest(cfg.endpoint, query);

    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }

    let timer;

    function cleanup() {
      clearTimeout(timer);
      script.remove();
      // ปล่อย callback แบบไม่ทำงานไว้ชั่วคราว กรณีคำตอบมาถึงหลังหมดเวลา
      window[callback] = () => {};
      setTimeout(() => delete window[callback], 60000);
    }

    window[callback] = (response) => {
      cleanup();
      if (!response || response.ok !== true) {
        reject(new Error(response?.message || "Apps Script ตอบกลับไม่ถูกต้อง"));
        return;
      }
      resolve(response);
    };

    script.onerror = () => {
      cleanup();
      reject(
        new Error(
          "ติดต่อ Apps Script ไม่สำเร็จ ตรวจลิงก์ /exec และการ Deploy เป็น Anyone",
        ),
      );
    };

    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error("รอคำตอบ Apps Script นานเกินไป กรุณาตรวจเครือข่ายแล้วลองอีกครั้ง"),
      );
    }, 25000);

    script.src = url.href;
    document.head.append(script);
  });
}

function normalizeSharedSettings(value, endpoint) {
  if (!value) return null;
  const id = sheetId(value.id);

  return {
    ...value,
    id,
    tab: "สินค้า",
    endpoint: endpointUrl(value.endpoint || endpoint),
    url: "https://docs.google.com/spreadsheets/d/" + id + "/edit",
  };
}

async function postSharedSettings(cfg, writeId) {
  const center = appConfig.settingsEndpoint;
  const body = { action: "settings", sheetId: cfg.id, tab: "สินค้า", endpoint: cfg.endpoint,
    adminToken: $("adminToken").value, writeId };
  authorizeEndpointRequest(center, body);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 25000);

  try {
    await fetch(center, {
      method: "POST",
      mode: "no-cors",
      credentials: "omit",
      signal: controller.signal,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
    });
  } catch {
    // อาจเขียนสำเร็จแม้ไม่ได้รับคำตอบ ให้ตรวจ revision ส่วนกลางก่อน
  } finally {
    clearTimeout(deadline);
  }
}

async function publishSharedSettings(cfg) {
  const writeId = newId();
  await postSharedSettings(cfg, writeId);

  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await readBridge({ endpoint: appConfig.settingsEndpoint }, "settings", {
      writeId,
    });

    if (response.writeError) throw new Error(response.writeError);

    if (response.settings?.revision === writeId) {
      if (response.settings.endpoint !== cfg.endpoint) {
        throw new Error("Apps Script ศูนย์กลางยังไม่รองรับการบันทึกลิงก์ กรุณาอัปเดต Code.gs และ Deploy New version");
      }
      return normalizeSharedSettings(response.settings, cfg.endpoint);
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error(
    "ยังยืนยันการบันทึกส่วนกลางไม่ได้ กรุณาตรวจว่าอัปเดต Code.gs และ Deploy New version แล้ว จากนั้นลองอีกครั้ง",
  );
}

async function syncSharedSettings() {
  if (busy || pending || saved || editing) return;
  busy = true;
  setCatalogStatus("กำลังโหลดรายการสินค้าเบื้องหลัง…");
  state();

  try {
    await loadAppConfig();
    const response = await readBridge({ endpoint: appConfig.settingsEndpoint }, "settings");
    const shared = normalizeSharedSettings(response.settings, appConfig.defaultDataEndpoint);

    if (!shared) {
      setCatalogStatus("ยังไม่ได้ตั้งค่าชีต สามารถเข้าใช้งานเพื่อตั้งค่าได้");
      notify(
        "ยังไม่มีการตั้งค่าส่วนกลาง ให้เครื่องเดิมกด ตั้งค่าชีต แล้วบันทึกการตั้งค่าอีกครั้งหนึ่ง",
      );
      return;
    }

    // ไม่สลับฐานข้อมูลของใบเบิกที่กำลังกรอกอยู่
    if (items.length && (settings?.id !== shared.id || settings?.endpoint !== shared.endpoint)) {
      notify(
        "ส่วนกลางเปลี่ยนการเชื่อมต่อแล้ว ใบเบิกปัจจุบันยังใช้ค่าเดิม เปิดใบเบิกใหม่เพื่อโหลดค่าล่าสุด",
      );
      return;
    }

    settings = shared;
    try {
      writeLocal(STORAGE, shared);
    } catch {
      /* ส่วนกลางยังใช้งานได้แม้ cache ไม่พร้อม */
    }
    const catalog = await readBridge(shared, "catalog");
    products = catalog.products;
    catalogLoaded = true;
    setCatalogStatus("โหลดสินค้าแล้ว " + products.length + " รายการ พร้อมใช้งาน");
    $("message").style.display = "none";
  } catch (error) {
    products = [];
    catalogLoaded = false;
    setCatalogStatus("โหลดสินค้าไม่สำเร็จ สามารถเข้าใช้งานแล้วกดโหลดใหม่ได้");
    notify("โหลดการตั้งค่าส่วนกลางไม่สำเร็จ: " + error.message, true);
  } finally {
    busy = false;
    render();
    if (activeUser?.role === "preparation") loadPreparation();
    else loadRequisitionHistory();
  }
}

function state() {
  const locked = busy || saved || !!pending;
  const historical = viewingHistoryDocument();

  for (const element of document.querySelectorAll(
    "main input, main textarea, main button, header button",
  )) {
    element.disabled = locked;
  }

  $("settingsBtn").disabled = busy || !!pending || editing;
  $("newBtn").disabled = busy || !!pending;
  $("userBtn").disabled = !!pending || preparationBusy || editing;
  $("printBtn").disabled = busy || !!pending || historical || !items.length;
  $("historyPrintBtn").disabled = busy || !!pending || !historical;
  $("refreshBtn").disabled = busy || saved || !!pending;
  $("saveBtn").disabled = busy || saved || historical || !items.length;
  $("editBtn").disabled = busy || !!pending || !historical || (!editing && (!saved || !editableDocumentStatus(currentDocumentStatus)));
  $("saveEditBtn").disabled = busy || !historical || !editing;
  $("editBtn").textContent = editing ? "ยกเลิกแก้ไข" : "แก้ไขรายการ";
  if (!busy) {
    $("saveBtn").textContent = "บันทึกลง Sheets";
    $("saveEditBtn").textContent = pending?.operation === "update" ? "บันทึกการแก้ไขซ้ำ" : "บันทึกการแก้ไข";
  }
  $("retryCancel").hidden = !pending || historical;
  $("retryCancel").disabled = busy;
  $("historyRetryCancel").hidden = !pending || !historical;
  $("historyRetryCancel").disabled = busy;

  const saveMessage = saved
    ? "บันทึกแล้ว • " + $("docno").value + " • " + documentStage(currentDocumentStatus)
    : pending
      ? "รอยืนยันผลบันทึก กดบันทึกซ้ำได้ด้วยคำขอเดิม"
      : editing ? "กำลังแก้ไขใบเบิก • " + $("docno").value
      : "ยังไม่ได้บันทึกเอกสาร";
  $("saveState").textContent = historical ? "รายการใบเบิกที่เลือกแสดงในส่วนด้านล่าง" : saveMessage;
  $("historySaveState").textContent = historical ? saveMessage : "";
  historyControls();
}

function openSettings() {
  if (busy || pending || preparationBusy || editing) return;

  $("sheetUrl").value = settings?.url || "";
  $("sheetTab").value = "สินค้า";
  $("endpoint").value = settings?.endpoint || appConfig?.defaultDataEndpoint || SHARED_ENDPOINT;
  $("adminToken").value = "";
  $("settingsMessage").textContent = "";
  $("settingsSave").textContent = "บันทึกการตั้งค่า";
  $("settings").showModal();
}

async function saveSheet() {
  if (busy || pending || preparationBusy || editing) return;
  if (
    items.length &&
    !confirm("เปลี่ยนฐานข้อมูลจะล้างรายการในใบเบิกปัจจุบัน ต้องการดำเนินการต่อหรือไม่?")
  ) {
    return;
  }

  if (!appConfig) {
    busy = true;
    state();
    try {
      await loadAppConfig();
    } catch (error) {
      $("settingsMessage").textContent = error.message;
      return;
    } finally {
      busy = false;
      state();
    }
  }

  let cfg;

  try {
    if (!$("adminToken").value.trim()) throw new Error("กรุณากรอกรหัสผู้ดูแลเพื่อบันทึกการตั้งค่ากลาง");
    const id = sheetId($("sheetUrl").value);
    // ใช้แท็บ “สินค้า” เป็นแหล่งอ่านเลขบาร์โค้ดสำหรับใบเบิก
    const tab = "สินค้า";

    if (!tab || ["ใบเบิก", "รายการเบิก"].includes(tab)) {
      throw new Error("ชื่อแท็บสินค้าต้องไม่ว่าง และไม่ใช้ชื่อ ใบเบิก หรือ รายการเบิก");
    }

    cfg = {
      id,
      tab,
      endpoint: endpointUrl($("endpoint").value),
      url: "https://docs.google.com/spreadsheets/d/" + id + "/edit",
    };
  } catch (error) {
    $("settingsMessage").textContent = error.message;
    return;
  }

  busy = true;
  state();
  $("settingsSave").disabled = true;
  $("settingsClose").disabled = true;
  $("settingsMessage").textContent = "กำลังเชื่อมต่อฐานข้อมูลและโหลดสินค้า…";

  try {
    const result = await readBridge(cfg, "catalog");
    cfg.name = result.name;

    // ยืนยันว่าค่าถูกเก็บที่ส่วนกลางจริงก่อนแจ้งว่าบันทึกแล้ว
    const shared = await publishSharedSettings(cfg);
    cfg = shared;
    try {
      writeLocal(STORAGE, cfg);
    } catch {
      // ค่ากลางบันทึกสำเร็จแล้ว ใช้ต่อได้แม้เบราว์เซอร์ไม่อนุญาต cache
    }
    settings = cfg;
    products = result.products;
    catalogLoaded = true;
    setCatalogStatus("โหลดสินค้าแล้ว " + products.length + " รายการ พร้อมใช้งาน");
    items = [];
    saved = false;
    editing = false;
    savedRevision = "original";
    currentDocumentStatus = "จัดเตรียม";
    displayedHistoryId = "";
    $("historySelect").value = "";
    requestId = newId();

    $("docno").value = "ออกเลขเมื่อบันทึกลง Sheets";
    $("saveBtn").textContent = "บันทึกลง Sheets";
    $("results").replaceChildren();
    $("settingsSave").textContent = "บันทึกแล้ว ✓";
    $("adminToken").value = "";
    $("settingsMessage").textContent =
      "บันทึกส่วนกลางแล้ว ✓ ทุกเครื่องที่ใช้เว็บไซต์นี้จะรับค่าใหม่เมื่อโหลดหน้าใหม่ โหลดสินค้า " +
      products.length +
      " รายการ";
    notify(
      "บันทึกการตั้งค่ากลางแล้ว เครื่องอื่นโหลดหน้าเว็บใหม่เพื่อใช้ลิงก์และชีตล่าสุดได้",
    );
  } catch (error) {
    $("settingsMessage").textContent = error.message;
  } finally {
    busy = false;
    $("settingsSave").disabled = false;
    $("settingsClose").disabled = false;
    render();
    if (activeUser?.role === "preparation") loadPreparation();
    else loadRequisitionHistory();
  }
}

async function loadProducts() {
  if (busy || saved || pending) return;
  if (!items.length && !editing) {
    await syncSharedSettings();
    return;
  }
  if (!settings) {
    openSettings();
    return;
  }

  busy = true;
  state();

  try {
    const result = await readBridge(settings, "catalog");
    products = result.products;
    catalogLoaded = true;
    setCatalogStatus("โหลดสินค้าแล้ว " + products.length + " รายการ พร้อมใช้งาน");
    searchProducts();
    notify("โหลดรายการสินค้าล่าสุดแล้ว");
  } catch (error) {
    products = [];
    catalogLoaded = false;
    setCatalogStatus("โหลดสินค้าไม่สำเร็จ กรุณากดโหลดใหม่อีกครั้ง");
    notify(error.message, true);
  } finally {
    busy = false;
    state();
  }
}

function pendingKey() {
  return STORAGE + ".pending";
}

function clearPending() {
  localStorage.removeItem(pendingKey());
  pending = null;
}

function applySaved(number) {
  const wasEdit = pending?.operation === "update";
  clearPending();
  resetDraft();
  render();
  notify((wasEdit ? "บันทึกการแก้ไขใบเบิก " : "บันทึกใบเบิก ") + number + " แล้ว รายการถูกล้างพร้อมสร้างใบเบิกใหม่ ดูหรือแก้ไขได้จาก “เลือกใบเบิกที่บันทึกไว้”");
  loadRequisitionHistory(true);
}

async function editSavedDoc() {
  if (busy || pending || !viewingHistoryDocument() || (!saved && !editing)) return;
  const cancelEdit = editing;
  if (cancelEdit && !confirm("ยกเลิกการแก้ไขและโหลดข้อมูลที่บันทึกไว้ล่าสุดหรือไม่?")) return;
  busy = true;
  state();
  try {
    const result = await readBridge(settings, "document", { requestId });
    const documentData = result.document;
    if (!documentData || !Array.isArray(documentData.items) || !documentData.revision) {
      throw new Error("กรุณาอัปเดต Code.gs ให้รองรับการแก้ไขใบเบิก");
    }
    if (!cancelEdit && !editableDocumentStatus(documentData.status)) {
      currentDocumentStatus = documentData.status;
      throw new Error("แก้ไขได้เฉพาะใบเบิกสถานะจัดเตรียม ใบเบิกนี้อยู่ในสถานะ " + documentStage(documentData.status));
    }
    let catalog;
    if (!cancelEdit) catalog = await readBridge(settings, "catalog");
    showSavedDocument(documentData);
    saved = cancelEdit;
    editing = !cancelEdit;
    if (catalog) {
      products = catalog.products;
      catalogLoaded = true;
    }
    $("results").replaceChildren();
    $("search").value = "";
    notify(cancelEdit ? "ยกเลิกการแก้ไขแล้ว โหลดข้อมูลที่บันทึกไว้ล่าสุด" : "แก้ไขรายการได้แล้ว เมื่อเสร็จให้กดบันทึกการแก้ไข เพื่ออัปเดตใบเบิกเลขที่เดิม");
  } catch (error) {
    notify("เปิดแก้ไขไม่สำเร็จ: " + error.message, true);
  } finally {
    busy = false;
    render();
  }
}

function readSaveStatus(p) {
  return p.operation === "update"
    ? readBridge(p.sheet, "updateStatus", { requestId: p.requestId, editId: p.editId })
    : readBridge(p.sheet, "status", { requestId: p.requestId, attemptId: p.attemptId });
}

async function checkSaveResult() {
  if (busy || !pending) return;
  busy = true;
  state();

  try {
    const result = await readSaveStatus(pending);

    if (result.status === "saved") {
      applySaved(result.number);
    } else if (result.status === "rejected" && !pending.hadUncertain) {
      clearPending();
      notify(
        "ยังไม่ได้บันทึก: " + result.message + "\nสามารถแก้ข้อมูลแล้วลองใหม่ได้",
        true,
      );
    } else {
      notify("ยังไม่ยืนยันว่าบันทึกแล้ว กรุณากดบันทึกซ้ำด้วยข้อมูลคำขอเดิม", true);
    }
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

async function waitForReceipt(p) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = await readSaveStatus(p);

    if (result.status === "saved") return result;

    if (result.status === "rejected") {
      const error = new Error(result.message);
      error.rejected = true;
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error("ยังไม่พบผลบันทึก กรุณากดตรวจผลหรือบันทึกซ้ำ ไม่ต้องสร้างใบเบิกใหม่");
}

function saveEditedDoc() {
  if (!editing || !viewingHistoryDocument()) return;
  return saveDoc("edit");
}

async function saveDoc(origin = "draft") {
  if ((editing && origin !== "edit") || (!editing && origin === "edit")) return;
  if (busy || saved || !valid()) return;
  busy = true;
  state();
  $(editing ? "saveEditBtn" : "saveBtn").textContent = "กำลังบันทึก…";

  try {
    if (!pending) {
      pending = { ...payload(), sheet: { ...settings }, hadUncertain: false,
        operation: editing ? "update" : "save", number: $("docno").value,
        documentStatus: currentDocumentStatus,
        ...(editing ? { editId: newId(), baseRevision: savedRevision } : {}) };
    } else {
      pending.hadUncertain = true;
    }

    pending.attemptId = newId();

    try {
      writeLocal(pendingKey(), pending);
    } catch {
      pending = null;
      throw new Error("เก็บข้อมูลรอส่งไม่ได้ กรุณาอนุญาตพื้นที่จัดเก็บของเบราว์เซอร์");
    }

    // ตรวจใบเดิมก่อนส่งซ้ำ กรณีเคยบันทึกแล้วแต่เครือข่ายขาด
    const previous = await readSaveStatus(pending);

    if (previous.status === "saved") {
      applySaved(previous.number);
      return;
    }

    const body = {
      action: pending.operation || "save",
      ...(pending.operation === "update" ? { editId: pending.editId, baseRevision: pending.baseRevision } : {}),
      sheetId: pending.sheet.id,
      tab: pending.sheet.tab,
      requestId: pending.requestId,
      attemptId: pending.attemptId,
      requester: pending.requester,
      department: pending.department,
      date: pending.date,
      reason: pending.reason,
      items: pending.items,
    };

    // no-cors ส่งข้อมูลได้ แต่ไม่สามารถอ่านคำตอบ จึงห้ามถือว่าสำเร็จตรงนี้
    authorizeEndpointRequest(pending.sheet.endpoint, body);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 25000);

    try {
      await fetch(pending.sheet.endpoint, {
        signal: controller.signal,
        method: "POST",
        mode: "no-cors",
        credentials: "omit",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(body),
      });
    } catch {
      // แม้ fetch ล้มเหลว เซิร์ฟเวอร์อาจเขียนสำเร็จแล้ว ตรวจใบรับก่อนแจ้งผล
    } finally {
      clearTimeout(deadline);
    }

    const result = await waitForReceipt(pending);
    applySaved(result.number);
  } catch (error) {
    if (error.rejected && pending && !pending.hadUncertain) {
      clearPending();
      notify("ยังไม่ได้บันทึก: " + error.message + "\nสามารถแก้ไขแล้วลองใหม่ได้", true);
    } else {
      notify(error.message + "\nกด “ตรวจผลบันทึก” หรือบันทึกซ้ำเพื่อยืนยันผลเดิม", true);
    }
  } finally {
    busy = false;
    render();
  }
}
function render() {
  const historical = viewingHistoryDocument();
  const rows = items
    .map(
      (product, index) => `
    <tr>
      <td>
        <strong>${esc(product.name)}</strong>
        <div class="muted">${esc(product.barcode)}</div>
      </td>
      <td>
        <input
          aria-label="จำนวน ${esc(product.name)}"
          type="number"
          min="0.001"
          max="1000000"
          step="any"
          value="${product.qty}"
          oninput="items[${index}].qty = Number(this.value)"
          onchange="items[${index}].qty = Number(this.value)"
        >
      </td>
      <td>${esc(product.unit)}</td>
      <td>
        <button
          class="remove"
          aria-label="ลบ ${esc(product.name)}"
          onclick="removeItem(${index})"
        >×</button>
      </td>
    </tr>
  `,
    )
    .join("");

  $("items").innerHTML = historical ? "" : rows;
  $("historyItems").innerHTML = historical ? rows : "";
  $("historyDocumentPanel").hidden = !historical;
  $("historyDocumentTitle").textContent = historical ? "ใบเบิก " + $("docno").value : "";
  $("historyItemCount").textContent = historical ? items.length + " รายการ" : "";
  $("listCount").textContent = (historical ? 0 : items.length) + " รายการ";
  $("empty").hidden = !historical && !!items.length;
  $("scannerCount").textContent = items.length + " รายการในใบเบิก";
  state();
}

function removeItem(i) {
  if (saved || busy || pending) return;
  items.splice(i, 1);
  render();
}

function addProduct(code) {
  if (saved || busy || pending || $("productDialog").open) return;

  // เก็บบาร์โค้ดเป็นข้อความเสมอ เพื่อรักษาเลขศูนย์ด้านหน้า
  code = String(code ?? "").trim();
  if (!code) return;

  const p = products.find((x) => x.barcode === code);
  if (!p) {
    notify(
      "ไม่พบบาร์โค้ด " + code + " ในแท็บ สินค้า จึงยังไม่ได้เพิ่มรายการขอเบิก",
      true,
    );
    return;
  }
  stopCameraScan();
  selectedProduct = p;
  $("selectedProductName").textContent = p.name;
  $("selectedProductBarcode").textContent = "บาร์โค้ด: " + p.barcode;
  $("selectedProductQty").value = "1";
  $("selectedProductUnit").replaceChildren();
  for (const unit of productUnits(p)) {
    const option = document.createElement("option");
    option.value = unit;
    option.textContent = unit;
    $("selectedProductUnit").append(option);
  }
  $("selectedProductUnit").value = productUnits(p)[0];
  $("productDialogMessage").textContent = "";
  $("productDialog").showModal();
  $("selectedProductQty").focus();
  $("selectedProductQty").select();
}

function productUnits(product) {
  const values = Array.isArray(product.units) ? product.units : String(product.unit || "ชิ้น").split(/[,，\n]+/);
  const units = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  return units.length ? units : ["ชิ้น"];
}

function confirmProduct(event) {
  event.preventDefault();
  if (!selectedProduct || busy || saved || pending) return;
  const qty = Number($("selectedProductQty").value);
  const unit = $("selectedProductUnit").value;
  const old = items.find((item) => item.barcode === selectedProduct.barcode && item.unit === unit);
  if (!Number.isFinite(qty) || qty < 0.001 || qty > 1000000 || (old && old.qty + qty > 1000000)) {
    $("productDialogMessage").textContent = "กรุณาระบุจำนวนตั้งแต่ 0.001 โดยยอดรวมต่อรายการต้องไม่เกิน 1,000,000";
    return;
  }
  if (!productUnits(selectedProduct).includes(unit)) {
    $("productDialogMessage").textContent = "กรุณาเลือกหน่วยสินค้าจากรายการ";
    return;
  }
  if (!old && items.length >= 500) {
    $("productDialogMessage").textContent = "เพิ่มสินค้าได้ไม่เกิน 500 รายการต่อใบเบิก";
    return;
  }
  const name = selectedProduct.name;
  if (old) old.qty += qty;
  else items.push({ barcode: selectedProduct.barcode, name, qty, unit });
  $("productDialog").close();
  selectedProduct = null;
  render();
  notify("เพิ่ม " + name + " จำนวน " + qty + " " + unit + " ลงรายการขอเบิกแล้ว");

  if (!$("scannerDialog").open) {
    $("requestItemsSection").scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }
}
function addBarcode() {
  const code = $("barcode").value.trim();
  if (!code) return;
  if (!settings) {
    openSettings();
    return;
  }
  addProduct(code);
  $("barcode").value = "";
  if (!$("productDialog").open) $("barcode").focus();
}
function searchProducts() {
  const q = $("search").value.trim().toLowerCase();
  const root = $("results");
  root.replaceChildren();
  if (!q || saved || pending) return;
  const matches = products
    .filter((p) => p.name.toLowerCase().includes(q) || p.barcode.includes(q))
    .slice(0, 15);
  for (const p of matches) {
    const b = document.createElement("button");
    b.className = "asidebtn";
    b.textContent = p.name + " · " + p.barcode + " ＋";
    b.onclick = () => addProduct(p.barcode);
    root.append(b);
  }
  if (!matches.length) root.textContent = "ไม่พบสินค้า";
}
// วงจรกล้องแยกจากสถานะใบเบิก ปิด Popup แล้วต้องหยุดกล้องเสมอ
let scannerReader = null;
let scannerStream = null;
let scannerGeneration = 0;
let scannerStarting = false;

function scannerMessage(text, error = false) {
  $("scannerStatus").textContent = text;
  $("scannerStatus").className = "scanner-status" + (error ? " error" : "");
}

function openScanner() {
  if (busy || saved || pending) return;
  if (!settings) {
    openSettings();
    return;
  }
  if (!catalogLoaded) {
    notify("กรุณากดโหลดใหม่เพื่อโหลดรายการสินค้าก่อนเปิดสแกน", true);
    return;
  }

  $("scannerDialog").showModal();
  document.body.classList.add("scanner-open");
  $("scannerCount").textContent = items.length + " รายการในใบเบิก";
  scannerMessage("เปิดกล้องสแกน หรือกรอกบาร์โค้ดสินค้า");
}

function stopCameraScan() {
  scannerGeneration++;
  scannerStarting = false;
  if (scannerReader) {
    scannerReader.reset();
    scannerReader = null;
  }
  if (scannerStream) {
    scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
  }
  $("scannerVideo").srcObject = null;
  $("scannerPreview").hidden = true;
  $("scannerPlaceholder").hidden = false;
  $("startScannerBtn").disabled = false;
  $("stopScannerBtn").hidden = true;
}

function closeScanner() {
  stopCameraScan();
  $("scannerDialog").close();
  document.body.classList.remove("scanner-open");
  $("requestItemsSection").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function startCameraScan() {
  if (scannerStarting || scannerReader) return;
  if (!$("scannerDialog").open || busy || saved || pending) return;
  if (!window.ZXing) {
    scannerMessage("โหลดตัวอ่านบาร์โค้ดไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ต", true);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    scannerMessage(
      "เบราว์เซอร์นี้เปิดกล้องสดไม่ได้ กรุณากรอกบาร์โค้ดหรือค้นหาสินค้าแทน",
      true,
    );
    return;
  }

  stopCameraScan();
  const generation = scannerGeneration;
  scannerStarting = true;
  $("startScannerBtn").disabled = true;
  scannerMessage("กำลังเปิดกล้อง…");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });

    // ผู้ใช้อาจปิด Popup ระหว่างรออนุญาตกล้อง
    if (generation !== scannerGeneration || !$("scannerDialog").open) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    scannerStream = stream;
    const reader = new ZXing.BrowserMultiFormatReader();
    scannerReader = reader;
    $("scannerPreview").hidden = false;
    $("scannerPlaceholder").hidden = true;
    $("stopScannerBtn").hidden = false;
    scannerMessage("เล็งบาร์โค้ดให้อยู่ในกรอบ เมื่ออ่านได้ให้ระบุจำนวนและเลือกหน่วยสินค้า");

    await reader.decodeFromStream(stream, $("scannerVideo"), (result) => {
      if (!result || generation !== scannerGeneration) return;
      const code = result.getText();
      // อ่านได้หนึ่งครั้งแล้วหยุด ป้องกันกล้องนับสินค้าชิ้นเดิมซ้ำหลายครั้ง
      stopCameraScan();
      addProduct(code);
      $("startScannerBtn").textContent = "สแกนสินค้าถัดไป";
    });
  } catch (error) {
    if (generation !== scannerGeneration) return;
    stopCameraScan();
    scannerMessage(
      error.name === "NotAllowedError"
        ? "ยังไม่ได้อนุญาตกล้อง ให้เปิดสิทธิ์กล้อง หรือกรอกบาร์โค้ดแทน"
        : "เปิดกล้องไม่สำเร็จ กรุณาลองใหม่ หรือกรอกบาร์โค้ดแทน",
      true,
    );
  } finally {
    if (generation === scannerGeneration) scannerStarting = false;
  }
}

function payload() {
  return {
    requestId,
    date: $("date").value,
    requester: $("requester").value.trim(),
    department: $("department").value.trim(),
    reason: $("reason").value.trim(),
    items: items.map((x) => ({ ...x })),
  };
}
function valid() {
  const missing = [];
  for (const [id, message] of [["requester", "กรุณากรอกชื่อผู้ขอเบิก"], ["department", "กรุณากรอกแผนก / หน่วยงาน"], ["date", "กรุณาระบุวันที่ขอเบิก"]]) {
    $(id).setCustomValidity("");
    if (!$(id).value.trim()) missing.push({ input: $(id), message });
  }
  if (missing.length) return validationFailure(missing.map((field) => "• " + field.message).join("\n"), missing[0].input);
  if (!settings) return validationFailure("กรุณาตั้งค่าชีตก่อนบันทึกหรือพิมพ์ใบเบิก");
  if (!items.length || items.length > 500) return validationFailure("กรุณาเพิ่มสินค้า 1 ถึง 500 รายการก่อนบันทึกหรือพิมพ์");
  const invalidQuantity = items.findIndex((p) => !Number.isFinite(p.qty) || p.qty <= 0 || p.qty > 1000000);
  if (invalidQuantity >= 0) {
    const root = $(viewingHistoryDocument() ? "historyItems" : "items");
    return validationFailure("กรุณาระบุจำนวนของ " + items[invalidQuantity].name + " มากกว่า 0 และไม่เกิน 1,000,000", root.querySelectorAll('input[type="number"]')[invalidQuantity]);
  }
  return true;
}

function printDoc() {
  if (busy || !valid() || pending) return;

  const documentData = payload();
  const number = saved ? esc($("docno").value) : editing ? esc($("docno").value) + " (ฉบับแก้ไข — ยังไม่ได้บันทึก)" : "ฉบับร่าง — ยังไม่ได้บันทึก";

  const rows = items
    .map(
      (item, index) => `
    <tr>
      <td class="print-center">${index + 1}</td>
      <td class="print-code">${esc(item.barcode)}</td>
      <td>${esc(item.name)}</td>
      <td class="print-quantity">${new Intl.NumberFormat("th-TH", { maximumSignificantDigits: 21 }).format(item.qty)}</td>
      <td class="print-center">${esc(item.unit)}</td>
    </tr>
  `,
    )
    .join("");

  const emptyPrintRows = Array.from({ length: Math.max(0, 20 - items.length) }, () =>
    '<tr class="print-empty-row" aria-hidden="true"><td></td><td></td><td></td><td></td><td></td></tr>'
  ).join("");

  $("printArea").innerHTML = `
    <div class="print-heading">
      <div class="print-brand">MM Bakery<small>เอกสารเบิกสินค้า</small></div>
      <div class="print-document-title"><h1>ใบเบิกสินค้า</h1><span>STOCK REQUISITION</span></div>
    </div>
    <div class="print-information">
      <div class="print-requester">
        <p><strong>ผู้ขอเบิก</strong><span>${esc(documentData.requester)}</span></p>
        <p><strong>แผนก / หน่วยงาน</strong><span>${esc(documentData.department)}</span></p>
      </div>
      <div class="print-document-meta">
        <p><strong>เลขที่ใบเบิก</strong><span>${number}</span></p>
        <p><strong>วันที่ขอเบิก</strong><span>${esc(documentData.date.split("-").reverse().join("/"))}</span></p>
      </div>
    </div>
    <table class="print-items">
      <colgroup><col style="width:6%"><col style="width:20%"><col style="width:50%"><col style="width:12%"><col style="width:12%"></colgroup>
      <thead>
        <tr>
          <th>#</th>
          <th>บาร์โค้ด</th>
          <th>รายการสินค้า</th>
          <th>จำนวนเบิก</th>
          <th>หน่วยนับ</th>
        </tr>
      </thead>
      <tbody>${rows}${emptyPrintRows}</tbody>
    </table>
    <div class="print-item-total">รวมรายการสินค้าทั้งหมด <strong>${items.length}</strong> รายการ</div>
    <div class="print-reason"><strong>เหตุผลในการเบิก / หมายเหตุ</strong><p>${esc(documentData.reason || "—")}</p></div>
    <div class="print-signatures">
      <div><div class="print-sign-line"></div><strong>ผู้ขอเบิก</strong><p>วันที่ ______ / ______ / ______</p></div>
      <div><div class="print-sign-line"></div><strong>ผู้อนุมัติ</strong><p>วันที่ ______ / ______ / ______</p></div>
      <div><div class="print-sign-line"></div><strong>ผู้จ่ายสินค้า</strong><p>วันที่ ______ / ______ / ______</p></div>
    </div>
  `;

  try {
    if (typeof window.print !== "function") throw new Error("Printing unavailable");
    window.print();
  } catch {
    notify("เบราว์เซอร์นี้ไม่เปิดหน้าพิมพ์ กรุณาเปิดเว็บด้วยเบราว์เซอร์หลักของเครื่องแล้วลองพิมพ์ / PDF อีกครั้ง", true);
  }
}

function resetDraft() {
  items = [];
  saved = false;
  editing = false;
  savedRevision = "original";
  currentDocumentStatus = "จัดเตรียม";
  displayedHistoryId = "";
  $("historySelect").value = "";
  requestId = newId();
  $("docno").value = "ออกเลขเมื่อบันทึกลง Sheets";
  $("date").value = bangkokToday();
  $("reason").value = "";
  if (activeUser?.role === "requisition") $("requester").value = activeUser.name;
  $("results").replaceChildren();
  $("search").value = "";
}

function newDoc() {
  if (busy || pending) return;
  if (items.length && !saved && !confirm("ต้องการเริ่มใบเบิกใหม่และล้างรายการปัจจุบันหรือไม่?")) return;
  resetDraft();
  $("message").style.display = "none";
  render();
  syncSharedSettings();
}

async function init() {
  $("validationDialog").addEventListener("close", focusValidationTarget);
  for (const type of ["touchstart", "touchmove", "gesturestart", "gesturechange"]) {
    document.addEventListener(type, preventPinchZoom, { passive: false });
  }
  document.addEventListener("input", (event) => {
    if (typeof event.target?.setCustomValidity === "function") event.target.setCustomValidity("");
  });
  $("productForm").addEventListener("submit", confirmProduct);
  $("productDialog").addEventListener("close", () => { selectedProduct = null; });
  $("welcomeForm").addEventListener("submit", enterWorkspace);
  $("userName").addEventListener("input", () => $("userName").setCustomValidity(""));
  $("welcomeDialog").addEventListener("cancel", (event) => {
    if (!activeUser) event.preventDefault();
  });
  $("welcomeDialog").showModal();
  $("date").value = bangkokToday();

  const cfg = readLocal(STORAGE, null);

  try {
    if (cfg) {
      cfg.id = sheetId(cfg.id);
      cfg.endpoint = endpointUrl(cfg.endpoint || SHARED_ENDPOINT);
      cfg.tab = "สินค้า";
      settings = cfg;
    }
  } catch {
    notify("การตั้งค่าที่บันทึกไว้ไม่ถูกต้อง กรุณาตั้งค่าชีตใหม่", true);
  }

  const queued = readLocal(pendingKey(), null);

  if (queued?.sheet && Array.isArray(queued.items) && queued.requestId) {
    pending = queued;
    pending.hadUncertain = true;
    settings = queued.sheet;
    items = queued.items;
    requestId = queued.requestId;
    editing = queued.operation === "update";
    displayedHistoryId = editing ? queued.requestId : "";
    savedRevision = queued.baseRevision || "original";
    currentDocumentStatus = queued.documentStatus || "จัดเตรียม";
    if (editing) $("docno").value = queued.number || "รอยืนยันการแก้ไข";

    for (const key of ["requester", "department", "date", "reason"]) {
      $(key).value = queued[key] || "";
    }

    notify("กู้คืนใบเบิกที่รอยืนยันผลแล้ว กดตรวจผลบันทึกหรือบันทึกซ้ำได้");
  }

  $("scannerDialog").addEventListener("close", () => {
    stopCameraScan();
    document.body.classList.remove("scanner-open");
  });
  $("scannerDialog").addEventListener("cancel", stopCameraScan);
  window.addEventListener("pagehide", stopCameraScan);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCameraScan();
  });

  $("settings").addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });

  render();

  // เครื่องใหม่ไม่มี localStorage ก็อ่านค่าจากจุดเชื่อมต่อกลางได้
  $("endpoint").value = settings?.endpoint || appConfig?.defaultDataEndpoint || SHARED_ENDPOINT;
  if (!pending) await syncSharedSettings();
  else setCatalogStatus("มีใบเบิกรอยืนยันผล กรุณาเลือกสำหรับเบิกเพื่อตรวจผลบันทึก");
}

init();

"use strict";

// ส่วนกลาง: การเชื่อมต่อ Apps Script การตั้งค่า สินค้า Toast สแกน และรูปแบบพิมพ์
// ใช้ classic scripts ตามลำดับใน index.html เพื่อให้ตัวจัดการเหตุการณ์ HTML เรียกใช้งานได้

const $ = (id) => document.getElementById(id);

const STORAGE = "berkdee.bridge.v1";

// ลิงก์เริ่มต้น เปลี่ยนได้จากหน้าตั้งค่า

const SHARED_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbzg6yxu0tWOqMJiyXPFkVLu680624tmT9BEwkqIR3Ja2IA1p7oW0GkwVRHtuV_UrvML/exec";

const APPROVED_ENDPOINTS = new Set([SHARED_ENDPOINT,
  "https://script.google.com/macros/s/AKfycbyyXOPUf94XA9-5sJIRNS2u-4nWSzt9QoFUpn13if2pHDdM1wJIPubjBuSVwEg9Qsih/exec"]);

let products = [];

let settings = null;

let printStatusBusy = false;

let busy = false;

let catalogLoaded = false;

let activeUser = null;

let scannerMode = "requisition";

function handleScannedBarcode(code) {
  if (scannerMode === "preparation") checkPreparationBarcode(code);
  else addProduct(code);
}

let appConfig = null;

let validationTarget = null;

function editableDocumentStatus(status) {
  return ["ขอเบิก", "รอเตรียม", "กำลังเตรียม", "จัดเตรียม", "กำลังจัดเตรียม", "อนุมัติ"].includes(String(status).trim());
}

function documentStage(status) {
  const value = String(status).trim();
  return ["ขอเบิก", "รอเตรียม", "จัดเตรียม", "อนุมัติ"].includes(value) ? "ขอเบิก"
    : editableDocumentStatus(value) ? "กำลังจัดเตรียม" : value;
}

function bangkokToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok", calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
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

let notificationTimer = null;

function dismissNotification() {
  clearTimeout(notificationTimer);
  notificationTimer = null;
  $("message").style.display = "none";
}

function notify(text, error = false) {
  clearTimeout(notificationTimer);
  const toast = $("message");
  toast.textContent = text;
  toast.className = "toast" + (error ? " error" : "");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "ปิดการแจ้งเตือน");
  close.onclick = dismissNotification;
  toast.append(close);
  toast.style.display = "block";
  notificationTimer = setTimeout(dismissNotification, error ? 10000 : 5000);
  notificationTimer?.unref?.();
  if ($("scannerDialog")?.open) scannerMessage(text, error);
  if ($("historyDialog")?.open) $("historyDialogMessage").textContent = error ? text : "";
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
  if (busy || pending || pendingPreparation || saved || editing) return;
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
    if ((items.length || reservationSource) && (settings?.id !== shared.id || settings?.endpoint !== shared.endpoint)) {
      notify(
        "ส่วนกลางเปลี่ยนการเชื่อมต่อแล้ว ใบเบิกปัจจุบันยังใช้ค่าเดิม เปิดใบเบิกใหม่เพื่อโหลดค่าล่าสุด",
      );
      return;
    }

    settings = shared;
    loadRequisitionHistory();
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
    else if (!historyBusy && !documentHistory.length) loadRequisitionHistory();
  }
}

function openSettings() {
  if (busy || pending || preparationBusy || pendingPreparation || preparationChanges.size || editing) return;

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
    currentDocumentStatus = "ขอเบิก";
    displayedHistoryId = "";
    $("historySelect").value = "";
    requestId = newId();
    reservedNumber = "";
    reservationSource = null;
    localStorage.removeItem(STORAGE + ".reservation");
    $("docno").value = "กดใบเบิกใหม่เพื่อรับเลขเอกสาร";
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

function addBarcode() {
  const code = $("barcode").value.trim();
  if (!code) return;
  if (!settings) {
    openSettings();
    return;
  }
  handleScannedBarcode(code);
  $("barcode").value = "";
  if (!$("productDialog").open) $("barcode").focus();
}

let scannerReader = null;

let scannerStream = null;

let scannerGeneration = 0;

let scannerStarting = false;

function scannerMessage(text, error = false) {
  $("scannerStatus").textContent = text;
  $("scannerStatus").className = "scanner-status" + (error ? " error" : "");
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
  const preparing = scannerMode === "preparation";
  stopCameraScan();
  $("scannerDialog").close();
  document.body.classList.remove("scanner-open");
  scannerMode = "requisition";
  preparationScanRequestId = "";
  if (preparing) $("preparationScanBtn").focus();
  else if (editing && $("historyDialog").open) $("historyAddBtn").focus();
  else $("requestItemsSection").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function startCameraScan() {
  const preparing = scannerMode === "preparation";
  if (preparing ? !preparationScanRequest() : !requireDocumentNumber()) return;
  if (scannerStarting || scannerReader) return;
  if (!$("scannerDialog").open || (!preparing && (busy || saved || pending))) return;
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
    scannerMessage(preparing ? "เล็งบาร์โค้ดสินค้าเพื่อตรวจสอบกับใบเบิกที่เลือก" : "เล็งบาร์โค้ดให้อยู่ในกรอบ เมื่ออ่านได้ให้ระบุจำนวนและเลือกหน่วยสินค้า");

    await reader.decodeFromStream(stream, $("scannerVideo"), (result) => {
      if (!result || generation !== scannerGeneration) return;
      const code = result.getText();
      // อ่านได้หนึ่งครั้งแล้วหยุด ป้องกันกล้องนับสินค้าชิ้นเดิมซ้ำหลายครั้ง
      stopCameraScan();
      handleScannedBarcode(code);
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

async function markDocumentPrinted(context) {
  printStatusBusy = true;
  ++historyGeneration;
  documentCache.delete(context.requestId);
  state();
  try {
    const body = { action: "print", sheetId: context.source.id, requestId: context.requestId,
      baseRevision: context.revision, writeId: newId() };
    authorizeEndpointRequest(context.source.endpoint, body);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 25000);
    try {
      await fetch(context.source.endpoint, { method: "POST", mode: "no-cors", credentials: "omit",
        headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body), signal: controller.signal });
    } catch { /* ตรวจผลฝั่งเซิร์ฟเวอร์ แม้คำตอบ POST ขาดหาย */ }
    finally { clearTimeout(deadline); }
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await readBridge(context.source, "printStatus", { requestId: context.requestId, writeId: body.writeId });
      if (result.status === "rejected") throw new Error(result.message);
      if (result.status === "saved") {
        if (historySourceKey(settings) === historySourceKey(context.source)) {
          documentHistory = documentHistory.map((doc) => doc.requestId === context.requestId
            ? { ...doc, status: result.documentStatus, stage: documentStage(result.documentStatus) } : doc);
          if (requestId === context.requestId) currentDocumentStatus = result.documentStatus;
          preparationRequests = preparationRequests.map((doc) => doc.requestId === context.requestId ? { ...doc, status: result.documentStatus } : doc);
          if (completedPreparationDocument?.requestId === context.requestId) completedPreparationDocument.status = result.documentStatus;
          if ($("preparationDialog").open && preparationSelectedId === context.requestId) {
            $("preparationMessage").textContent = "สถานะใบเบิก · " + documentStage(result.documentStatus);
            renderPreparation();
          }
          renderHistoryOptions();
          notify("อัปเดตสถานะใบเบิกแล้ว · " + documentStage(result.documentStatus));
          loadRequisitionHistory(true);
        }
        return;
      }
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("ยังยืนยันการเปลี่ยนสถานะไม่ได้ กรุณาโหลดใบเบิกเพื่อตรวจสอบ");
  } catch (error) {
    notify("เปิดหน้าพิมพ์แล้ว แต่ยังเปลี่ยนสถานะไม่สำเร็จ: " + error.message, true);
  } finally { printStatusBusy = false; state(); }
}

function renderRequisitionPrint(documentData, number, printContext = null) {
  const printItems = documentData.items;
  const rows = printItems
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

  const emptyPrintRows = Array.from({ length: Math.max(0, 20 - printItems.length) }, () =>
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
    <div class="print-item-total">รวมรายการสินค้าทั้งหมด <strong>${printItems.length}</strong> รายการ</div>
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
    return;
  }
  if (printContext) return markDocumentPrinted(printContext);
}

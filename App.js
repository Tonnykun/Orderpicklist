"use strict";

// หน้าเว็บรันจาก VS Code ได้ ใช้ Apps Script เป็นตัวกลาง ไม่มี Google OAuth บนหน้าเว็บ
const $ = (id) => document.getElementById(id);
const STORAGE = "berkdee.bridge.v1";

// จุดเชื่อมต่อกลางของเว็บไซต์ ทุกเครื่องใช้ลิงก์เดียวกัน
const SHARED_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbyyXOPUf94XA9-5sJIRNS2u-4nWSzt9QoFUpn13if2pHDdM1wJIPubjBuSVwEg9Qsih/exec";

let products = [];
let items = [];
let settings = null;
let saved = false;
let busy = false;
let pending = null;
let catalogLoaded = false;
let requestId = newId();

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

function normalizeSharedSettings(value) {
  if (!value) return null;
  const id = sheetId(value.id);

  return {
    ...value,
    id,
    tab: "สินค้า",
    endpoint: SHARED_ENDPOINT,
    url: "https://docs.google.com/spreadsheets/d/" + id + "/edit",
  };
}

async function postSharedSettings(cfg, writeId) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 25000);

  try {
    await fetch(SHARED_ENDPOINT, {
      method: "POST",
      mode: "no-cors",
      credentials: "omit",
      signal: controller.signal,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({
        action: "settings",
        sheetId: cfg.id,
        tab: "สินค้า",
        writeId,
      }),
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
    const response = await readBridge({ endpoint: SHARED_ENDPOINT }, "settings", {
      writeId,
    });

    if (response.writeError) throw new Error(response.writeError);

    if (response.settings?.revision === writeId) {
      return normalizeSharedSettings(response.settings);
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error(
    "ยังยืนยันการบันทึกส่วนกลางไม่ได้ กรุณาตรวจว่าอัปเดต Code.gs และ Deploy New version แล้ว จากนั้นลองอีกครั้ง",
  );
}

async function syncSharedSettings() {
  if (busy || pending || saved) return;
  busy = true;
  state();

  try {
    const response = await readBridge({ endpoint: SHARED_ENDPOINT }, "settings");
    const shared = normalizeSharedSettings(response.settings);

    if (!shared) {
      notify(
        "ยังไม่มีการตั้งค่าส่วนกลาง ให้เครื่องเดิมกด ตั้งค่าชีต แล้วบันทึกการตั้งค่าอีกครั้งหนึ่ง",
      );
      return;
    }

    // ไม่สลับฐานข้อมูลของใบเบิกที่กำลังกรอกอยู่
    if (items.length && settings?.id !== shared.id) {
      notify(
        "ส่วนกลางเปลี่ยนชีตแล้ว ใบเบิกปัจจุบันยังใช้ชีตเดิม เปิดใบเบิกใหม่เพื่อโหลดค่าล่าสุด",
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
    notify("เชื่อมฐานข้อมูลส่วนกลางแล้ว: " + shared.name);
  } catch (error) {
    products = [];
    catalogLoaded = false;
    notify("โหลดการตั้งค่าส่วนกลางไม่สำเร็จ: " + error.message, true);
  } finally {
    busy = false;
    updateSheet();
    render();
  }
}

function state() {
  const locked = busy || saved || !!pending;

  for (const element of document.querySelectorAll(
    "main input, main textarea, main button, header button",
  )) {
    element.disabled = locked;
  }

  $("settingsBtn").disabled = busy || !!pending;
  $("newBtn").disabled = busy || !!pending;
  $("printBtn").disabled = busy || !!pending;
  $("refreshBtn").disabled = busy || saved || !!pending;
  $("saveBtn").disabled = busy || saved;
  $("retryCancel").hidden = !pending;

  $("saveState").textContent = saved
    ? "บันทึกแล้ว • " + $("docno").value
    : pending
      ? "รอยืนยันผลบันทึก กดบันทึกซ้ำได้ด้วยคำขอเดิม"
      : "ยังไม่ได้บันทึกเอกสาร";
}

function updateSheet() {
  $("sheetStatus").innerHTML = settings
    ? '<span class="dot ' +
      (catalogLoaded ? "ok" : "") +
      '"></span>' +
      esc(settings.name || "บันทึกลิงก์ชีตแล้ว") +
      '<br><span class="muted">แท็บ ' +
      esc(settings.tab) +
      "</span>"
    : '<span class="dot"></span>ยังไม่ได้ตั้งค่าชีต';

  $("sheetLink").hidden = !settings;

  if (settings) {
    $("sheetLink").href =
      "https://docs.google.com/spreadsheets/d/" +
      encodeURIComponent(settings.id) +
      "/edit";
  }

  $("productCount").textContent = settings
    ? catalogLoaded
      ? products.length + " สินค้าพร้อมใช้งาน"
      : "กดโหลดใหม่เพื่อเชื่อมฐานข้อมูล"
    : "บันทึกลิงก์ชีตเพื่อโหลดสินค้า";
}

function openSettings() {
  if (busy || pending) return;

  $("sheetUrl").value = settings?.url || "";
  $("sheetTab").value = "สินค้า";
  $("endpoint").value = SHARED_ENDPOINT;
  $("endpoint").readOnly = true;
  $("settingsMessage").textContent = "";
  $("settingsSave").textContent = "บันทึกการตั้งค่า";
  $("settings").showModal();
}

async function saveSheet() {
  if (
    items.length &&
    !confirm("เปลี่ยนฐานข้อมูลจะล้างรายการในใบเบิกปัจจุบัน ต้องการดำเนินการต่อหรือไม่?")
  ) {
    return;
  }

  let cfg;

  try {
    const id = sheetId($("sheetUrl").value);
    // ใช้แท็บ “สินค้า” เป็นแหล่งอ่านเลขบาร์โค้ดสำหรับใบเบิก
    const tab = "สินค้า";

    if (!tab || ["ใบเบิก", "รายการเบิก"].includes(tab)) {
      throw new Error("ชื่อแท็บสินค้าต้องไม่ว่าง และไม่ใช้ชื่อ ใบเบิก หรือ รายการเบิก");
    }

    cfg = {
      id,
      tab,
      endpoint: SHARED_ENDPOINT,
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
    items = [];
    saved = false;
    requestId = newId();

    $("docno").value = "ออกเลขเมื่อบันทึกลง Sheets";
    $("saveBtn").textContent = "บันทึกลง Sheets";
    $("results").replaceChildren();
    $("settingsSave").textContent = "บันทึกแล้ว ✓";
    $("settingsMessage").textContent =
      "บันทึกส่วนกลางแล้ว ✓ ทุกเครื่องจะใช้ชีตนี้ โหลดสินค้า " +
      products.length +
      " รายการ";
    updateSheet();
    notify(
      "บันทึกลิงก์ชีตไว้ส่วนกลางแล้ว เครื่องอื่นเปิดหรือโหลดหน้าเว็บใหม่เพื่อใช้ชีตเดียวกันได้",
    );
  } catch (error) {
    $("settingsMessage").textContent = error.message;
  } finally {
    busy = false;
    $("settingsSave").disabled = false;
    $("settingsClose").disabled = false;
    render();
  }
}

async function loadProducts() {
  if (busy || saved || pending) return;
  if (!items.length) {
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
    searchProducts();
    notify("โหลดรายการสินค้าล่าสุดแล้ว");
  } catch (error) {
    products = [];
    catalogLoaded = false;
    notify(error.message, true);
  } finally {
    busy = false;
    updateSheet();
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
  saved = true;
  clearPending();
  $("docno").value = number;
  $("saveBtn").textContent = "บันทึกแล้ว ✓";
  render();
  notify("บันทึกใบเบิก " + number + " แล้ว สามารถพิมพ์ / บันทึก PDF ได้");
}

async function checkSaveResult() {
  if (busy || !pending) return;
  busy = true;
  state();

  try {
    const result = await readBridge(pending.sheet, "status", {
      requestId: pending.requestId,
      attemptId: pending.attemptId,
    });

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
    const result = await readBridge(p.sheet, "status", {
      requestId: p.requestId,
      attemptId: p.attemptId,
    });

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

async function saveDoc() {
  if (busy || saved || !valid()) return;
  busy = true;
  state();
  $("saveBtn").textContent = "กำลังบันทึก…";

  try {
    if (!pending) {
      pending = { ...payload(), sheet: { ...settings }, hadUncertain: false };
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
    const previous = await readBridge(pending.sheet, "status", {
      requestId: pending.requestId,
      attemptId: pending.attemptId,
    });

    if (previous.status === "saved") {
      applySaved(previous.number);
      return;
    }

    const body = {
      action: "save",
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
    $("saveBtn").textContent = saved ? "บันทึกแล้ว ✓" : "บันทึกลง Sheets";
    render();
  }
}
function render() {
  $("items").innerHTML = items
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

  $("total").textContent = items.length;
  $("listCount").textContent = items.length + " รายการ";
  $("empty").hidden = !!items.length;
  $("scannerCount").textContent = items.length + " รายการในใบเบิก";
  state();
}

function removeItem(i) {
  if (saved || busy || pending) return;
  items.splice(i, 1);
  render();
}

function addProduct(code) {
  if (saved || busy || pending) return;

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
  const old = items.find((x) => x.barcode === code);
  if (old) old.qty += 1;
  else items.push({ ...p, qty: 1 });
  render();
  notify("เพิ่ม " + p.name + " ลงหัวข้อ 03 รายการขอเบิกแล้ว");

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
  $("barcode").focus();
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
let scannerReadingPhoto = false;
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
  scannerMessage("เปิดกล้องสแกน หรือถ่ายภาพ/เลือกรูปบาร์โค้ด");
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
  $("startScannerBtn").disabled = scannerReadingPhoto;
  $("stopScannerBtn").hidden = true;
}

function closeScanner() {
  stopCameraScan();
  $("scannerDialog").close();
  document.body.classList.remove("scanner-open");
  $("requestItemsSection").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function startCameraScan() {
  if (scannerStarting || scannerReader || scannerReadingPhoto) return;
  if (!$("scannerDialog").open || busy || saved || pending) return;
  if (!window.ZXing) {
    scannerMessage("โหลดตัวอ่านบาร์โค้ดไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ต", true);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    scannerMessage(
      "เบราว์เซอร์นี้เปิดกล้องสดไม่ได้ กรุณาใช้ปุ่มถ่ายภาพ/เลือกรูปแทน",
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
    scannerMessage("เล็งบาร์โค้ดให้อยู่ในกรอบ เมื่ออ่านได้จะเพิ่มครั้งละ 1 ชิ้น");

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
        ? "ยังไม่ได้อนุญาตกล้อง ให้เปิดสิทธิ์กล้อง หรือใช้ปุ่มถ่ายภาพ/เลือกรูปแทน"
        : "เปิดกล้องไม่สำเร็จ กรุณาลองใหม่ หรือใช้ปุ่มถ่ายภาพ/เลือกรูปแทน",
      true,
    );
  } finally {
    if (generation === scannerGeneration) scannerStarting = false;
  }
}

async function scanPhoto(input) {
  const file = input.files?.[0];
  if (!file || scannerReadingPhoto || saved || busy || pending) return;
  if (!$("scannerDialog").open) return;

  stopCameraScan();
  const generation = scannerGeneration;
  scannerReadingPhoto = true;
  $("cameraBtn").disabled = true;
  $("startScannerBtn").disabled = true;
  scannerMessage("กำลังอ่านบาร์โค้ดจากภาพ…");
  let url;
  let reader;

  try {
    if (!window.ZXing) throw new Error("ยังโหลดตัวอ่านบาร์โค้ดไม่สำเร็จ");
    reader = new ZXing.BrowserMultiFormatReader();
    url = URL.createObjectURL(file);
    const result = await reader.decodeFromImageUrl(url);

    if (generation === scannerGeneration && $("scannerDialog").open) {
      addProduct(result.getText());
    }
  } catch {
    if (generation === scannerGeneration && $("scannerDialog").open) {
      scannerMessage("อ่านบาร์โค้ดไม่สำเร็จ ลองภาพที่ชัดขึ้น หรือกรอกเลขบาร์โค้ด", true);
    }
  } finally {
    if (reader) reader.reset();
    if (url) URL.revokeObjectURL(url);
    input.value = "";
    scannerReadingPhoto = false;
    $("cameraBtn").disabled = false;
    $("startScannerBtn").disabled = false;
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
  if (!$("requester").value.trim() || !$("department").value.trim() || !$("date").value) {
    notify("กรุณากรอกผู้ขอเบิก แผนก และวันที่", true);
    return false;
  }
  if (
    !settings ||
    !items.length ||
    items.length > 500 ||
    items.some((p) => !Number.isFinite(p.qty) || p.qty <= 0 || p.qty > 1000000)
  ) {
    notify(
      "กรุณาตั้งค่าชีต เพิ่มสินค้าไม่เกิน 500 รายการ และระบุจำนวนมากกว่า 0 ไม่เกิน 1,000,000",
      true,
    );
    return false;
  }
  return true;
}

function printDoc() {
  if (busy || !valid() || pending) return;

  const documentData = payload();
  const number = saved ? esc($("docno").value) : "ฉบับร่าง — ยังไม่ได้บันทึก";

  const rows = items
    .map(
      (item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${esc(item.barcode)}</td>
      <td>${esc(item.name)}</td>
      <td>${item.qty}</td>
      <td>${esc(item.unit)}</td>
    </tr>
  `,
    )
    .join("");

  $("printArea").innerHTML = `
    <h1>ใบเบิกสินค้า</h1>
    <p>
      เลขที่: ${number}<br>
      วันที่ขอเบิก: ${esc(documentData.date)}<br>
      ผู้ขอเบิก: ${esc(documentData.requester)}<br>
      แผนก / หน่วยงาน: ${esc(documentData.department)}
    </p>
    <table>
      <thead>
        <tr>
          <th>ลำดับ</th>
          <th>บาร์โค้ด</th>
          <th>รายการสินค้า</th>
          <th>จำนวน</th>
          <th>หน่วยนับ</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p>
      รวม ${items.length} รายการ<br>
      เหตุผลในการเบิก: ${esc(documentData.reason || "—")}
    </p>
    <div class="sign">
      <div>
        ลงชื่อ __________________<br><br>
        ผู้ขอเบิก<br>
        วันที่ ____/____/____
      </div>
      <div>
        ลงชื่อ __________________<br><br>
        ผู้อนุมัติ<br>
        วันที่ ____/____/____
      </div>
      <div>
        ลงชื่อ __________________<br><br>
        ผู้จ่ายสินค้า<br>
        วันที่ ____/____/____
      </div>
    </div>
  `;

  window.print();
}

function newDoc() {
  if (busy || pending) return;
  if (
    items.length &&
    !saved &&
    !confirm("ต้องการเริ่มใบเบิกใหม่และล้างรายการปัจจุบันหรือไม่?")
  )
    return;
  items = [];
  saved = false;
  requestId = newId();
  $("docno").value = "ออกเลขเมื่อบันทึกลง Sheets";
  $("reason").value = "";
  $("saveBtn").textContent = "บันทึกลง Sheets";
  $("results").replaceChildren();
  $("search").value = "";
  $("message").style.display = "none";
  render();
  syncSharedSettings();
}

async function init() {
  $("date").value = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const cfg = readLocal(STORAGE, null);

  try {
    if (cfg) {
      cfg.id = sheetId(cfg.id);
      cfg.endpoint = SHARED_ENDPOINT;
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
  updateSheet();

  // เครื่องใหม่ไม่มี localStorage ก็อ่านค่าจากจุดเชื่อมต่อกลางได้
  $("endpoint").value = SHARED_ENDPOINT;
  $("endpoint").readOnly = true;
  if (!pending) await syncSharedSettings();
}

init();

"use strict";

// หน้าเว็บรันจาก VS Code ได้ ใช้ Apps Script เป็นตัวกลาง ไม่มี Google OAuth บนหน้าเว็บ
const $ = (id) => document.getElementById(id);
const STORAGE = "berkdee.bridge.v1";

let products = [];
let items = [];
let settings = null;
let saved = false;
let busy = false;
let pending = null;
let catalogLoaded = false;
let requestId = newId();

function newId() {
  return crypto.randomUUID();
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
      sheetId: cfg.id,
      tab: cfg.tab,
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
  $("sheetTab").value = settings?.tab || "สินค้า";
  $("endpoint").value = settings?.endpoint || "";
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
    const tab = $("sheetTab").value.trim();

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

    // บันทึกเฉพาะค่าที่ตรวจเชื่อมต่อสำเร็จ ไม่เขียนทับค่าดีเดิมเมื่อเกิดข้อผิดพลาด
    writeLocal(STORAGE, cfg);
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
      "บันทึกแล้ว ✓ โหลดสินค้า " + products.length + " รายการ";
    updateSheet();
    notify("บันทึกลิงก์ Google Sheet แล้ว ใช้เป็นฐานข้อมูลสินค้าและใบเบิกได้");
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
  state();
}

function removeItem(i) {
  if (saved || busy || pending) return;
  items.splice(i, 1);
  render();
}

function addProduct(code) {
  if (saved || busy || pending) return;
  const p = products.find((x) => x.barcode === code);
  if (!p) {
    notify("ไม่พบบาร์โค้ด " + code + " ในรายการสินค้า กรุณาตรวจสอบชีต", true);
    return;
  }
  const old = items.find((x) => x.barcode === code);
  if (old) old.qty += 1;
  else items.push({ ...p, qty: 1 });
  render();
  notify("เพิ่ม " + p.name + " แล้ว");
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
async function scanPhoto(input) {
  const f = input.files?.[0];
  if (!f || saved || busy || pending) return;
  if (!products.length) {
    notify("กรุณาตั้งค่าชีตและโหลดสินค้าก่อนสแกน", true);
    input.value = "";
    return;
  }
  let url;
  const b = $("cameraBtn");
  b.disabled = true;
  b.textContent = "กำลังอ่านบาร์โค้ด…";
  try {
    if (!window.ZXing)
      throw new Error(
        "โหลดตัวอ่านบาร์โค้ดไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ต หรือกรอกบาร์โค้ด",
      );
    url = URL.createObjectURL(f);
    const reader = new ZXing.BrowserMultiFormatReader();
    const result = await reader.decodeFromImageUrl(url);
    addProduct(result.getText());
  } catch (e) {
    notify(
      e.message?.includes("โหลดตัวอ่าน")
        ? e.message
        : "อ่านบาร์โค้ดไม่สำเร็จ ลองถ่ายภาพใหม่ให้ชัด ตรง และใกล้ขึ้น หรือกรอกบาร์โค้ด",
      true,
    );
  } finally {
    if (url) URL.revokeObjectURL(url);
    input.value = "";
    b.textContent = "▣ ถ่ายภาพสแกนบาร์โค้ด";
    b.disabled = false;
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
}

function init() {
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
      cfg.endpoint = endpointUrl(cfg.endpoint);
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

  $("settings").addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });

  render();
  updateSheet();

  // ใช้งานครั้งถัดไปโหลดสินค้าจากลิงก์ที่จำไว้ได้ทันที
  if (settings && !pending) loadProducts();
}

init();

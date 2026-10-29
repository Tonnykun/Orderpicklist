"use strict";

// ฝั่งใบขอเบิก: สร้างเอกสาร เพิ่มสินค้า บันทึก ดูย้อนหลัง และแก้ไขใบเบิก
// ใช้ classic scripts ตามลำดับใน index.html เพื่อให้ตัวจัดการเหตุการณ์ HTML เรียกใช้งานได้

let items = [];

let saved = false;

let editing = false;

let savedRevision = "original";

let currentDocumentStatus = "ขอเบิก";

let pending = null;

let requestId = newId();

let selectedProduct = null;

let documentHistory = [];

let historyBusy = false;

let historyReloadQueued = false;

let displayedHistoryId = "";

let reservedNumber = "";

let reservationSource = null;

let documentCache = new Map();

let documentCacheSource = "";

let historyGeneration = 0;

let historyDraftSnapshot = null;

let historyPreloadPromise = Promise.resolve();

function historySourceKey(source) { return source ? source.id + "|" + source.endpoint : ""; }

async function preloadHistoryDocuments(source, documents, generation) {
  const sourceKey = historySourceKey(source);
  try {
    for (let offset = 0; offset < documents.length; offset += 15) {
      if (generation !== historyGeneration || historySourceKey(settings) !== sourceKey) return;
      const response = await readBridge(source, "documentBatch", {
        requestIds: JSON.stringify(documents.slice(offset, offset + 15).map((doc) => doc.requestId)),
      });
      if (!Array.isArray(response.documents)) throw new Error("กรุณาอัปเดต Code.gs ให้รองรับการโหลดใบเบิกเบื้องหลัง");
      if (generation !== historyGeneration || historySourceKey(settings) !== sourceKey) return;
      for (const doc of response.documents) {
        if (doc?.requestId && Array.isArray(doc.items) && doc.revision) documentCache.set(doc.requestId, doc);
      }
      $("historyMessage").textContent = `โหลดรายละเอียดใบเบิกแล้ว ${documentCache.size}/${documents.length} ใบ`;
      $("welcomeHistoryStatus").textContent = $("historyMessage").textContent;
    }
    if (generation === historyGeneration) {
      $("historyMessage").textContent = `พร้อมดูย้อนหลัง ${documents.length} ใบเบิก · แก้ไขได้ในสถานะขอเบิกและกำลังจัดเตรียม`;
      $("welcomeHistoryStatus").textContent = `โหลดใบเบิกเบื้องหลังแล้ว ${documents.length} ใบ`;
    }
  } catch (error) {
    if (generation !== historyGeneration) return;
    $("historyMessage").textContent = "โหลดรายละเอียดเบื้องหลังไม่ครบ สามารถเลือกใบเบิกเพื่อโหลดเฉพาะใบได้ · " + error.message;
    $("welcomeHistoryStatus").textContent = "โหลดรายชื่อใบเบิกแล้ว รายละเอียดบางใบจะโหลดเมื่อเลือก";
  }
}

function closeHistoryDocument(force = false) {
  if (!force && (busy || pending)) return;
  if (!force && editing && !confirm("ปิดใบเบิกและยกเลิกการแก้ไขที่ยังไม่ได้บันทึกหรือไม่?")) return;
  $("historyDialog").close();
  const snapshot = historyDraftSnapshot;
  historyDraftSnapshot = null;
  if (snapshot) {
    ({ items, requestId, saved, editing, savedRevision, currentDocumentStatus, reservedNumber, reservationSource } = snapshot);
    for (const [key, value] of Object.entries(snapshot.fields)) $(key).value = value;
    displayedHistoryId = "";
    if (reservationSource) {
      try { writeLocal(STORAGE + ".reservation", { requestId, sheet: reservationSource }); }
      catch { /* คืนร่างในหน่วยความจำได้ แม้พื้นที่จัดเก็บของเบราว์เซอร์ไม่พร้อม */ }
    }
  } else resetDraft();
  $("historySelect").value = "";
  render();
}

function canAddItems() { return editing || (!!reservedNumber && !!reservationSource); }

function requireDocumentNumber() {
  if (canAddItems()) return true;
  return validationFailure("กรุณากด “ใบเบิกใหม่” เพื่อรับเลขที่เอกสารก่อนสแกนหรือเพิ่มสินค้า", $("newBtn"));
}

function viewingHistoryDocument() {
  return !!displayedHistoryId && displayedHistoryId === requestId && (saved || editing || pending?.operation === "update");
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
    return (stage === "all" || (stage === "other" ? !["ขอเบิก", "กำลังจัดเตรียม", "เตรียมส่งมอบ"].includes(docStage) : docStage === stage)) &&
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
  const generation = ++historyGeneration;
  documentCache.clear();
  documentCacheSource = historySourceKey(source);
  historyControls();
  $("historyMessage").textContent = "กำลังโหลดใบเบิก…";
  try {
    const result = await readBridge(source, "documents");
    if (!Array.isArray(result.documents)) throw new Error("กรุณาอัปเดต Code.gs ให้รองรับการเลือกใบเบิกย้อนหลัง");
    if (!sameSource()) return;
    documentHistory = result.documents;
    historyPreloadPromise = preloadHistoryDocuments(source, documentHistory, generation);
    const current = documentHistory.find((doc) => doc.requestId === requestId);
    if (saved && current && !editing && !pending) {
      currentDocumentStatus = current.status;
      state();
    }
    renderHistoryOptions();
    $("historyMessage").textContent = `พบ ${documentHistory.length} ใบเบิก · แก้ไขได้ในสถานะขอเบิกและกำลังจัดเตรียม`;
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
  reservedNumber = "";
  reservationSource = null;
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
  busy = true;
  state();
  try {
    const cached = documentCacheSource === historySourceKey(settings) && documentCache.get(id);
    const doc = cached || (await readBridge(settings, "document", { requestId: id })).document;
    if (!doc || doc.requestId !== id || !Array.isArray(doc.items) || !doc.revision) throw new Error("ข้อมูลใบเบิกไม่ถูกต้อง");
    if (!$("historyDialog").open && !saved) {
      historyDraftSnapshot = {
        items: items.map((item) => ({ ...item })), requestId, saved, editing, savedRevision, currentDocumentStatus,
        reservedNumber, reservationSource,
        fields: Object.fromEntries(["requester", "department", "date", "reason", "docno"].map((key) => [key, $(key).value])),
      };
    }
    documentCache.set(id, doc);
    documentCacheSource = historySourceKey(settings);
    showSavedDocument(doc);
    saved = true;
    editing = false;
    if (!$("historyDialog").open) $("historyDialog").showModal();
    $("historyDialogMessage").textContent = "";
    $("historyMessage").textContent = "";
  } catch (error) {
    $("historySelect").value = displayedHistoryId;
    $("historyMessage").textContent = "เปิดใบเบิกไม่สำเร็จ: " + error.message;
  } finally {
    busy = false;
    render();
  }
}

function state() {
  const locked = busy || saved || !!pending;
  const historical = viewingHistoryDocument();

  for (const element of document.querySelectorAll(
    "main input, main textarea, main select, main button:not(.toast-close), header button",
  )) {
    element.disabled = locked;
  }

  $("settingsBtn").disabled = busy || !!pending || editing || !!pendingPreparation || preparationChanges.size > 0;
  $("newBtn").disabled = busy || !!pending;
  $("userBtn").disabled = !!pending || !!pendingPreparation || preparationBusy || editing;
  $("historyPrintBtn").disabled = busy || printStatusBusy || !!pending || !historical;
  $("historyCloseBtn").disabled = busy || !!pending;
  $("historyAddBtn").hidden = !historical || !editing;
  $("historyAddBtn").disabled = busy || !!pending || !editing || !editableDocumentStatus(currentDocumentStatus);
  for (const key of ["Requester", "Department", "Date", "Reason"]) $("history" + key).disabled = busy || !!pending || !editing;
  $("refreshBtn").disabled = busy || saved || !!pending;
  $("saveBtn").disabled = busy || saved || historical || !items.length;
  $("openScannerBtn").disabled = locked || !canAddItems();
  $("scannerLaunchHint").textContent = canAddItems()
    ? "เลขที่ " + $("docno").value + " · พร้อมสแกนหรือเพิ่มสินค้า"
    : "กด “ใบเบิกใหม่” ในกล่องข้อมูลการขอเบิกเพื่อรับเลขที่เอกสารก่อนเพิ่มสินค้า";
  $("newBtn").textContent = busy && reservationSource && !reservedNumber ? "กำลังรับเลขเอกสาร…" : "＋ ใบเบิกใหม่";
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
  $("historySaveState").textContent = historical ? (saved ? documentStage(currentDocumentStatus) : saveMessage) : "";
  historyControls();
  if (activeUser?.role === "preparation") updatePreparationControls();
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
  if ($("historyDialog").open && historyDraftSnapshot) closeHistoryDocument(true);
  else {
    resetDraft();
    if ($("historyDialog").open) $("historyDialog").close();
  }
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
      throw new Error("แก้ไขได้ในสถานะขอเบิกและกำลังจัดเตรียม ใบเบิกนี้อยู่ในสถานะ " + documentStage(documentData.status));
    }
    let catalog;
    if (!cancelEdit) catalog = await readBridge(settings, "catalog");
    showSavedDocument(documentData);
    documentCache.set(requestId, documentData);
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
      number: pending.number,
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
        <div class="muted item-barcode">${esc(product.barcode)}</div>
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
          ${busy || saved || pending ? "disabled" : ""}
        >
      </td>
      <td>
        <select aria-label="หน่วย ${esc(product.name)}" onchange="changeItemUnit(${index}, this.value)" ${busy || saved || pending ? "disabled" : ""}>
          ${itemUnitOptions(product).map((unit) => `<option value="${esc(unit)}" ${unit === product.unit ? "selected" : ""}>${esc(unit)}</option>`).join("")}
        </select>
      </td>
      <td>
        <button
          class="remove"
          aria-label="ลบ ${esc(product.name)}"
          onclick="removeItem(${index})"
          ${busy || saved || pending ? "disabled" : ""}
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
  for (const [key, input] of [["requester", "historyRequester"], ["department", "historyDepartment"], ["date", "historyDate"], ["reason", "historyReason"]]) $(input).value = $(key).value;
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

function itemUnitOptions(item) {
  const product = products.find((p) => p.barcode === item.barcode);
  return [...new Set([...(product ? productUnits(product) : []), item.unit])];
}

function changeItemUnit(index, unit) {
  if (busy || saved || pending || !canAddItems()) return;
  const item = items[index];
  const product = item && products.find((p) => p.barcode === item.barcode);
  if (!product || !productUnits(product).includes(unit)) {
    render();
    notify("กรุณาเลือกหน่วยที่กำหนดไว้ในชีตสินค้า หรือรีเฟรชรายการสินค้าอีกครั้ง", true);
    return;
  }
  if (items.some((other, i) => i !== index && other.barcode === item.barcode && other.unit === unit)) {
    render();
    notify("มีสินค้านี้ในหน่วย “" + unit + "” แล้ว กรุณาปรับจำนวนที่รายการนั้น หรือลบรายการที่เลือกผิด", true);
    return;
  }
  item.unit = unit;
  render();
}

function addProduct(code) {
  if (saved || busy || pending || $("productDialog").open) return;
  if (!requireDocumentNumber()) return;

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
  if (!requireDocumentNumber()) return;
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
    b.textContent = p.name;
    b.onclick = () => addProduct(p.barcode);
    root.append(b);
  }
  if (!matches.length) root.textContent = "ไม่พบสินค้า";
}
// วงจรกล้องแยกจากสถานะใบเบิก ปิด Popup แล้วต้องหยุดกล้องเสมอ

function openHistoryScanner() {
  if (busy || saved || pending || !editing || !viewingHistoryDocument() || !editableDocumentStatus(currentDocumentStatus)) return;
  $("barcode").value = "";
  $("search").value = "";
  $("results").replaceChildren();
  openScanner();
}

function openScanner() {
  if (busy || saved || pending) return;
  if (!requireDocumentNumber()) return;
  if (!settings) {
    openSettings();
    return;
  }
  if (!catalogLoaded) {
    notify("กรุณากดโหลดใหม่เพื่อโหลดรายการสินค้าก่อนเปิดสแกน", true);
    return;
  }

  scannerMode = "requisition";
  preparationScanRequestId = "";
  $("scannerCameraHint").textContent = "เล็งบาร์โค้ดให้ชัด แล้วระบุจำนวนและหน่วยก่อนเพิ่มรายการ";
  $("scannerBarcodeBtn").textContent = "เพิ่มลงรายการขอเบิก";
  $("scannerSearchField").hidden = false;
  $("preparationScanMatches").replaceChildren();
  $("scannerTitle").textContent = editing ? "เพิ่มสินค้าในใบเบิก " + $("docno").value : "สแกนสินค้าเพื่อสร้างใบเบิก";
  $("scannerDoneBtn").textContent = editing ? "เสร็จแล้ว กลับไปแก้ไขใบเบิก" : "เสร็จแล้ว ดูรายการขอเบิก";
  $("scannerDialog").showModal();
  document.body.classList.add("scanner-open");
  $("scannerCount").textContent = items.length + " รายการในใบเบิก";
  scannerMessage("เปิดกล้องสแกน หรือกรอกบาร์โค้ดสินค้า");
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
    if (!$(id).value.trim()) missing.push({ input: $("historyDialog").open
      ? $("history" + id[0].toUpperCase() + id.slice(1)) : $(id), message });
  }
  if (missing.length) return validationFailure(missing.map((field) => "• " + field.message).join("\n"), missing[0].input);
  if (!settings) return validationFailure("กรุณาตั้งค่าชีตก่อนบันทึกหรือพิมพ์ใบเบิก");
  if (!saved && !editing && !requireDocumentNumber()) return false;
  if (!items.length || items.length > 500) return validationFailure("กรุณาเพิ่มสินค้า 1 ถึง 500 รายการก่อนบันทึกหรือพิมพ์");
  const invalidQuantity = items.findIndex((p) => !Number.isFinite(p.qty) || p.qty <= 0 || p.qty > 1000000);
  if (invalidQuantity >= 0) {
    const root = $(viewingHistoryDocument() ? "historyItems" : "items");
    return validationFailure("กรุณาระบุจำนวนของ " + items[invalidQuantity].name + " มากกว่า 0 และไม่เกิน 1,000,000", root.querySelectorAll('input[type="number"]')[invalidQuantity]);
  }
  return true;
}

function printDoc() {
  if (busy || printStatusBusy || !valid() || pending) return;
  const printContext = saved && !editing ? { requestId, revision: savedRevision, source: { ...settings } } : null;

  const documentData = payload();
  const number = esc($("docno").value) + (saved ? "" : editing ? " (ฉบับแก้ไข — ยังไม่ได้บันทึก)" : " (ฉบับร่าง — ยังไม่ได้บันทึก)");
  return renderRequisitionPrint(documentData, number, printContext);
}

function resetDraft() {
  reservedNumber = "";
  reservationSource = null;
  localStorage.removeItem(STORAGE + ".reservation");
  items = [];
  saved = false;
  editing = false;
  savedRevision = "original";
  currentDocumentStatus = "ขอเบิก";
  displayedHistoryId = "";
  $("historySelect").value = "";
  requestId = newId();
  $("docno").value = "กดใบเบิกใหม่เพื่อรับเลขเอกสาร";
  $("date").value = bangkokToday();
  $("reason").value = "";
  if (activeUser?.role === "requisition") $("requester").value = activeUser.name;
  $("results").replaceChildren();
  $("search").value = "";
}

async function newDoc() {
  if (busy || pending) return;
  if (!settings) return validationFailure("กรุณาตั้งค่าชีตก่อนสร้างใบเบิก");
  if ((items.length || reservedNumber) && !saved && !confirm("ต้องการสร้างใบเบิกใหม่และล้างรายการปัจจุบันหรือไม่? เลขเดิมที่จองไว้จะไม่ถูกนำกลับมาใช้ซ้ำ")) return;
  // ถ้าการรับเลขครั้งก่อนขัดข้อง ใช้ requestId เดิมเพื่อตรวจและส่งซ้ำอย่างปลอดภัย
  if (!reservationSource || reservedNumber || saved || editing) {
    resetDraft();
    reservationSource = { ...settings };
  }
  busy = true;
  state();
  try {
    writeLocal(STORAGE + ".reservation", { requestId, sheet: reservationSource });
    let result = await readBridge(reservationSource, "reservation", { requestId });
    if (result.status === "saved") throw new Error("ใบเบิกนี้บันทึกแล้ว กรุณาเลือกใบเบิกที่บันทึกไว้ หรือโหลดหน้าใหม่");
    if (result.status !== "reserved") {
      const body = { action: "reserve", sheetId: reservationSource.id, requestId,
        requester: $("requester").value.trim(), department: $("department").value.trim(), date: $("date").value };
      authorizeEndpointRequest(reservationSource.endpoint, body);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 25000);
      try {
        await fetch(reservationSource.endpoint, { method: "POST", mode: "no-cors", credentials: "omit",
          headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body), signal: controller.signal });
      } catch { /* ตรวจเลขที่จองไว้ แม้คำตอบ POST ขาดหาย */ }
      finally { clearTimeout(deadline); }
      for (let attempt = 0; attempt < 6; attempt++) {
        result = await readBridge(reservationSource, "reservation", { requestId });
        if (result.status === "reserved") break;
        if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    if (result.status !== "reserved" || !/^REQ-\d{9,}$/.test(result.number || "")) {
      throw new Error("ยังไม่ได้รับเลขเอกสาร กรุณากดใบเบิกใหม่เพื่อตรวจผลเดิมอีกครั้ง");
    }
    reservedNumber = result.number;
    $("docno").value = reservedNumber;
    notify("สร้างใบเบิก " + reservedNumber + " แล้ว สามารถสแกนหรือเพิ่มสินค้าได้");
  } catch (error) {
    notify("สร้างใบเบิกไม่สำเร็จ: " + error.message + " · หากยังไม่ได้อัปเดต กรุณา Deploy Code.gs เวอร์ชันล่าสุด", true);
  } finally {
    busy = false;
    render();
  }
}

"use strict";

// ฝั่งเตรียมของ: เลือกใบเบิก ตรวจบาร์โค้ด Checkbox อัปเดตสถานะ และพิมพ์
// ใช้ classic scripts ตามลำดับใน index.html เพื่อให้ตัวจัดการเหตุการณ์ HTML เรียกใช้งานได้

let preparationBusy = false;

let preparationRequests = [];

let preparationSelectedId = "";

let preparationChanges = new Map();
let preparationAmounts = new Map();

function preparationItemAmount(request, item) {
  return { note: item.preparerNote || '', ...(preparationAmounts.get(preparationChangeKey(request.requestId, item.itemId)) || {
    qty: Number(item.preparedQty ?? (item.prepared ? item.qty : 0)),
    unit: item.preparedUnit || item.unit,
    completion: item.completion || (item.prepared ? "full" : "none"),
  }) };
}

function storePreparationAmount(request, item, amount) {
  const key = preparationChangeKey(request.requestId, item.itemId);
  const baseline = { qty: Number(item.preparedQty ?? (item.prepared ? item.qty : 0)), unit: item.preparedUnit || item.unit,
    completion: item.completion || (item.prepared ? "full" : "none"), note: item.preparerNote || "" };
  if (amount.qty === baseline.qty && amount.unit === baseline.unit && amount.completion === baseline.completion && (amount.note || "") === baseline.note) {
    preparationAmounts.delete(key);
    preparationChanges.delete(key);
  } else {
    preparationAmounts.set(key, amount);
    preparationChanges.set(key, amount.completion === "full");
  }
  updatePreparationControls();
}

function changePreparationAmount(index, qty, unit) {
  const request = currentPreparationDocument();
  const item = request?.items[index];
  if (!item || preparationBusy || pendingPreparation || activeUser?.role !== "preparation" || !editableDocumentStatus(request.status)) return;
  const previous = preparationItemAmount(request, item);
  const amount = { ...previous, qty: qty === null ? previous.qty : qty === "" ? NaN : Number(qty), unit: unit === null ? previous.unit : unit, completion: "partial" };
  storePreparationAmount(request, item, amount);
  $("preparedFull" + index).setAttribute("aria-pressed", "false");
  $("preparedPartial" + index).setAttribute("aria-pressed", "true");
  $("preparedOut" + index).setAttribute("aria-pressed", "false");
  $("preparedResult" + index).textContent = "ได้บางส่วน";
}

function setPreparationCompletion(index, completion) {
  const request = currentPreparationDocument();
  const item = request?.items[index];
  if (!item || !["full", "partial", "out"].includes(completion) || preparationBusy || pendingPreparation || activeUser?.role !== "preparation" || !editableDocumentStatus(request.status)) return;
  const previous = preparationItemAmount(request, item);
  const amount = completion === "full" ? { qty: Number(item.qty), unit: item.unit, completion: "full" }
    : completion === "out" ? { qty: 0, unit: previous.unit, completion: "out" }
    : { qty: previous.completion === "full" ? 0 : previous.qty, unit: previous.unit, completion: "partial" };
  storePreparationAmount(request, item, { ...amount, note: previous.note });
  renderPreparation();
}

function changePreparationNote(index, note) {
  const request = currentPreparationDocument();
  const item = request?.items[index];
  if (!item || preparationBusy || pendingPreparation || activeUser?.role !== "preparation" || !editableDocumentStatus(request.status)) return;
  if (note.length > 500) return;
  storePreparationAmount(request, item, { ...preparationItemAmount(request, item), note });
}

let pendingPreparation = null;

let completedPreparationDocument = null;

function currentPreparationDocument() {
  return preparationRequests.find((request) => request.requestId === preparationSelectedId)
    || (completedPreparationDocument?.requestId === preparationSelectedId ? completedPreparationDocument : null);
}

let preparationScanRequestId = "";

function preparationScanRequest() {
  if (activeUser?.role !== "preparation" || preparationBusy || pendingPreparation || preparationSelectedId !== preparationScanRequestId) return null;
  return preparationRequests.find((request) => request.requestId === preparationScanRequestId && editableDocumentStatus(request.status));
}

function updatePreparationScanCount(request) {
  const selected = request.items.filter((item) => preparationChanges.get(preparationChangeKey(request.requestId, item.itemId)) ?? item.prepared === true).length;
  $("scannerCount").textContent = `เลือกครบแล้ว ${selected}/${request.items.length} รายการ`;
}

function openPreparationScanner() {
  if (activeUser?.role !== "preparation" || preparationBusy || pendingPreparation || !preparationSelectedId) return;
  preparationScanRequestId = preparationSelectedId;
  const request = preparationScanRequest();
  if (!request) return;
  scannerMode = "preparation";
  $("scannerTitle").textContent = "ตรวจสอบสินค้าในใบเบิก " + request.number;
  $("scannerCameraHint").textContent = "สแกนสินค้าที่ต้องการตรวจสอบ หากตรงกับใบเบิก ระบบจะเลือกครบและใส่จำนวนที่จัดได้ให้";
  $("scannerBarcodeBtn").textContent = "ตรวจสอบสินค้า";
  $("scannerSearchField").hidden = true;
  $("results").replaceChildren();
  $("preparationScanMatches").replaceChildren();
  $("barcode").value = "";
  $("scannerDoneBtn").textContent = "กลับไปหน้าเตรียมของ";
  updatePreparationScanCount(request);
  scannerMessage("เปิดกล้องสแกน หรือกรอกบาร์โค้ดเพื่อตรวจสอบสินค้ากับใบเบิกที่เลือก");
  $("scannerDialog").showModal();
  document.body.classList.add("scanner-open");
}

function markScannedPreparationItem(itemId) {
  const request = preparationScanRequest();
  const item = request?.items.find((entry) => String(entry.itemId) === String(itemId));
  if (!item || scannerMode !== "preparation") return;
  const alreadyChecked = preparationChanges.get(preparationChangeKey(request.requestId, item.itemId)) ?? item.prepared === true;
  changePreparationItem(request, item, { checked: true });
  renderPreparation();
  $("preparationScanMatches").replaceChildren();
  const message = (alreadyChecked ? "รายการนี้เลือกครบไว้แล้ว: " : "สินค้าถูกต้อง เลือกครบแล้ว: ") + item.name + " · " + item.qty + " " + item.unit + " · กดอัปเดตสถานะเมื่อเตรียมเสร็จ";
  closeScanner();
  $("preparationDialogMessage").textContent = message;
}

function checkPreparationBarcode(code) {
  if (scannerMode !== "preparation") return;
  const request = preparationScanRequest();
  if (!request) { scannerMessage("กรุณาปิดหน้าสแกนและเลือกใบเบิกที่ต้องการเตรียมอีกครั้ง", true); return; }
  stopCameraScan();
  $("preparationScanMatches").replaceChildren();
  const matches = request.items.filter((item) => String(item.barcode) === String(code ?? "").trim());
  if (!matches.length) { scannerMessage("สินค้าบาร์โค้ดนี้ไม่มีในใบเบิก " + request.number + " · ยังไม่ได้เลือกรายการใด", true); return; }
  if (matches.length === 1) { markScannedPreparationItem(matches[0].itemId); return; }
  scannerMessage("พบสินค้าบาร์โค้ดเดียวกันหลายหน่วย กรุณาเลือกรายการที่กำลังเตรียม");
  for (const item of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "asidebtn";
    button.textContent = item.name + " · " + item.qty + " " + item.unit;
    button.onclick = () => markScannedPreparationItem(item.itemId);
    $("preparationScanMatches").append(button);
  }
}

function preparationChangeKey(id, itemId) { return JSON.stringify([id, String(itemId)]); }

function updatePreparationControls() {
  const locked = preparationBusy || !!pendingPreparation;
  const request = currentPreparationDocument();
  const ready = request && !editableDocumentStatus(request.status);
  $("preparationRequests").querySelectorAll("input, textarea, select, button").forEach((input) => { input.disabled = locked || ready; });
  $("preparationSelect").disabled = locked;
  $("preparationCloseBtn").disabled = locked;
  $("preparationScanBtn").disabled = locked || ready || !request;
  $("preparationPrintBtn").disabled = locked || printStatusBusy || !request;
  $("loadPreparationBtn").disabled = locked;
  $("updatePreparationBtn").disabled = preparationBusy || (!pendingPreparation && !preparationRequests.some((request) => request.requestId === preparationSelectedId));
  $("updatePreparationBtn").textContent = pendingPreparation ? "ตรวจผล / อัปเดตซ้ำ" : "อัปเดตสถานะ";
  $("userBtn").disabled = preparationBusy || !!pending || !!pendingPreparation || editing;
  $("settingsBtn").disabled = busy || preparationBusy || !!pending || !!pendingPreparation || editing || preparationChanges.size > 0;
  const count = request ? request.items.filter((item) => preparationChanges.has(preparationChangeKey(request.requestId, item.itemId))).length : 0;
  $("preparationSaveHint").textContent = pendingPreparation ? "มีการอัปเดตรอยืนยันผล กรุณาตรวจผลหรือส่งชุดเดิมซ้ำ"
    : ready ? "อัปเดตเป็นเตรียมส่งมอบแล้ว สามารถกดพิมพ์ / PDF หรือปิดหน้าต่างได้"
    : request ? `ปรับข้อมูล ${count} รายการ · กดอัปเดตเพื่อเตรียมส่งมอบได้ แม้เตรียมสินค้าไม่ครบ`
    : "เลือกใบเบิก ระบุจำนวนที่จัดได้ แล้วกดอัปเดตสถานะ";
}

function selectPreparation() {
  if (preparationBusy || pendingPreparation) return;
  preparationSelectedId = $("preparationSelect").value;
  completedPreparationDocument = null;
  renderPreparation();
  if (preparationSelectedId && !$("preparationDialog").open) $("preparationDialog").showModal();
}

function closePreparationDialog() {
  if (preparationBusy || pendingPreparation) return;
  $("preparationDialog").close();
  preparationSelectedId = "";
  completedPreparationDocument = null;
  renderPreparation();
}

function changePreparationItem(request, item, checkbox) {
  if (preparationBusy || pendingPreparation || activeUser?.role !== "preparation" || !editableDocumentStatus(request.status)) {
    checkbox.checked = preparationChanges.get(preparationChangeKey(request.requestId, item.itemId)) ?? item.prepared === true;
    return;
  }
  storePreparationAmount(request, item, { qty: checkbox.checked ? Number(item.qty) : 0, unit: item.unit, completion: checkbox.checked ? "full" : "none", note: preparationItemAmount(request, item).note });
}

async function loadPreparation(discardChanges = false) {
  if (preparationBusy) return;
  if (pendingPreparation && preparationRequests.length) return;
  if (preparationChanges.size) {
    if (!discardChanges || !confirm("โหลดใบเบิกใหม่และยกเลิกจำนวนและผลการจัดที่ยังไม่ได้อัปเดตหรือไม่?")) return;
    preparationChanges.clear();
    preparationAmounts.clear();
  }
  if (!settings || busy) {
    $("preparationMessage").textContent = busy
      ? "กำลังเชื่อมต่อชีต ระบบจะโหลดใบเบิกให้เมื่อเชื่อมต่อสำเร็จ"
      : "ยังเชื่อมต่อชีตไม่ได้ กรุณาตั้งค่าชีตแล้วกดโหลดใบเบิกใหม่";
    $("preparationSummaryState").textContent = $("preparationMessage").textContent;
    return;
  }
  preparationBusy = true;
  updatePreparationControls();
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
    renderPreparation();
    if (pendingPreparation && !$("preparationDialog").open) $("preparationDialog").showModal();
  }
}

function renderPreparation() {
  updatePreparationSummary();
  const root = $("preparationRequests");
  root.replaceChildren();
  const select = $("preparationSelect");
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = preparationRequests.length ? "เลือกใบเบิกเพื่อแสดงรายการ" : "ไม่มีใบเบิกที่รอเตรียม";
  select.append(placeholder);
  for (const request of preparationRequests) {
    const option = document.createElement("option");
    option.value = request.requestId;
    option.textContent = [request.number, request.requester, request.department, documentStage(request.status)].filter(Boolean).join(" · ");
    select.append(option);
  }
  if (!currentPreparationDocument()) preparationSelectedId = "";
  select.value = preparationSelectedId;
  const selected = currentPreparationDocument();
  $("preparationDialogTitle").textContent = selected ? "ใบเบิก " + selected.number : "ยืนยันสถานะเตรียมของ";
  $("preparationDialogMessage").textContent = $("preparationMessage").textContent;
  for (const request of selected ? [selected] : []) {
    const card = document.createElement("section");
    card.className = "preparation-request";
    const heading = document.createElement("h3");
    heading.textContent = request.requester + " · " + documentStage(request.status || "ขอเบิก");
    const details = document.createElement("p");
    details.className = "muted";
    details.textContent = [request.department, request.date, request.reason].filter(Boolean).join(" · ");
    card.append(heading, details);
    request.items.forEach((item, index) => {
      const amount = preparationItemAmount(request, item);
      const itemCard = document.createElement("article");
      itemCard.className = "preparation-product-card";
      const product = products.find((entry) => entry.barcode === item.barcode);
      const units = [...new Set([item.unit, ...(product ? productUnits(product) : []), amount.unit])];
      const disabled = preparationBusy || pendingPreparation || !editableDocumentStatus(request.status) ? "disabled" : "";
      itemCard.innerHTML = `
        <div class="preparation-product-heading"><strong class="preparation-item-name">${esc(item.name)}</strong><span id="preparedResult${index}" class="prepared-result">${amount.completion === "full" ? "ครบ" : amount.completion === "partial" ? "ได้บางส่วน" : amount.completion === "out" ? "หมด" : "ยังไม่ระบุ"}</span></div>
        ${item.note ? `<p class="preparation-item-note">หมายเหตุผู้เบิก: ${esc(item.note)}</p>` : ""}
        <div class="preparation-card-fields preparation-requested-fields">
          <label>จำนวนขอเบิก<output class="requested-value">${esc(item.qty)}</output></label>
          <label>หน่วย<output class="requested-value">${esc(item.unit)}</output></label>
        </div>
        <div class="preparation-card-fields">
          <label>จำนวนที่จัดได้<input class="prepared-qty" type="number" min="0" max="1000000" step="any" aria-label="จำนวนที่จัดได้ ${esc(item.name)}" value="${Number.isFinite(amount.qty) ? amount.qty : ""}" oninput="changePreparationAmount(${index}, this.value, null)" ${disabled}></label>
          <label>หน่วย<select class="prepared-unit" aria-label="หน่วยที่จัดได้ ${esc(item.name)}" onchange="changePreparationAmount(${index}, null, this.value)" ${disabled}>${units.map((unit) => `<option value="${esc(unit)}" ${unit === amount.unit ? "selected" : ""}>${esc(unit)}</option>`).join("")}</select></label>
        </div>
        <label class="preparation-note-field">หมายเหตุผู้จัด
          <textarea id="preparedNote${index}" class="prepared-note" rows="2" maxlength="500" aria-label="หมายเหตุผู้จัด ${esc(item.name)}" placeholder="ระบุหมายเหตุ (ถ้ามี)" oninput="changePreparationNote(${index}, this.value)" ${disabled}>${esc(amount.note)}</textarea>
        </label>
        <div class="preparation-result-actions">
          <button id="preparedFull${index}" type="button" aria-pressed="${amount.completion === "full"}" onclick="setPreparationCompletion(${index}, 'full')" ${disabled}>ครบ</button>
          <button id="preparedPartial${index}" type="button" aria-pressed="${amount.completion === "partial"}" onclick="setPreparationCompletion(${index}, 'partial')" ${disabled}>ได้บางส่วน</button>
          <button id="preparedOut${index}" type="button" aria-pressed="${amount.completion === "out"}" onclick="setPreparationCompletion(${index}, 'out')" ${disabled}>หมด</button>
        </div>`;
      card.append(itemCard);
    });
    root.append(card);
  }
  updatePreparationControls();
}

async function updatePreparationStatus() {
  if (preparationBusy || busy || activeUser?.role !== "preparation") return;
  if (!pendingPreparation) {
    const request = preparationRequests.find((entry) => entry.requestId === preparationSelectedId);
    if (!request) return;
    const changedItems = request.items.filter((item) => preparationChanges.has(preparationChangeKey(request.requestId, item.itemId)));
    if (changedItems.some((item) => {
      const amount = preparationItemAmount(request, item);
      return !Number.isFinite(amount.qty) || amount.qty < 0 || amount.qty > 1000000 || (amount.unit === item.unit && amount.qty > Number(item.qty));
    })) {
      $("preparationDialogMessage").textContent = "กรุณาระบุจำนวนที่จัดได้ตั้งแต่ 0 และไม่เกินจำนวนขอเบิกในหน่วยเดียวกัน";
      return;
    }
    const changes = changedItems.map((item) => {
      const amount = preparationItemAmount(request, item);
      return { itemId: String(item.itemId), prepared: amount.completion === "full", basePrepared: item.prepared === true,
        preparedQty: amount.qty, preparedUnit: amount.unit, completion: amount.completion, preparerNote: amount.note || "", basePreparationWriteId: item.preparationWriteId || "" };
    });
    pendingPreparation = { sheet: { ...settings }, body: { action: "prepareBatch", sheetId: settings.id,
      requestId: request.requestId, baseRevision: request.revision || "original", preparedBy: activeUser.name, writeId: newId(), changes } };
  }
  const queued = pendingPreparation;
  preparationBusy = true;
  renderPreparation();
  $("preparationMessage").textContent = "กำลังอัปเดตสถานะที่เลือกพร้อมกัน…";
  $("preparationDialogMessage").textContent = $("preparationMessage").textContent;
  try {
    writeLocal(STORAGE + ".preparation", queued);
    const check = () => readBridge(queued.sheet, "preparationBatchStatus", { requestId: queued.body.requestId, writeId: queued.body.writeId });
    let result = await check();
    if (result.status !== "saved") {
      authorizeEndpointRequest(queued.sheet.endpoint, queued.body);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      try {
        await fetch(queued.sheet.endpoint, { method: "POST", mode: "no-cors", credentials: "omit", signal: controller.signal,
          headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(queued.body) });
      } catch { /* ใช้ผลยืนยันจากชีตแทนผล POST */ }
      finally { clearTimeout(timer); }
      for (let attempt = 0; attempt < 6; attempt++) {
        result = await check();
        if (["saved", "rejected"].includes(result.status)) break;
        if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    if (result.status === "rejected") {
      localStorage.removeItem(STORAGE + ".preparation");
      pendingPreparation = null;
      throw new Error(result.message);
    }
    if (result.status !== "saved" || !result.document) throw new Error("ยังยืนยันผลไม่ได้ กดตรวจผล / อัปเดตซ้ำเพื่อส่งชุดเดิมอีกครั้ง");
    const doc = result.document;
    for (const item of queued.body.changes) {
      preparationChanges.delete(preparationChangeKey(queued.body.requestId, item.itemId));
      preparationAmounts.delete(preparationChangeKey(queued.body.requestId, item.itemId));
    }
    preparationRequests = preparationRequests.map((request) => request.requestId === doc.requestId ? { ...request, ...doc } : request)
      .filter((request) => editableDocumentStatus(request.status) && request.items.some((item) => !item.prepared));
    localStorage.removeItem(STORAGE + ".preparation");
    pendingPreparation = null;
    completedPreparationDocument = { ...doc, source: { ...queued.sheet } };
    preparationSelectedId = doc.requestId;
    documentCache.delete(doc.requestId);
    ++historyGeneration;
    $("preparationMessage").textContent = "อัปเดตสถานะแล้ว · " + doc.number + " · " + documentStage(doc.status);
    notify("อัปเดตใบเบิก " + doc.number + " เป็น " + documentStage(doc.status) + " แล้ว");
  } catch (error) {
    $("preparationMessage").textContent = "อัปเดตไม่สำเร็จหรือยังยืนยันผลไม่ได้: " + error.message;
  } finally {
    preparationBusy = false;
    renderPreparation();
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

function printPreparationDocument() {
  if (preparationBusy || pendingPreparation || printStatusBusy || activeUser?.role !== "preparation") return;
  const request = currentPreparationDocument();
  if (!request || !request.items.length) return;
  const printItems = request.items.map((item) => {
    const amount = preparationItemAmount(request, item);
    return { ...item, qty: Number(item.qty), preparedQty: amount.qty, preparedUnit: amount.unit, completion: amount.completion, preparerNote: amount.note };
  });
  if (printItems.some((item) => !Number.isFinite(item.preparedQty) || item.preparedQty < 0)) {
    $("preparationDialogMessage").textContent = "กรุณาระบุจำนวนที่จัดได้ตั้งแต่ 0 ก่อนเปิดตัวอย่างเอกสาร";
    return;
  }
  return renderRequisitionPrint({ ...request, items: printItems }, esc(request.number), {
    requestId: request.requestId, revision: request.revision || "original", source: { ...(request.source || settings) },
  }, true);
}

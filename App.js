"use strict";

// จุดเริ่มต้นระบบ: โหลดหลัง Shared.js, Requisition.js และ Preparation.js เพื่อเริ่มระบบและเลือกโหมด
// ใช้ classic scripts ตามลำดับใน index.html เพื่อให้ตัวจัดการเหตุการณ์ HTML เรียกใช้งานได้

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
  if (pendingPreparation && role !== "preparation") {
    $("welcomeCatalogStatus").textContent = "มีสถานะเตรียมของรอยืนยันผล กรุณาเลือกสำหรับเตรียมของเพื่อตรวจผลก่อน";
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
  else if (!busy && documentCacheSource !== historySourceKey(settings)) loadRequisitionHistory();
}

async function init() {
  $("preparationDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closePreparationDialog();
  });
  $("historyDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeHistoryDocument();
  });
  document.addEventListener("click", (event) => {
    const menu = $("workspaceMenu");
    if (menu?.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    const menu = $("workspaceMenu");
    if (event.key === "Escape" && menu?.open) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
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
    if (queued.operation !== "update") {
      reservedNumber = /^REQ-\d{9,}$/.test(queued.number || "") ? queued.number : "";
      reservationSource = queued.sheet;
      if (reservedNumber) $("docno").value = reservedNumber;
    }
    editing = queued.operation === "update";
    displayedHistoryId = editing ? queued.requestId : "";
    savedRevision = queued.baseRevision || "original";
    currentDocumentStatus = queued.documentStatus || "ขอเบิก";
    if (editing) $("docno").value = queued.number || "รอยืนยันการแก้ไข";

    for (const key of ["requester", "department", "date", "reason"]) {
      $(key).value = queued[key] || "";
    }

    notify("กู้คืนใบเบิกที่รอยืนยันผลแล้ว กดตรวจผลบันทึกหรือบันทึกซ้ำได้");
  }

  $("scannerDialog").addEventListener("close", () => {
    stopCameraScan();
    document.body.classList.remove("scanner-open");
    if (scannerMode === "preparation") {
      scannerMode = "requisition";
      preparationScanRequestId = "";
      $("preparationScanMatches").replaceChildren();
    }
  });
  $("scannerDialog").addEventListener("cancel", stopCameraScan);
  window.addEventListener("pagehide", stopCameraScan);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCameraScan();
  });

  $("settings").addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });

  const queuedPreparation = !pending && readLocal(STORAGE + ".preparation", null);
  if (queuedPreparation?.sheet && queuedPreparation.body?.action === "prepareBatch" && Array.isArray(queuedPreparation.body.changes)) {
    try {
      queuedPreparation.sheet.id = sheetId(queuedPreparation.sheet.id);
      queuedPreparation.sheet.endpoint = endpointUrl(queuedPreparation.sheet.endpoint);
      if (queuedPreparation.body.sheetId !== queuedPreparation.sheet.id || !/^[a-f0-9-]{36}$/.test(queuedPreparation.body.requestId || "") ||
          !/^[a-f0-9-]{36}$/.test(queuedPreparation.body.writeId || "") || queuedPreparation.body.changes.length > 500) throw new Error("ข้อมูลรอยืนยันไม่ถูกต้อง");
      pendingPreparation = queuedPreparation;
      settings = queuedPreparation.sheet;
      preparationSelectedId = queuedPreparation.body.requestId;
      for (const change of queuedPreparation.body.changes) preparationChanges.set(preparationChangeKey(preparationSelectedId, change.itemId), change.prepared);
      $("welcomeCatalogStatus").textContent = "มีสถานะเตรียมของรอยืนยัน กรุณาเลือกสำหรับเตรียมของ";
    } catch { localStorage.removeItem(STORAGE + ".preparation"); }
  }
  const draftReservation = !pending && !pendingPreparation && readLocal(STORAGE + ".reservation", null);
  if (draftReservation?.requestId && draftReservation.sheet) {
    try {
      const source = { ...draftReservation.sheet, id: sheetId(draftReservation.sheet.id), endpoint: endpointUrl(draftReservation.sheet.endpoint) };
      if (!/^[a-f0-9-]{36}$/.test(draftReservation.requestId)) throw new Error("รหัสร่างไม่ถูกต้อง");
      reservationSource = source;
      settings = source;
      requestId = draftReservation.requestId;
    } catch { localStorage.removeItem(STORAGE + ".reservation"); }
  }
  render();

  // เครื่องใหม่ไม่มี localStorage ก็อ่านค่าจากจุดเชื่อมต่อกลางได้
  $("endpoint").value = settings?.endpoint || appConfig?.defaultDataEndpoint || SHARED_ENDPOINT;
  if (pendingPreparation) setCatalogStatus("มีสถานะเตรียมของรอยืนยัน กรุณาเลือกสำหรับเตรียมของเพื่อตรวจผล");
  else if (!pending) await syncSharedSettings();
  else setCatalogStatus("มีใบเบิกรอยืนยันผล กรุณาเลือกสำหรับเบิกเพื่อตรวจผลบันทึก");
  if (pending?.operation === "update" && !$("historyDialog").open) $("historyDialog").showModal();
  if (!pending && reservationSource) {
    busy = true;
    state();
    try {
      const result = await readBridge(reservationSource, "reservation", { requestId });
      if (result.status === "saved") resetDraft();
      else if (result.status === "reserved") {
        reservedNumber = result.number;
        $("docno").value = reservedNumber;
      }
    } catch { notify("ยังตรวจเลขเอกสารเดิมไม่ได้ กดใบเบิกใหม่เพื่อลองอีกครั้ง", true); }
    finally { busy = false; render(); }
  }
}

init();

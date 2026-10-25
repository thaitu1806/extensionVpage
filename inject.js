// Chạy trong MAIN world. Set giá trị ô numeric QUA ANGULAR (Ivy) để UI không bị
// render lại về giá trị cũ.

(function () {
  const TAG = "[DS-Fill inject]";
  function log(...a) { console.log(TAG, ...a); }
  log("đã nạp vào main world. ng =", typeof window.ng);

  function findMarked(marker) { return document.querySelector(`[data-dsfill="${marker}"]`); }
  function readNum(s) { const d = String(s || "").replace(/[^\d]/g, ""); return d ? parseInt(d, 10) : NaN; }

  // Lấy Angular debug API (Ivy). Ở production có thể bị tắt -> trả null.
  function ngApi() {
    const ng = window.ng;
    if (ng && typeof ng.getDirectives === "function") return ng;
    return null;
  }

  // Tìm tất cả directive/component gắn trên element và tổ tiên gần.
  function collectDirectives(el) {
    const ng = ngApi();
    const list = [];
    if (!ng) return list;
    let node = el;
    for (let i = 0; i < 8 && node; i++) {
      try {
        const ds = ng.getDirectives(node) || [];
        for (const d of ds) list.push(d);
        const comp = ng.getComponent && ng.getComponent(node);
        if (comp) list.push(comp);
      } catch (_) {}
      node = node.parentElement;
    }
    return list;
  }

  // Từ danh sách directive, tìm FormControl và ControlValueAccessor.
  function findControl(el) {
    const dirs = collectDirectives(el);
    const result = { control: null, cva: null, names: [] };
    for (const d of dirs) {
      if (!d || typeof d !== "object") continue;
      result.names.push(d.constructor && d.constructor.name);

      // NgControl: FormControlName / NgModel / FormControlDirective
      if (!result.control && d.control && typeof d.control.setValue === "function") {
        result.control = d.control;
      }
      // Trực tiếp là FormControl
      if (!result.control && typeof d.setValue === "function" && "valueChanges" in d) {
        result.control = d;
      }
      // ControlValueAccessor
      if (!result.cva && typeof d.writeValue === "function" && typeof d.registerOnChange === "function") {
        result.cva = d;
      }
    }
    return result;
  }

  function setViaAngular(el, value) {
    const num = Number(value);
    const info = findControl(el);
    log("findControl names:", (info.names || []).filter(Boolean).join(", ") || "(rỗng)");

    const how = [];
    try {
      if (info.control) {
        info.control.setValue(num, { emitEvent: true });
        info.control.markAsDirty && info.control.markAsDirty();
        info.control.markAsTouched && info.control.markAsTouched();
        info.control.updateValueAndValidity && info.control.updateValueAndValidity();
        how.push("FormControl.setValue");
      }
    } catch (e) { log("setValue lỗi:", e.message); }

    try {
      if (info.cva && typeof info.cva.writeValue === "function") {
        info.cva.writeValue(num);
        const onCh = info.cva.onChange || info.cva._onChange ||
          (info.cva.onChangeCallback) || null;
        if (typeof onCh === "function") onCh(num);
        how.push("CVA.writeValue");
      }
    } catch (e) { log("writeValue lỗi:", e.message); }

    // Kích change detection trên component gần nhất.
    try {
      const ng = ngApi();
      if (ng && ng.applyChanges && ng.getComponent) {
        let node = el;
        for (let i = 0; i < 8 && node; i++) {
          const c = ng.getComponent(node);
          if (c) { ng.applyChanges(c); break; }
          node = node.parentElement;
        }
      }
    } catch (_) {}

    return { ok: how.length > 0, how: how.join("+"), names: info.names };
  }

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || msg.source !== "dsfill-content" || msg.type !== "SET_NUMERIC") return;

    const el = findMarked(msg.marker);
    if (!el) {
      window.postMessage({ source: "dsfill-inject", type: "SET_NUMERIC_RESULT", id: msg.id, ok: false, reason: "no-el" }, "*");
      return;
    }

    if (!ngApi()) {
      log("CẢNH BÁO: window.ng (Angular debug API) KHÔNG có sẵn -> không set qua Angular được.");
    }

    const res = setViaAngular(el, msg.value);
    log(`setViaAngular how=${res.how || "(none)"}`);

    setTimeout(() => {
      const finalOk = readNum(el.value) === Number(msg.value);
      log(`KẾT set numeric: value="${el.value}", how=${res.how}, ok=${finalOk}`);
      window.postMessage({
        source: "dsfill-inject", type: "SET_NUMERIC_RESULT",
        id: msg.id, ok: finalOk, value: el.value, how: res.how,
        hasNg: !!ngApi(), names: (res.names || []).filter(Boolean)
      }, "*");
    }, 300);
  });
})();

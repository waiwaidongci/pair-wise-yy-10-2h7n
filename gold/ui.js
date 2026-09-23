/*
 * 金箔批次领用与扫粉核销闸 · 页面层
 * 只负责 DOM 编排与事件；规则判定在 GoldRules，台账读写在 GoldStore。
 * 列表与履历均取自 store 同一份快照，刷新页面后仍一致。
 */
(function () {
  "use strict";

  const WORKS_KEY = "zfl42Works";
  const store = GoldStore.createGoldStore();
  const R = GoldRules;

  let reqToken = uuid();
  const editorTokens = {}; // <action:id> -> 幂等令牌，重复投递认首次结果
  const correctionOpen = new Set();

  const panel = document.querySelector("#goldPanel");
  const form = document.querySelector("#goldForm");
  const notice = document.querySelector("#goldNotice");
  const recordsEl = document.querySelector("#goldRecords");
  const historyEl = document.querySelector("#goldHistory");
  const workSelect = document.querySelector("#goldWork");

  function uuid() {
    return typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
  }

  function readWorks() {
    try {
      const data = JSON.parse(localStorage.getItem(WORKS_KEY) || "[]");
      return Array.isArray(data) ? data : [];
    } catch (err) {
      return [];
    }
  }

  function workMap() {
    const map = new Map();
    readWorks().forEach(w => map.set(w.id, w));
    return map;
  }

  function workLabel(id, map) {
    const w = map.get(id);
    return w ? esc(w.theme + " · " + w.base + "（" + w.status + "）") : '<span class="gold-ghost">作品已删除 · ' + esc(id) + "</span>";
  }

  function tokenFor(action, id) {
    const key = action + ":" + id;
    if (!editorTokens[key]) editorTokens[key] = uuid();
    return editorTokens[key];
  }

  function clearToken(action, id) {
    delete editorTokens[action + ":" + id];
  }

  function flash(kind, lines) {
    const arr = Array.isArray(lines) ? lines : [lines];
    notice.className = "gold-notice " + kind;
    notice.innerHTML = arr.map(t => "<div>" + esc(t) + "</div>").join("");
  }

  function clearNotice() {
    notice.className = "gold-notice";
    notice.innerHTML = "";
  }

  function pct(d) {
    return (d * 100).toFixed(2) + "%";
  }

  function renderWorkOptions() {
    const previous = workSelect.value;
    const map = workMap();
    workSelect.innerHTML =
      '<option value="">请选择作品</option>' +
      readWorks()
        .map(w => `<option value="${esc(w.id)}">${esc(w.theme)} · ${esc(w.base)}（${esc(w.status)}）</option>`)
        .join("");
    if (previous && map.has(previous)) workSelect.value = previous;
  }

  function actionArea(rec) {
    if (rec.status === R.STATUS.OPEN) {
      return `
        <form class="gold-action" data-action="sweep" data-id="${esc(rec.id)}">
          <div class="gold-row">
            <input class="f-actual" type="number" step="0.001" min="0" placeholder="实称消耗克数" required>
            <button type="submit">扫粉称重核销</button>
          </div>
          <div class="gold-hint">实耗与领用相差 ≤ 3% 自动核销，超过则进待复核</div>
        </form>
        ${correctionToggle(rec)}`;
    }
    if (rec.status === R.STATUS.REVIEW) {
      return `
        <form class="gold-action" data-action="review" data-id="${esc(rec.id)}">
          <div class="gold-row">
            <input class="f-reviewer" placeholder="复核人姓名（不得为操作者 ${esc(rec.operator)}）" required>
            <button type="submit" class="violet">复核通过并核销</button>
          </div>
        </form>
        ${correctionToggle(rec)}`;
    }
    return `
      <div class="gold-hint">已核销完成${rec.reviewer ? "（复核人：" + esc(rec.reviewer) + "）" : "（偏差内自动核销）"}</div>
      ${correctionToggle(rec)}`;
  }

  function correctionToggle(rec) {
    if (!correctionOpen.has(rec.id)) {
      return `<button type="button" class="secondary gold-mini-btn" data-toggle="correct" data-id="${esc(rec.id)}">更正批号/克数</button>`;
    }
    return `
      <form class="gold-action gold-correct" data-action="correct" data-id="${esc(rec.id)}">
        <div class="gold-row">
          <input class="f-batch" value="${esc(rec.batchNo)}" placeholder="新批号" required>
          <input class="f-grams" type="number" step="0.001" min="0" value="${esc(rec.grams)}" placeholder="新领用克数" required>
        </div>
        <div class="gold-hint">更正后原核销作废，按保留的实称克数（${rec.actualGrams === null ? "尚未称重" : esc(rec.actualGrams) + "g"}）重算</div>
        <div class="gold-row">
          <button type="submit" class="warn">保存更正并重算</button>
          <button type="button" class="secondary" data-toggle="close" data-id="${esc(rec.id)}">取消</button>
        </div>
      </form>`;
  }

  function card(rec, map) {
    const badgedev =
      rec.deviation === null ? "" : `偏差 <b class="${rec.status === R.STATUS.REVIEW ? "gold-bad" : ""}">${pct(rec.deviation)}</b>`;
    return `
      <article class="gold-card status-${esc(rec.status)}">
        <div class="gold-card-head">
          <span class="gold-badge ${esc(rec.status)}">${esc(rec.status)}</span>
          <span class="gold-meta">${esc(rec.createdAt)}</span>
        </div>
        <div class="gold-work">${workLabel(rec.workId, map)}</div>
        <div class="gold-lines">
          <div>批号 <b>${esc(rec.batchNo)}</b> · 领用 <b>${esc(rec.grams)}</b> g</div>
          <div>扫粉室温 ${esc(rec.roomTemp)}℃ · 操作者 ${esc(rec.operator)}</div>
          <div>实耗 ${rec.actualGrams === null ? "未称重" : esc(rec.actualGrams) + " g"} ${badgedev} ${rec.reviewer ? " · 复核人 " + esc(rec.reviewer) : ""}</div>
        </div>
        <div class="gold-actions">${actionArea(rec)}</div>
        <details class="gold-card-history">
          <summary>本单履历（${rec.history.length}）</summary>
          ${rec.history
            .slice()
            .reverse()
            .map(h => `<div class="gold-hist-row"><span class="gold-type ${esc(h.type)}">${esc(h.type)}</span><span class="gold-meta">${esc(h.at)}</span><span>${esc(h.text)}</span></div>`)
            .join("")}
        </details>
      </article>`;
  }

  function renderRecords() {
    const snapshot = store.getState();
    const map = workMap();
    const cols = [
      { key: R.STATUS.OPEN, title: "待核销（已领用未扫粉）" },
      { key: R.STATUS.REVIEW, title: "待复核（偏差超 3%）" },
      { key: R.STATUS.SETTLED, title: "已核销" }
    ];
    recordsEl.innerHTML = cols
      .map(col => {
        const list = snapshot.records.filter(r => !r.voided && r.status === col.key);
        return `<section class="gold-col">
          <h3><span>${esc(col.title)}</span><span>${list.length}</span></h3>
          ${list.length ? list.map(r => card(r, map)).join("") : '<div class="gold-empty">暂无单据</div>'}
        </section>`;
      })
      .join("");
    return snapshot;
  }

  function renderHistory(snapshot) {
    const map = workMap();
    const events = [];
    snapshot.records.forEach(r => {
      if (r.voided) return;
      r.history.forEach(h => events.push({ h, label: workLabel(r.workId, map) }));
    });
    events.sort((a, b) => (a.h.iso < b.h.iso ? 1 : a.h.iso > b.h.iso ? -1 : 0));
    historyEl.innerHTML = events.length
      ? events
          .slice(0, 60)
          .map(
            ({ h, label }) =>
              `<div class="gold-hist-row"><span class="gold-type ${esc(h.type)}">${esc(h.type)}</span><span class="gold-meta">${esc(h.at)}</span><span>${label}</span><span>${esc(h.text)}</span></div>`
          )
          .join("")
      : '<div class="gold-empty">暂无履历</div>';
  }

  function renderAll() {
    renderWorkOptions();
    const snapshot = renderRecords();
    renderHistory(snapshot);
  }

  /* ---------- 领用登记：字段不齐整单退回，不留半截单 ---------- */
  form.addEventListener("submit", event => {
    event.preventDefault();
    const result = store.submitRequisition(
      {
        workId: form.elements.workId.value,
        batchNo: form.elements.batchNo.value,
        grams: form.elements.grams.value,
        roomTemp: form.elements.roomTemp.value,
        operator: form.elements.operator.value
      },
      reqToken
    );
    reqToken = uuid(); // 本次投递已定结果；新令牌允许修正后再次提交
    if (result.ok) {
      flash("ok", ["领用成功：批号 " + result.record.batchNo + " 已登记为待核销"]);
      form.reset();
      correctionOpen.clear();
      renderAll();
    } else if (result.duplicate) {
      flash("info", ["该领用请求已投递过，认首次结果，未重复建单"]);
    } else {
      flash("bad", ["整单退回，未写入任何记录："].concat(result.errors));
    }
  });

  /* ---------- 扫粉核销 / 复核 / 更正（行内表单，事件委托） ---------- */
  recordsEl.addEventListener("submit", event => {
    const actionForm = event.target.closest(".gold-action");
    if (!actionForm) return;
    event.preventDefault();
    const action = actionForm.dataset.action;
    const id = actionForm.dataset.id;
    const token = tokenFor(action, id);
    let result;

    if (action === "sweep") {
      result = store.sweep(id, actionForm.querySelector(".f-actual").value, token);
    } else if (action === "review") {
      result = store.review(id, actionForm.querySelector(".f-reviewer").value, token);
    } else if (action === "correct") {
      result = store.correct(
        id,
        {
          batchNo: actionForm.querySelector(".f-batch").value,
          grams: actionForm.querySelector(".f-grams").value
        },
        token
      );
    }

    if (result.duplicate) {
      flash("info", ["该操作已提交过，认首次结果，未重复执行"]);
      return;
    }
    if (result.ok) {
      clearToken(action, id);
      correctionOpen.delete(id);
      const r = result.record;
      if (action === "sweep") {
        flash(r.status === R.STATUS.SETTLED ? "ok" : "warn", [
          r.status === R.STATUS.SETTLED ? "称重核销完成（批号 " + r.batchNo + "）" : "偏差 " + pct(r.deviation) + "，已进待复核（批号 " + r.batchNo + "）"
        ]);
      } else if (action === "review") {
        flash("ok", ["复核通过并核销（批号 " + r.batchNo + "）"]);
      } else {
        flash("warn", [
          "已更正，原结果作废并重算：批号 " + r.batchNo + "，当前状态 " + r.status + (r.deviation === null ? "" : "（偏差 " + pct(r.deviation) + "）")
        ]);
      }
      renderAll();
    } else {
      flash("bad", result.errors);
    }
  });

  recordsEl.addEventListener("click", event => {
    const btn = event.target.closest("[data-toggle]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.toggle === "correct") correctionOpen.add(id);
    if (btn.dataset.toggle === "close") {
      correctionOpen.delete(id);
      clearToken("correct", id);
    }
    renderAll();
  });

  document.querySelector("#goldReload").addEventListener("click", () => {
    store.reload();
    clearNotice();
    renderAll();
    flash("info", ["已从存档重读，列表与履历为同一快照"]);
  });

  // 作品新增/看板状态变化后，同步作品下拉（不改动原有作品逻辑）
  document.querySelector("#workForm").addEventListener("submit", () => setTimeout(renderAll, 0));
  document.querySelector("#board").addEventListener("click", () => setTimeout(renderAll, 0), true);

  // 其他标签页写入后保持一致
  window.addEventListener("storage", event => {
    if (event.key === store._key || event.key === WORKS_KEY) {
      store.reload();
      renderAll();
    }
  });

  window.GoldUI = { render: renderAll };
  renderAll();
})();

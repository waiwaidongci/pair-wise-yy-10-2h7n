/*
 * 页面部分（金箔批次领用与扫粉核销闸）
 * 只负责 DOM 渲染与事件：判定问 GoldRules，存档与履历问 GoldStore。
 * 列表与履历均直接读取存档，刷新后保持一致。
 */
(function () {
  "use strict";

  var nonces = {};

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function uid() {
    if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function nonceFor(action, orderId) {
    var key = action + ":" + (orderId || "new");
    if (!nonces[key]) nonces[key] = uid();
    return nonces[key];
  }

  function forgetNonces(orderId) {
    Object.keys(nonces).forEach(function (key) {
      if (key.slice(key.indexOf(":") + 1) === orderId) delete nonces[key];
    });
  }

  function statusClass(status) {
    if (status === "已核销") return "st-done";
    if (status === "待复核") return "st-review";
    return "st-open";
  }

  var TYPE_TEXT = {
    REQUISITION: "领用",
    WEIGHING: "称重",
    REVIEW: "复核",
    WRITE_OFF: "核销",
    CORRECTION: "更正",
    VOID: "作废"
  };

  var start = null;
  function init(options) {
    start = options;
  }

  function boot() {
    if (!start) return;
    var form = document.querySelector("#goldRequisitionForm");
    if (!form) return;

    GoldStore.init({
      workExists: start.workExists,
      workLabel: start.workLabel,
      seed: start.seed ? start.seed() : []
    });

    // 字段一变就是一次新投递；什么都不改重复提交 → 认首次结果
    form.addEventListener("input", function (e) {
      if (e.target.name === "requestId") return;
      form.requestId.value = uid();
    });
    form.addEventListener("submit", onRequisition);
    document.querySelector("#goldListArea").addEventListener("click", onCardAction);
    document.querySelector("#goldListArea").addEventListener("input", function (e) {
      var formEl = e.target.closest("form[data-action]");
      if (formEl) formEl.dataset.nonce = uid();
    });
    document.querySelector("#goldRefresh").addEventListener("click", render);

    if (!form.workId.value) {
      var preferred = start.firstGoldWorkId && start.firstGoldWorkId();
      if (preferred) form.workId.value = preferred;
    }
    form.requestId.value = uid();
    renderWorkOptions(form);
    render();
  }

  function workOptions(selectedId) {
    return start.listWorks().map(function (w) {
      return '<option value="' + esc(w.id) + '"' + (w.id === selectedId ? " selected" : "") + ">" +
        esc(start.workLabel(w.id)) + "</option>";
    }).join("");
  }

  function renderWorkOptions(form) {
    var current = form.workId.value;
    form.workId.innerHTML = workOptions(current);
  }

  function showResult(result) {
    var el = document.querySelector("#goldResult");
    var tag = result.duplicate ? '<span class="dup">重复投递·认首次结果</span> ' : "";
    el.className = "result " + (result.ok ? "ok" : "fail");
    el.innerHTML = tag + esc(result.message) +
      (result.errors && result.errors.length
        ? "<ul>" + result.errors.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul>"
        : "");
  }

  function onRequisition(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var data = Object.fromEntries(new FormData(form).entries());
    var result = GoldStore.submitRequisition(data, data.requestId);
    showResult(result);
    if (result.ok) {
      form.reset();
      form.batchNo.focus();
    }
    form.requestId.value = uid();
    renderWorkOptions(form);
    render();
  }

  function onCardAction(event) {
    var btn = event.target.closest("button[data-action]");
    if (!btn) return;
    var formEl = btn.closest("form[data-action]");
    var action = btn.dataset.action;
    var orderId = btn.closest("article.gold-item").dataset.orderId;
    var result;

    if (action === "weigh") {
      result = GoldStore.submitWeighing(orderId, formEl.actualGrams.value, formEl.dataset.nonce);
    } else if (action === "review") {
      result = GoldStore.submitReview(orderId, formEl.reviewer.value, formEl.dataset.nonce);
    } else if (action === "correct") {
      var patch = Object.fromEntries(new FormData(formEl).entries());
      delete patch.requestId;
      result = GoldStore.correctRequisition(orderId, patch, formEl.dataset.nonce);
    } else {
      return;
    }

    showResult(result);
    if (result.ok) forgetNonces(orderId);
    render();
  }

  function actionBlock(order) {
    if (order.status === "已领用") {
      return '<form class="inline" data-action="weigh" data-nonce="' + esc(nonceFor("weigh", order.id)) + '">' +
        '<label>扫粉后实耗(克)<input name="actualGrams" type="number" step="0.01" min="0" placeholder="如 ' + esc(order.grams) + '" required></label>' +
        '<button type="button" data-action="weigh" class="violet">按称重核销</button>' +
        '<span class="hint">偏差 &gt; 3% 只进待复核</span></form>';
    }
    if (order.status === "待复核") {
      var dev = order.actualGrams !== null
        ? GoldRules.deviation(order.grams, order.actualGrams).percent.toFixed(2)
        : "";
      return '<div class="review-hint">实耗 ' + esc(order.actualGrams) + "克，偏差 " + esc(dev) +
        '% &gt; 3%，待他人复核（操作者：' + esc(order.operator) + "）</div>" +
        '<form class="inline" data-action="review" data-nonce="' + esc(nonceFor("review", order.id)) + '">' +
        '<label>复核人<input name="reviewer" required placeholder="不得与操作者相同"></label>' +
        '<button type="button" data-action="review">复核通过并核销</button></form>' +
        '<form class="inline stacked" data-action="weigh" data-nonce="' + esc(nonceFor("weigh", order.id)) + '">' +
        '<label>重新扫粉称重(克)<input name="actualGrams" type="number" step="0.01" min="0" required></label>' +
        '<button type="button" data-action="weigh" class="secondary">重新称重判定</button></form>';
    }
    return '<div class="hint">已核销：实耗 ' + esc(order.actualGrams) + "克" +
      (order.reviewer ? "，复核人 " + esc(order.reviewer) : "") + "</div>";
  }

  function correctionBlock(order) {
    return '<details class="correct"><summary>更正批号 / 克数 / 室温 / 操作者</summary>' +
      '<form class="inline stacked" data-action="correct" data-nonce="' + esc(nonceFor("correct", order.id)) + '">' +
      '<label>金箔批号<input name="batchNo" value="' + esc(order.batchNo) + '" required></label>' +
      '<label>领用克数<input name="grams" type="number" step="0.01" min="0" value="' + esc(order.grams) + '" required></label>' +
      '<label>扫粉室温(℃)<input name="roomTemp" type="number" step="0.1" value="' + esc(order.roomTemp) + '" required></label>' +
      '<label>操作者<input name="operator" value="' + esc(order.operator) + '" required></label>' +
      '<button type="button" data-action="correct" class="warn">提交更正</button>' +
      '<span class="hint">改批号或克数：原核销作废、回待称重按新值重算</span></form></details>';
  }

  function renderOrders() {
    var area = document.querySelector("#goldListArea");
    var orders = GoldStore.listOrders();
    if (!orders.length) {
      area.innerHTML = '<div class="empty">尚无领用单，先在左侧开立一张。</div>';
      return;
    }
    // 最新在前；列表与履历同源，刷新后一致
    area.innerHTML = orders.slice().reverse().map(function (o) {
      return '<article class="gold-item ' + statusClass(o.status) + '" data-order-id="' + esc(o.id) + '">' +
        '<div class="gold-head"><span class="badge ' + statusClass(o.status) + '">' + esc(o.status) + "</span>" +
        "<b>批号 " + esc(o.batchNo) + "</b><span class='meta'>领用 " + esc(o.grams) + "克 · 室温 " + esc(o.roomTemp) + "℃</span></div>" +
        '<div class="meta">服务作品：' + esc(start.workLabel(o.workId)) + " · 操作者 " + esc(o.operator) + "<br>开立：" + esc(o.createdAt) + "</div>" +
        actionBlock(o) + correctionBlock(o) +
        "</article>";
    }).join("");
  }

  function renderLedger() {
    var area = document.querySelector("#goldLedger");
    var entries = GoldStore.listLedger().slice().reverse();
    if (!entries.length) {
      area.innerHTML = '<div class="empty">暂无履历。</div>';
      return;
    }
    area.innerHTML = entries.map(function (e) {
      return '<div class="ledger-row"><span class="op op-' + esc(e.type) + '">' + esc(TYPE_TEXT[e.type] || e.type) + "</span>" +
        '<span class="meta">' + esc(e.at) + "</span><div>" + esc(e.text) + "</div></div>";
    }).join("");
  }

  function render() {
    renderOrders();
    renderLedger();
  }

  window.GoldPage = {
    init: init,
    refresh: render,
    boot: boot
  };

  document.addEventListener("DOMContentLoaded", boot);
})();

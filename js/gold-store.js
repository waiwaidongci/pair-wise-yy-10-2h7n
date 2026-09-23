/*
 * 存档部分（金箔批次领用与扫粉核销闸）
 * 负责 localStorage 持久化、append-only 履历与重复投递去重。
 * 所有判定一律委托 GoldRules，本文件不解释业务阈值。
 */
(function () {
  "use strict";

  var KEY_ORDERS = "zfl42GoldOrders.v1";
  var KEY_LEDGER = "zfl42GoldLedger.v1";
  var KEY_REQUESTS = "zfl42GoldRequests.v1";

  var deps = {};
  var orders = null;
  var ledger = null;
  var requests = null;

  function load(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (err) {
      return null;
    }
  }

  function persist() {
    localStorage.setItem(KEY_ORDERS, JSON.stringify(orders));
    localStorage.setItem(KEY_LEDGER, JSON.stringify(ledger));
    localStorage.setItem(KEY_REQUESTS, JSON.stringify(requests));
  }

  function nowText() {
    return new Date().toLocaleString();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid(prefix) {
    if (window.crypto && typeof crypto.randomUUID === "function") return prefix + "-" + crypto.randomUUID();
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function findOpenBatch(batchNo, opts) {
    opts = opts || {};
    var hit = orders.find(function (o) {
      return o.batchNo === batchNo &&
        GoldRules.OPEN_STATUSES.indexOf(o.status) !== -1 &&
        (!opts.excludeOrderId || o.id !== opts.excludeOrderId);
    });
    return hit || null;
  }

  function judgeContext(orderId) {
    return {
      workExists: deps.workExists,
      workLabel: deps.workLabel,
      findOpenBatch: findOpenBatch
    };
  }

  function appendLedger(type, text, orderId, extra) {
    ledger.push(Object.assign({
      id: uid("led"),
      at: nowText(),
      orderId: orderId || null,
      type: type, // REQUISITION / WEIGHING / REVIEW / WRITE_OFF / CORRECTION / VOID
      text: text
    }, extra || {}));
  }

  function getOrder(orderId) {
    return orders.find(function (o) { return o.id === orderId; }) || null;
  }

  /**
   * 重复投递认首次结果：同一 requestId 只执行一次，后续直接返回首次结果。
   */
  function runOnce(requestId, fn) {
    if (requestId && Object.prototype.hasOwnProperty.call(requests, requestId)) {
      var first = clone(requests[requestId]);
      first.duplicate = true;
      return first;
    }
    var result = fn();
    if (requestId) requests[requestId] = { ok: result.ok, message: result.message, errors: result.errors || [] };
    persist();
    return result;
  }

  function ok(message, orderId) {
    return { ok: true, message: message, errors: [], orderId: orderId || null };
  }

  function reject(errors) {
    return { ok: false, message: "整单退回", errors: errors.slice(), orderId: null };
  }

  function withExistingOrder(orderId, action) {
    var order = getOrder(orderId);
    if (!order) return reject(["领用单不存在或已不在档案中"]);
    return action(order);
  }

  /**
   * 初始化存档。options: { workExists, workLabel, seed? }
   * seed 仅在三类档案都不存在（首次进入）时写入，刷新后保持一致。
   */
  function init(options) {
    options = options || {};
    deps.workExists = options.workExists || function () { return true; };
    deps.workLabel = options.workLabel || function (id) { return id; };

    var rawOrders = load(KEY_ORDERS);
    var rawLedger = load(KEY_LEDGER);
    var rawRequests = load(KEY_REQUESTS);
    orders = rawOrders || [];
    ledger = rawLedger || [];
    requests = rawRequests || {};

    if (!rawOrders && !rawLedger && !rawRequests && options.seed) {
      seed(options.seed);
    }
    persist();
  }

  function seed(entries) {
    entries.forEach(function (entry) {
      var decision = GoldRules.judgeRequisition(entry, judgeContext());
      if (!decision.ok) return;
      var v = decision.value;
      var order = {
        id: uid("gold"),
        workId: v.workId,
        batchNo: v.batchNo,
        grams: v.grams,
        roomTemp: v.roomTemp,
        operator: v.operator,
        status: "已领用",
        actualGrams: null,
        reviewer: null,
        createdAt: nowText()
      };
      orders.push(order);
      appendLedger("REQUISITION",
        "领用 批号" + order.batchNo + " " + order.grams + "克（室温 " + order.roomTemp + "℃，" + order.operator + "）→ 服务 " + deps.workLabel(order.workId),
        order.id);
    });
  }

  /**
   * 领用：判定不通过即整单退回，不产生任何订单与履历（不留半截单）。
   */
  function submitRequisition(input, requestId) {
    return runOnce(requestId, function () {
      var decision = GoldRules.judgeRequisition(input, judgeContext());
      if (!decision.ok) return reject(decision.errors);
      var v = decision.value;

      var order = {
        id: uid("gold"),
        workId: v.workId,
        batchNo: v.batchNo,
        grams: v.grams,
        roomTemp: v.roomTemp,
        operator: v.operator,
        status: "已领用",
        actualGrams: null,
        reviewer: null,
        createdAt: nowText()
      };
      orders.push(order);
      appendLedger("REQUISITION",
        "领用 批号" + order.batchNo + " " + order.grams + "克（室温 " + order.roomTemp + "℃，" + order.operator + "）→ 服务 " + deps.workLabel(order.workId),
        order.id);
      return ok("领用成功，批号 " + order.batchNo + " 待扫粉后称重核销", order.id);
    });
  }

  /**
   * 扫粉后按称重核销：偏差 > 3% 只进待复核；<= 3% 直接核销。
   * 待复核单允许重新称重，按新称重重新判定。
   */
  function submitWeighing(orderId, actualGramsRaw, requestId) {
    return runOnce(requestId, function () {
      return withExistingOrder(orderId, function (order) {
        if (order.status === "已核销") return reject(["该单已核销；批号或克数有误请走更正，原核销会作废重算"]);
        if (GoldRules.OPEN_STATUSES.indexOf(order.status) === -1) return reject(["当前状态不允许称重"]);

        var decision = GoldRules.judgeWeighing({ actualGrams: actualGramsRaw });
        if (!decision.ok) return reject(decision.errors);
        var actual = decision.value.actualGrams;
        var d = GoldRules.deviation(order.grams, actual);

        order.actualGrams = actual;
        if (d.withinTolerance) {
          order.status = "已核销";
          order.reviewer = null;
          appendLedger("WEIGHING",
            "扫粉称重 " + actual + "克，实耗与领用相差 " + d.percent.toFixed(2) + "%（领用 " + order.grams + "克）",
            order.id, { actualGrams: actual, percent: d.percent });
          appendLedger("WRITE_OFF", "偏差不超过 3%，按称重核销完成", order.id);
          return ok("核销完成（偏差 " + d.percent.toFixed(2) + "%，在 3% 以内）", order.id);
        }

        order.status = "待复核";
        order.reviewer = null;
        appendLedger("WEIGHING",
          "扫粉称重 " + actual + "克，实耗与领用相差 " + d.percent.toFixed(2) + "%（领用 " + order.grams + "克）→ 待复核",
          order.id, { actualGrams: actual, percent: d.percent });
        return ok("偏差 " + d.percent.toFixed(2) + "% 超过 3%，只进待复核，需他人复核", order.id);
      });
    });
  }

  /**
   * 复核：复核人不得与操作者相同；通过后核销。
   */
  function submitReview(orderId, reviewerRaw, requestId) {
    return runOnce(requestId, function () {
      return withExistingOrder(orderId, function (order) {
        if (order.status !== "待复核") return reject(["仅待复核单可以复核"]);
        var decision = GoldRules.judgeReview(order, reviewerRaw);
        if (!decision.ok) return reject(decision.errors);

        order.reviewer = decision.value.reviewer;
        order.status = "已核销";
        appendLedger("REVIEW",
          "复核通过（复核人 " + order.reviewer + "，操作者 " + order.operator + "），称重 " + order.actualGrams + "克 → 已核销",
          order.id, { reviewer: order.reviewer });
        appendLedger("WRITE_OFF", "复核后核销完成", order.id);
        return ok("复核通过，已核销", order.id);
      });
    });
  }

  /**
   * 更正：批号或克数变更 → 原核销/原复核结论作废，回到已领用按新值重算；
   * 仅改室温/操作者不动核销状态。整单式校验，任一项不过整体退回。
   */
  function correctRequisition(orderId, patch, requestId) {
    return runOnce(requestId, function () {
      return withExistingOrder(orderId, function (order) {
        var next = {
          workId: order.workId,
          batchNo: GoldRules.norm(patch.batchNo) || order.batchNo,
          grams: patch.grams === "" || patch.grams === undefined || patch.grams === null ? order.grams : Number(patch.grams),
          roomTemp: patch.roomTemp === "" || patch.roomTemp === undefined || patch.roomTemp === null ? order.roomTemp : Number(patch.roomTemp),
          operator: GoldRules.norm(patch.operator) || order.operator,
          excludeOrderId: order.id
        };

        var nothingChanged =
          next.batchNo === order.batchNo &&
          next.grams === order.grams &&
          next.roomTemp === order.roomTemp &&
          next.operator === order.operator;
        if (nothingChanged) return reject(["没有任何更正内容"]);

        var decision = GoldRules.judgeRequisition(next, judgeContext(order.id));
        if (!decision.ok) return reject(decision.errors);

        var voidsWriteoff = GoldRules.correctionVoidsWriteoff(order, {
          batchNo: patch.batchNo,
          grams: patch.grams
        });

        var oldSummary = "批号" + order.batchNo + " " + order.grams + "克（室温 " + order.roomTemp + "℃，" + order.operator + "）";
        if (voidsWriteoff && (order.status === "已核销" || order.status === "待复核")) {
          appendLedger("VOID",
            "因批号/克数更正，原" + order.status + "结论作废：" + oldSummary +
            (order.actualGrams !== null ? "，原称重 " + order.actualGrams + "克" : ""),
            order.id);
        }

        order.batchNo = next.batchNo;
        order.grams = next.grams;
        order.roomTemp = next.roomTemp;
        order.operator = next.operator;

        if (voidsWriteoff) {
          // 原核销作废并按新值重算：清掉称重/复核，回已领用重新扫粉称重
          order.status = "已领用";
          order.actualGrams = null;
          order.reviewer = null;
          appendLedger("CORRECTION",
            "更正为 批号" + order.batchNo + " " + order.grams + "克（室温 " + order.roomTemp + "℃，" + order.operator + "），按新值重新称重核销",
            order.id);
          persist();
          return ok("更正成功，原核销已作废，请按新批号/克数重新扫粉称重", order.id);
        }

        appendLedger("CORRECTION",
          "更正为 " + oldSummary + " → 批号" + order.batchNo + " " + order.grams + "克（室温 " + order.roomTemp + "℃，" + order.operator + "）；未改批号/克数，核销结论保持 " + order.status,
          order.id);
        return ok("更正成功（未涉及批号/克数，核销结论不变）", order.id);
      });
    });
  }

  function listOrders() {
    return clone(orders);
  }

  function listLedger() {
    return clone(ledger);
  }

  window.GoldStore = {
    init: init,
    submitRequisition: submitRequisition,
    submitWeighing: submitWeighing,
    submitReview: submitReview,
    correctRequisition: correctRequisition,
    listOrders: listOrders,
    listLedger: listLedger
  };
})();

/*
 * 判定部分（金箔批次领用与扫粉核销闸）
 * 纯业务规则：只接收输入与上下文，返回判定结果，不碰 DOM、不做持久化。
 * 页面与存档都只能引用这里的结论，不得自行解释阈值。
 */
(function () {
  "use strict";

  // 实耗与领用相差超过 3% 只进待复核（“超过”为严格大于，3% 整算合格）
  var REVIEW_TOLERANCE = 0.03;
  // 未核销 = 已领用（待扫粉称重）与 待复核（称重后待人工复核）
  var OPEN_STATUSES = ["已领用", "待复核"];

  function norm(value) {
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === "") return NaN;
    return Number(value);
  }

  /**
   * 领用判定：领用克数、扫粉室温、操作者（及批号、作品）不齐时整单退回；
   * 同批号存在未核销单且服务于另一件作品时，同样整单退回。
   * context: { workExists(id), findOpenBatch(batchNo, { excludeOrderId }), workLabel(id) }
   * 返回 { ok, errors[], value? }，ok 为 false 时调用方不得留下任何半成品单。
   */
  function judgeRequisition(input, context) {
    input = input || {};
    context = context || {};
    var errors = [];

    var workId = norm(input.workId);
    var batchNo = norm(input.batchNo);
    var operator = norm(input.operator);
    var grams = toNumber(input.grams);
    var roomTemp = toNumber(input.roomTemp);

    if (!workId) {
      errors.push("未选择服务作品");
    } else if (context.workExists && !context.workExists(workId)) {
      errors.push("所选作品不存在");
    }
    if (!batchNo) errors.push("金箔批号不齐");
    if (!isFiniteNumber(grams) || grams <= 0) errors.push("领用克数须为大于 0 的数字");
    if (!isFiniteNumber(roomTemp)) errors.push("扫粉室温不齐（须为数字，单位 ℃）");
    if (!operator) errors.push("操作者不齐");

    // 同批号未核销前只服务一件作品（更正自身时排除自身单号）
    if (batchNo && context.findOpenBatch) {
      var exclude = input.excludeOrderId || null;
      var holder = context.findOpenBatch(batchNo, { excludeOrderId: exclude });
      if (holder && holder.workId !== workId) {
        var who = context.workLabel ? context.workLabel(holder.workId) : holder.workId;
        errors.push("批号 " + batchNo + " 尚有未核销单（服务于 " + who + "），核销前不能再领给其他作品");
      }
    }

    return {
      ok: errors.length === 0,
      errors: errors,
      value: errors.length === 0
        ? { workId: workId, batchNo: batchNo, grams: grams, roomTemp: roomTemp, operator: operator }
        : null
    };
  }

  /**
   * 称重核销判定：按实耗与领用的偏差比例决定走向。
   * ratio > 3% 时只允许进待复核；<= 3% 直接核销。
   */
  function deviation(grams, actualGrams) {
    var diff = actualGrams - grams;
    var ratio = grams === 0 ? 0 : Math.abs(diff) / grams;
    return {
      diff: diff,
      ratio: ratio,
      percent: ratio * 100,
      withinTolerance: ratio <= REVIEW_TOLERANCE
    };
  }

  function judgeWeighing(raw) {
    var actualGrams = toNumber(raw && raw.actualGrams);
    if (!isFiniteNumber(actualGrams) || actualGrams < 0) {
      return { ok: false, errors: ["扫粉后称重须为不小于 0 的数字（克）"] };
    }
    return { ok: true, errors: [], value: { actualGrams: actualGrams } };
  }

  /**
   * 复核判定：复核人必须署名且不得与操作者相同。
   */
  function judgeReview(order, reviewerRaw) {
    var reviewer = norm(reviewerRaw);
    if (!reviewer) return { ok: false, errors: ["复核人不齐"] };
    if (order && reviewer === norm(order.operator)) {
      return { ok: false, errors: ["复核人不得与操作者相同"] };
    }
    return { ok: true, errors: [], value: { reviewer: reviewer } };
  }

  /**
   * 更正影响面判定：只有批号或克数变更才作废原核销并按新值重算；
   * 仅改室温、操作者不动核销结论。
   */
  function correctionVoidsWriteoff(before, patch) {
    patch = patch || {};
    var batchChanged = patch.batchNo !== undefined && norm(patch.batchNo) !== norm(before.batchNo);
    var gramsChanged = patch.grams !== undefined && toNumber(patch.grams) !== before.grams;
    return batchChanged || gramsChanged;
  }

  window.GoldRules = {
    REVIEW_TOLERANCE: REVIEW_TOLERANCE,
    OPEN_STATUSES: OPEN_STATUSES,
    norm: norm,
    judgeRequisition: judgeRequisition,
    deviation: deviation,
    judgeWeighing: judgeWeighing,
    judgeReview: judgeReview,
    correctionVoidsWriteoff: correctionVoidsWriteoff
  };
})();

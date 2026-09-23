/*
 * 金箔批次领用与扫粉核销闸 · 判定层
 * 纯函数：只做规则判定，不访问 DOM、不访问存储、无副作用，便于单独测试。
 */
(function (global) {
  "use strict";

  const TOLERANCE = 0.03; // 实耗与领用相差超过 3% 进待复核
  const STATUS = {
    OPEN: "待核销",
    SETTLED: "已核销",
    REVIEW: "待复核"
  };

  function toNumber(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (text === "") return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : NaN;
  }

  /*
   * 领用单整单校验：批号、领用克数、扫粉室温、操作者、作品缺一不可。
   * openRecords 为当前未核销（待核销/待复核）的领用单；同批号未核销前只服务一件作品。
   * 任一条件不满足都返回全部错误，由存档层保证不写入任何半截单。
   */
  function checkRequisition(input, openRecords) {
    input = input || {};
    const errors = [];
    const value = {
      workId: String(input.workId || "").trim(),
      batchNo: String(input.batchNo || "").trim(),
      grams: toNumber(input.grams),
      roomTemp: toNumber(input.roomTemp),
      operator: String(input.operator || "").trim()
    };

    if (!value.workId) errors.push("未选择作品");
    if (!value.batchNo) errors.push("批号未填写");
    if (value.grams === null) errors.push("领用克数未填写");
    else if (!Number.isFinite(value.grams) || value.grams <= 0) {
      errors.push("领用克数须为大于 0 的数字");
    }
    if (value.roomTemp === null) errors.push("扫粉室温未填写");
    else if (!Number.isFinite(value.roomTemp)) errors.push("扫粉室温须为数字");
    if (!value.operator) errors.push("操作者未填写");

    let clashWorkId = null;
    if (value.batchNo) {
      const clash = (openRecords || []).find(
        r => r.batchNo === value.batchNo && r.id !== input.id && r.status !== STATUS.SETTLED
      );
      if (clash) {
        clashWorkId = clash.workId;
        errors.push("批号 " + value.batchNo + " 已有未核销领用，同批号未核销前只服务一件作品");
      }
    }

    return { ok: errors.length === 0, errors, value, clashWorkId };
  }

  /* 扫粉称重实耗克数校验 */
  function checkActual(actualGrams) {
    const n = toNumber(actualGrams);
    if (n === null) return { ok: false, errors: ["实称消耗克数未填写"] };
    if (!Number.isFinite(n) || n <= 0) return { ok: false, errors: ["实称消耗克数须为大于 0 的数字"] };
    return { ok: true, errors: [], value: n };
  }

  /*
   * 按称重核销：|实耗 - 领用| / 领用 > 3% 只进待复核；恰好 3% 仍自动核销。
   */
  function settle(grams, actualGrams) {
    const diff = actualGrams - grams;
    const raw = grams > 0 ? Math.abs(diff) / grams : Infinity;
    // 偏差按 0.001% 精度取整，消除克数浮点尾差（如 10 与 10.3）
    const deviation = Number.isFinite(raw) ? Math.round(raw * 1e6) / 1e6 : raw;
    return {
      diff,
      deviation,
      status: deviation > TOLERANCE ? STATUS.REVIEW : STATUS.SETTLED
    };
  }

  /* 复核人必须填写且不得与操作者相同 */
  function checkReview(operator, reviewer) {
    const value = String(reviewer == null ? "" : reviewer).trim();
    if (!value) return { ok: false, errors: ["复核人未填写"] };
    if (value === String(operator || "").trim()) {
      return { ok: false, errors: ["复核人不得与操作者相同"] };
    }
    return { ok: true, errors: [], value };
  }

  /*
   * 批号或克数更正校验：
   * - 克数须为正数；批号不可清空
   * - 新批号同样受“未核销前只服务一件作品”限制（排除本单）
   * - 更正后由存档层按保留的实称克数重新走 settle 判定
   */
  function checkCorrection(record, patch, openRecords) {
    patch = patch || {};
    const errors = [];
    const nextBatch = patch.batchNo !== undefined ? String(patch.batchNo).trim() : record.batchNo;
    const nextGrams = patch.grams !== undefined ? toNumber(patch.grams) : record.grams;

    if (!nextBatch) errors.push("批号未填写");
    if (nextGrams === null) errors.push("领用克数未填写");
    else if (!Number.isFinite(nextGrams) || nextGrams <= 0) {
      errors.push("领用克数须为大于 0 的数字");
    }

    let clashWorkId = null;
    if (nextBatch) {
      const clash = (openRecords || []).find(
        r => r.batchNo === nextBatch && r.id !== record.id && r.status !== STATUS.SETTLED
      );
      if (clash) {
        clashWorkId = clash.workId;
        errors.push("批号 " + nextBatch + " 已被其他作品领用且未核销，无法更正到该批号");
      }
    }

    const changed = nextBatch !== record.batchNo || nextGrams !== record.grams;
    if (!errors.length && !changed) errors.push("批号与克数均未变化");

    let recalc = null;
    if (!errors.length && record.actualGrams !== null && record.actualGrams !== undefined) {
      recalc = settle(nextGrams, record.actualGrams);
    }

    return {
      ok: errors.length === 0,
      errors,
      clashWorkId,
      changed,
      value: { batchNo: nextBatch, grams: nextGrams },
      recalc
    };
  }

  const api = { TOLERANCE, STATUS, toNumber, checkRequisition, checkActual, settle, checkReview, checkCorrection };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.GoldRules = api;
})(typeof window !== "undefined" ? window : globalThis);

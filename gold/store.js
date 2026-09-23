/*
 * 金箔批次领用与扫粉核销闸 · 存档层
 * 只负责台账持久化与履历：不访问 DOM；判定全部委托 GoldRules。
 * 被判定层拒绝的请求不产生任何写入（不留半截单）。
 *
 * 存储结构（单 key，一次写入，避免半截状态）：
 * { records: [...], tokens: { <幂等令牌>: { action, key, result } } }
 * 每条领用单含 history[]，列表与履历读同一份数据，刷新后天然一致。
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "zfl42GoldLedger";
  const R = global.GoldRules;

  function defaultStorage() {
    if (typeof localStorage !== "undefined") return localStorage;
    // 非浏览器环境（测试）退化为内存存储
    const mem = new Map();
    return {
      getItem: k => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: k => mem.delete(k)
    };
  }

  function nowText() {
    return new Date().toLocaleString("zh-CN", { hour12: false });
  }

  function newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "g_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function openRecordsOf(records, exceptId) {
    return records.filter(r => !r.voided && r.status !== R.STATUS.SETTLED && r.id !== exceptId);
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function createGoldStore(storage, storageKey) {
    storage = storage || defaultStorage();
    storageKey = storageKey || STORAGE_KEY;

    function load() {
      try {
        const raw = storage.getItem(storageKey);
        if (!raw) return { records: [], tokens: {} };
        const data = JSON.parse(raw);
        return {
          records: Array.isArray(data.records) ? data.records : [],
          tokens: data.tokens && typeof data.tokens === "object" ? data.tokens : {}
        };
      } catch (err) {
        return { records: [], tokens: {} };
      }
    }

    let state = load();

    function persist() {
      storage.setItem(storageKey, JSON.stringify(state));
    }

    function pushEvent(rec, type, text) {
      rec.history.push({ at: nowText(), iso: new Date().toISOString(), type, text });
    }

    /* 幂等：同一令牌重复投递直接认首次结果，不重新执行 */
    function replay(token) {
      const hit = token && Object.prototype.hasOwnProperty.call(state.tokens, token) ? state.tokens[token] : null;
      if (!hit) return null;
      return Object.assign({ duplicate: true }, hit.result);
    }

    function remember(token, action, key, result) {
      if (token) state.tokens[token] = { action, key, result: clone(result), at: nowText() };
    }

    /* 所有写操作经此闸：先执行 mutation，成功才一次性持久化；返回失败绝不落盘 */
    function commit(action, key, token, mutation) {
      const dup = replay(token);
      if (dup) return dup;
      const result = mutation();
      if (result && result.ok) {
        remember(token, action, key, result);
        persist();
      }
      return result;
    }

    /* 领用：整单校验失败直接退回（不存档），不产生半截单 */
    function submitRequisition(input, token) {
      return commit("requisition", null, token, () => {
        const check = R.checkRequisition(input, openRecordsOf(state.records, null));
        if (!check.ok) return { ok: false, errors: check.errors, clashWorkId: check.clashWorkId };

        const rec = {
          id: newId(),
          workId: check.value.workId,
          batchNo: check.value.batchNo,
          grams: check.value.grams,
          roomTemp: check.value.roomTemp,
          operator: check.value.operator,
          actualGrams: null,
          deviation: null,
          reviewer: null,
          status: R.STATUS.OPEN,
          voided: false,
          createdAt: nowText(),
          history: []
        };
        pushEvent(
          rec,
          "领用",
          "领用批号 " + rec.batchNo + "，" + rec.grams + "g，室温 " + rec.roomTemp + "℃，操作者 " + rec.operator
        );
        state.records.push(rec);
        return { ok: true, record: clone(rec) };
      });
    }

    /* 扫粉后按称重核销；偏差超过 3% 只进待复核 */
    function sweep(id, actualGrams, token) {
      return commit("sweep", id, token, () => {
        const rec = state.records.find(r => r.id === id && !r.voided);
        if (!rec) return { ok: false, errors: ["领用单不存在或已作废"] };
        if (rec.status === R.STATUS.SETTLED) return { ok: false, errors: ["该单已核销，无需重复扫粉"] };
        if (rec.actualGrams !== null) return { ok: false, errors: ["已称重，待复核中；如需调整请走复核或更正"] };

        const check = R.checkActual(actualGrams);
        if (!check.ok) return { ok: false, errors: check.errors };

        const outcome = R.settle(rec.grams, check.value);
        rec.actualGrams = check.value;
        rec.deviation = outcome.deviation;
        rec.status = outcome.status;
        if (outcome.status === R.STATUS.SETTLED) {
          pushEvent(
            rec,
            "核销",
            "扫粉实耗 " + rec.actualGrams + "g，偏差 " + (outcome.deviation * 100).toFixed(2) + "%，自动核销"
          );
        } else {
          pushEvent(
            rec,
            "待复核",
            "扫粉实耗 " + rec.actualGrams + "g，偏差 " + (outcome.deviation * 100).toFixed(2) + "%，超过 3% 进待复核"
          );
        }
        return { ok: true, record: clone(rec) };
      });
    }

    /* 待复核单核销：复核人不得与操作者相同 */
    function review(id, reviewer, token) {
      return commit("review", id, token, () => {
        const rec = state.records.find(r => r.id === id && !r.voided);
        if (!rec) return { ok: false, errors: ["领用单不存在或已作废"] };
        if (rec.status !== R.STATUS.REVIEW) return { ok: false, errors: ["仅待复核单据可复核"] };

        const check = R.checkReview(rec.operator, reviewer);
        if (!check.ok) return { ok: false, errors: check.errors };

        rec.reviewer = check.value;
        rec.status = R.STATUS.SETTLED;
        pushEvent(
          rec,
          "复核",
          "复核人 " + rec.reviewer + " 核销（实耗 " + rec.actualGrams + "g，偏差 " + (rec.deviation * 100).toFixed(2) + "%）"
        );
        return { ok: true, record: clone(rec) };
      });
    }

    /*
     * 批号或克数更正：原核销作废并按新值重算。
     * 已称重的单按保留的实称克数重新判定；未称重的回到待核销。
     */
    function correct(id, patch, token) {
      return commit("correct", id, token, () => {
        const rec = state.records.find(r => r.id === id && !r.voided);
        if (!rec) return { ok: false, errors: ["领用单不存在或已作废"] };

        const check = R.checkCorrection(rec, patch, openRecordsOf(state.records, rec.id));
        if (!check.ok) return { ok: false, errors: check.errors, clashWorkId: check.clashWorkId };

        const parts = [];
        if (check.value.batchNo !== rec.batchNo) parts.push("批号 " + rec.batchNo + " → " + check.value.batchNo);
        if (check.value.grams !== rec.grams) parts.push("克数 " + rec.grams + "g → " + check.value.grams + "g");
        const oldStatus = rec.status;

        // 原核销/判定结果作废
        const voidedResult =
          oldStatus === R.STATUS.SETTLED
            ? rec.reviewer
              ? "复核核销作废"
              : "自动核销作废"
            : oldStatus === R.STATUS.REVIEW
              ? "待复核判定作废"
              : null;
        rec.reviewer = null;

        rec.batchNo = check.value.batchNo;
        rec.grams = check.value.grams;

        if (rec.actualGrams !== null && rec.actualGrams !== undefined) {
          const outcome = check.recalc;
          rec.deviation = outcome.deviation;
          rec.status = outcome.status;
        } else {
          rec.deviation = null;
          rec.status = R.STATUS.OPEN;
        }

        pushEvent(rec, "更正", parts.join("，") + (voidedResult ? "；" + voidedResult : ""));
        if (rec.actualGrams !== null) {
          pushEvent(
            rec,
            rec.status === R.STATUS.SETTLED ? "核销" : "待复核",
            "按实耗 " + rec.actualGrams + "g 重算，偏差 " + (rec.deviation * 100).toFixed(2) + "%，结果：" + rec.status
          );
        }
        return { ok: true, record: clone(rec) };
      });
    }

    /* 只读视图：列表与履历都从这里取数（同一快照） */
    function getState() {
      return clone(state);
    }

    function getRecord(id) {
      const rec = state.records.find(r => r.id === id && !r.voided);
      return rec ? clone(rec) : null;
    }

    /* 从存储介质重读（刷新/跨标签页后保证一致） */
    function reload() {
      state = load();
      return getState();
    }

    /* 测试与重置用 */
    function reset() {
      state = { records: [], tokens: {} };
      persist();
    }

    return { submitRequisition, sweep, review, correct, getState, getRecord, reload, reset, _key: storageKey };
  }

  const api = { STORAGE_KEY, createGoldStore };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.GoldStore = api;
})(typeof window !== "undefined" ? window : globalThis);

/* 命令行验证：node gold/test.js —— 覆盖验收点，不参与页面运行 */
const assert = require("assert");
const R = require("./rules.js");
const { createGoldStore } = require("./store.js");

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log("  ✓ " + name);
}

function memStore() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _dump: () => JSON.parse(map.get("zfl42GoldLedger") || '{"records":[],"tokens":{}}')
  };
}

const valid = { workId: "w1", batchNo: "B1", grams: 2.5, roomTemp: 24, operator: "张三" };

console.log("判定层 rules.js");

ok("领用字段齐全通过", () => assert.deepStrictEqual(R.checkRequisition(valid, []).ok, true));

ok("批号/克数/室温/操作者任一缺失整单不通过且列出全部错误", () => {
  const r = R.checkRequisition({ workId: "w1", batchNo: "", grams: "", roomTemp: "", operator: "" }, []);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length >= 4);
});

ok("克数非正数退回", () => assert.strictEqual(R.checkRequisition(Object.assign({}, valid, { grams: 0 }), []).ok, false));

ok("同批号未核销前只服务一件作品", () => {
  const open = [{ id: "old", batchNo: "B1", workId: "w9", status: "待核销" }];
  const r = R.checkRequisition(valid, open);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.clashWorkId, "w9");
});

ok("同批号已核销后可服务另一件作品", () => {
  const closed = [{ id: "old", batchNo: "B1", workId: "w9", status: "已核销" }];
  assert.strictEqual(R.checkRequisition(valid, closed).ok, true);
});

ok("偏差恰好 3% 自动核销", () => assert.strictEqual(R.settle(10, 10.3).status, "已核销"));
ok("偏差略超 3% 进待复核", () => assert.strictEqual(R.settle(10, 10.31).status, "待复核"));
ok("偏少超 3% 也进待复核", () => assert.strictEqual(R.settle(10, 9.69).status, "待复核"));

ok("复核人缺失不通过", () => assert.strictEqual(R.checkReview("张三", " ").ok, false));
ok("复核人与操作者相同不通过", () => assert.strictEqual(R.checkReview("张三", "张三").ok, false));
ok("复核人不同通过", () => assert.strictEqual(R.checkReview("张三", "李四").ok, true));

console.log("存档层 store.js");

ok("领用成功落盘且状态为待核销", () => {
  const mem = memStore();
  const s = createGoldStore(mem);
  const r = s.submitRequisition(valid, "t1");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.record.status, "待核销");
  assert.strictEqual(mem._dump().records.length, 1);
});

ok("字段不齐整单退回且不写半截单（存储保持空）", () => {
  const mem = memStore();
  const s = createGoldStore(mem);
  const r = s.submitRequisition({ workId: "w1" }, "t1");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(mem._dump().records.length, 0);
});

ok("同批号第二件作品领用失败，且不产生任何新记录", () => {
  const mem = memStore();
  const s = createGoldStore(mem);
  s.submitRequisition(valid, "t1");
  const r2 = s.submitRequisition(Object.assign({}, valid, { workId: "w2" }), "t2");
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(mem._dump().records.length, 1);
});

ok("扫粉偏差内自动核销并记录实耗/偏差", () => {
  const s = createGoldStore(memStore());
  const id = s.submitRequisition(valid, "t1").record.id;
  const r = s.sweep(id, 2.55, "s1");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.record.status, "已核销");
  assert.ok(Math.abs(r.record.deviation - 0.02) < 1e-9);
});

ok("扫粉超 3% 只进待复核，不自动核销", () => {
  const s = createGoldStore(memStore());
  const id = s.submitRequisition(valid, "t1").record.id;
  const r = s.sweep(id, 3.0, "s1");
  assert.strictEqual(r.record.status, "待复核");
  assert.notStrictEqual(s.getRecord(id).status, "已核销");
});

ok("待复核单：操作者本人复核被拒", () => {
  const s = createGoldStore(memStore());
  const id = s.submitRequisition(valid, "t1").record.id;
  s.sweep(id, 3.0, "s1");
  assert.strictEqual(s.review(id, "张三", "r1").ok, false);
  assert.strictEqual(s.getRecord(id).status, "待复核");
});

ok("待复核单：他人复核通过并核销", () => {
  const s = createGoldStore(memStore());
  const id = s.submitRequisition(valid, "t1").record.id;
  s.sweep(id, 3.0, "s1");
  const r = s.review(id, "李四", "r1");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.getRecord(id).status, "已核销");
  assert.strictEqual(s.getRecord(id).reviewer, "李四");
});

ok("非待复核状态不可复核", () => {
  const s = createGoldStore(memStore());
  const id = s.submitRequisition(valid, "t1").record.id;
  assert.strictEqual(s.review(id, "李四", "r1").ok, false);
});

ok("更正克数后原核销作废并按新值重算：超差→偏差内", () => {
  const s = createGoldStore(memStore());
  const id = s.submitRequisition(valid, "t1").record.id; // 2.5g
  s.sweep(id, 3.0, "s1"); // 偏差 20%，待复核
  const r = s.correct(id, { grams: 2.95 }, "c1");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.record.status, "已核销"); // 3.0 vs 2.95 ≈ 1.7%
  const rec = s.getRecord(id);
  assert.strictEqual(rec.grams, 2.95);
  assert.strictEqual(rec.reviewer, null); // 原复核结论作废
  assert.ok(rec.history.some(h => h.text.includes("待复核判定作废")));
  assert.ok(rec.history.some(h => h.type === "核销" && h.text.includes("重算")));
});

ok("更正批号后重算可使偏差内单变待复核", () => {
  const s = createGoldStore(memStore());
  const id = s.submitRequisition(valid, "t1").record.id;
  s.sweep(id, 2.55, "s1"); // 2% 自动核销
  const r = s.correct(id, { batchNo: "B2" }, "c1");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.record.batchNo, "B2");
  assert.strictEqual(r.record.status, "已核销"); // 克数没变，仍 2%
  const s2 = createGoldStore(memStore());
  const id2 = s2.submitRequisition(Object.assign({}, valid, { grams: 10 }), "t").record.id;
  s2.sweep(id2, 10.3, "x"); // 3% 核销
  const r2 = s2.correct(id2, { grams: 9 }, "c");
  assert.strictEqual(r2.record.status, "待复核"); // 10.3 vs 9 ≈ 14.4%
});

ok("更正到他人未核销批号被拒且不改动原单", () => {
  const s = createGoldStore(memStore());
  s.submitRequisition(valid, "t1"); // w1 占 B1
  const id2 = s.submitRequisition(Object.assign({}, valid, { batchNo: "B2" }), "t2").record.id;
  const r = s.correct(id2, { batchNo: "B1" }, "c1");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(s.getRecord(id2).batchNo, "B2");
});

ok("未称重单更正克数后保持待核销、等待重新扫粉", () => {
  const s = createGoldStore(memStore());
  const id = s.submitRequisition(valid, "t1").record.id;
  const r = s.correct(id, { grams: 3 }, "c1");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.record.status, "待核销");
  assert.strictEqual(r.record.actualGrams, null);
});

ok("无变化更正被拒", () => {
  const s = createGoldStore(memStore());
  const id = s.submitRequisition(valid, "t1").record.id;
  assert.strictEqual(s.correct(id, { batchNo: "B1", grams: 2.5 }, "c1").ok, false);
});

ok("重复投递（同令牌）认首次结果，不重复建单", () => {
  const s = createGoldStore(memStore());
  const r1 = s.submitRequisition(valid, "SAME");
  const r2 = s.submitRequisition(Object.assign({}, valid, { grams: 99 }), "SAME");
  assert.strictEqual(r2.duplicate, true);
  assert.strictEqual(r2.record.id, r1.record.id);
  assert.strictEqual(s.getState().records.length, 1);
  assert.strictEqual(s.getRecord(r1.record.id).grams, 2.5);
});

ok("重复扫粉/复核/更正投递均认首次", () => {
  const s = createGoldStore(memStore());
  const id = s.submitRequisition(valid, "t1").record.id;
  s.sweep(id, 3.0, "SW");
  const dup = s.sweep(id, 2.5, "SW");
  assert.strictEqual(dup.duplicate, true);
  assert.strictEqual(s.getRecord(id).actualGrams, 3.0);
  s.review(id, "李四", "RV");
  assert.strictEqual(s.review(id, "王五", "RV").duplicate, true);
  assert.strictEqual(s.getRecord(id).reviewer, "李四");
  const c1 = s.correct(id, { grams: 2.95 }, "CR");
  const c2 = s.correct(id, { grams: 1 }, "CR");
  assert.strictEqual(c2.duplicate, true);
  assert.strictEqual(s.getRecord(id).grams, c1.record.grams);
});

ok("失败的投递不占用令牌，修正后可重试成功", () => {
  const s = createGoldStore(memStore());
  const bad = s.submitRequisition({ workId: "w1" }, "RETRY");
  assert.strictEqual(bad.ok, false);
  const good = s.submitRequisition(valid, "RETRY");
  assert.strictEqual(good.ok, true);
  assert.strictEqual(s.getState().records.length, 1);
});

ok("失败操作不写盘、不写履历", () => {
  const mem = memStore();
  const s = createGoldStore(mem);
  const id = s.submitRequisition(valid, "t1").record.id;
  const before = JSON.stringify(mem._dump());
  s.sweep(id, 0, "bad");
  s.review(id, "李四", "bad2"); // 非待复核
  assert.strictEqual(JSON.stringify(mem._dump()), before);
});

ok("履历追加完整（领用→扫粉→复核）", () => {
  const s = createGoldStore(memStore());
  const id = s.submitRequisition(valid, "t1").record.id;
  s.sweep(id, 3.0, "s1");
  s.review(id, "李四", "r1");
  const types = s.getRecord(id).history.map(h => h.type);
  assert.deepStrictEqual(types, ["领用", "待复核", "复核"]);
});

ok("列表与履历读同一状态快照", () => {
  const s = createGoldStore(memStore());
  const snap1 = s.getState();
  const id = snap1.records[0] ? null : s.submitRequisition(valid, "t1").record.id;
  const snap2 = s.getState();
  const rec = snap2.records.find(r => r.id === id);
  assert.strictEqual(snap2.records.length, 1);
  assert.ok(rec.history.length >= 1);
});

ok("reload 后数据与刷新前一致", () => {
  const mem = memStore();
  const s1 = createGoldStore(mem);
  const id = s1.submitRequisition(valid, "t1").record.id;
  s1.sweep(id, 3.0, "s1");
  const s2 = createGoldStore(mem);
  assert.strictEqual(s2.getState().records.length, 1);
  assert.strictEqual(s2.getRecord(id).status, "待复核");
});

console.log("\n全部通过：" + passed + " 项");

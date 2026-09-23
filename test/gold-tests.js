/* Node 冒烟测试：node test/gold-tests.js
 * 用 localStorage 垫片依次加载三块真实脚本（不复制逻辑），验证判定/存档/重复投递/更正作废。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const mem = new Map();
const localStorageShim = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k)
};
const sandbox = {
  console,
  Date,
  Math,
  JSON,
  Object,
  Array,
  Number,
  String,
  isFinite,
  isNaN,
  setTimeout,
  localStorage: localStorageShim,
  crypto: { randomUUID: () => "id-" + Math.random().toString(36).slice(2, 10) },
  document: { addEventListener: () => {} }
};
// 浏览器里 window 即全局本体：window.GoldRules 赋值后裸标识符 GoldRules 即可解析
sandbox.window = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  vm.runInContext(code, sandbox, { filename: rel });
}
load("js/gold-rules.js");
load("js/gold-store.js");
load("js/gold-ui.js");

const { GoldRules, GoldStore } = sandbox.window;

const works = new Map([
  ["w1", { id: "w1", theme: "折枝梅", base: "脱胎盘", status: "上金粉" }],
  ["w2", { id: "w2", theme: "云雷纹", base: "竹胎笔筒", status: "上金粉" }]
]);
const label = id => {
  const w = works.get(id);
  return w ? `${w.theme}（${w.base}）` : "(作品已删除)";
};
function freshStore() {
  mem.clear();
  GoldStore.init({
    workExists: id => works.has(id),
    workLabel: label
  });
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "  -> " + JSON.stringify(detail) : "")); }
}
function expectReject(name, result, fragments) {
  const ok = !result.ok && result.orderId === null &&
    (!fragments || fragments.every(f => result.errors.join("|").includes(f)));
  check(name, ok, result);
}

// 1. 字段不齐整单退回，且不留单、不留履历
freshStore();
let r1 = GoldStore.submitRequisition(
  { workId: "w1", batchNo: "B1", grams: "", roomTemp: 24, operator: "陈师傅" }, "req-1"
);
expectReject("缺克数整单退回", r1, ["领用克数"]);
check("退回不留单", GoldStore.listOrders().length === 0);
check("退回不留履历", GoldStore.listLedger().length === 0);

let r1b = GoldStore.submitRequisition(
  { workId: "w1", batchNo: "B1", grams: 2, roomTemp: "", operator: "" }, "req-1b"
);
expectReject("缺室温与操作者整单退回（错误一次列齐）", r1b, ["室温", "操作者"]);

let r1c = GoldStore.submitRequisition({ workId: "ghost", batchNo: "B1", grams: 2, roomTemp: 24, operator: "陈" }, "req-1c");
expectReject("作品不存在整单退回", r1c, ["作品不存在"]);

// 2. 同批号未核销前只服务一件作品
let r2 = GoldStore.submitRequisition({ workId: "w1", batchNo: "B-SHARE", grams: 2, roomTemp: 24, operator: "甲" }, "req-2");
check("w1 领用成功", r2.ok, r2);
const orderId2 = GoldStore.listOrders()[0].id;
let r2b = GoldStore.submitRequisition({ workId: "w2", batchNo: "B-SHARE", grams: 3, roomTemp: 24, operator: "乙" }, "req-2b");
expectReject("同批号占用：第二件作品被拒", r2b, ["未核销"]);
// 同一件作品继续领同批号是允许的（仍只服务一件）
let r2c = GoldStore.submitRequisition({ workId: "w1", batchNo: "B-SHARE", grams: 1, roomTemp: 24, operator: "甲" }, "req-2c");
check("同批号再领给同一件作品：通过", r2c.ok, r2c);

// 3. 3% 边界：<=3% 核销，>3% 待复核
const R = GoldRules;
check("恰好 3% 在容差内", R.deviation(100, 103).withinTolerance === true);
check("超过 3% 出容差", R.deviation(100, 103.01).withinTolerance === false);
check("实耗偏少同规则", R.deviation(100, 96.99).withinTolerance === false);

// 4. 称重核销与偏差路径
freshStore();
let a = GoldStore.submitRequisition({ workId: "w1", batchNo: "BA", grams: 100, roomTemp: 24, operator: "甲" }, "a");
const oa = GoldStore.listOrders()[0].id;
let w4 = GoldStore.submitWeighing(oa, 102, "w4");
check("偏差 2% 直接核销", w4.ok && GoldStore.listOrders()[0].status === "已核销", w4);
check("核销履历追加 称重+核销", GoldStore.listLedger().filter(e => ["WEIGHING", "WRITE_OFF"].includes(e.type)).length === 2);

let b = GoldStore.submitRequisition({ workId: "w2", batchNo: "BB", grams: 100, roomTemp: 24, operator: "甲" }, "b");
const ob = GoldStore.listOrders().find(o => o.batchNo === "BB").id;
let w4b = GoldStore.submitWeighing(ob, 110, "w4b");
check("偏差 10% 只进待复核", w4b.ok && GoldStore.listOrders().find(o => o.id === ob).status === "待复核", w4b);

// 5. 复核人不得与操作者相同
let rv5a = GoldStore.submitReview(ob, "甲", "rv5a");
expectReject("复核人=操作者 拒绝", rv5a, ["不得与操作者相同"]);
let rv5b = GoldStore.submitReview(ob, "", "rv5b");
expectReject("复核人空 拒绝", rv5b, ["复核人不齐"]);
let rv5c = GoldStore.submitReview(ob, "乙", "rv5c");
check("他人复核通过并核销", rv5c.ok && GoldStore.listOrders().find(o => o.id === ob).status === "已核销", rv5c);

// 6. 批号/克数更正：原核销作废并按新值重算
let c6 = GoldStore.correctRequisition(ob, { batchNo: "BB", grams: 90, roomTemp: 24, operator: "甲" }, "c6");
check("克数更正成功并提示重算", c6.ok && c6.message.includes("重新扫粉称重"), c6);
const obAfter = GoldStore.listOrders().find(o => o.id === ob);
check("更正后回已领用、清称重/复核人", obAfter.status === "已领用" && obAfter.grams === 90 && obAfter.actualGrams === null && obAfter.reviewer === null, obAfter);
const voidEntries = GoldStore.listLedger().filter(e => e.type === "VOID");
check("作废履历留痕", voidEntries.length === 1 && voidEntries[0].text.includes("原已核销结论作废"), voidEntries);

// 6b. 更正成占用中的批号 → 整单退回，原值不变
let bc = GoldStore.submitRequisition({ workId: "w1", batchNo: "BC", grams: 7, roomTemp: 24, operator: "丁" }, "bc");
check("前置：BC 已领用且未核销", bc.ok && GoldStore.listOrders().some(o => o.batchNo === "BC" && o.status === "已领用"));
let c6b = GoldStore.correctRequisition(ob, { batchNo: "BC", grams: 90, roomTemp: 24, operator: "甲" }, "c6b");
expectReject("更正批号撞上未核销单：整单退回", c6b, ["未核销"]);
check("退回后克数/批号不变", (() => { const o = GoldStore.listOrders().find(x => x.id === ob); return o.batchNo === "BB" && o.grams === 90; })());

// 6c. 只改操作者，不动核销结论
GoldStore.submitWeighing(ob, 91, "w6c");
let before = GoldStore.listOrders().find(x => x.id === ob).status;
let c6c = GoldStore.correctRequisition(ob, { batchNo: "BB", grams: 90, roomTemp: 25, operator: "丙" }, "c6c");
let after = GoldStore.listOrders().find(x => x.id === ob);
check("仅改室温/操作者：受理", c6c.ok, c6c);
check("非批号/克数更正不触发作废", after.status === before && after.actualGrams === 91 && GoldStore.listLedger().filter(e => e.type === "VOID").length === 1);
let c6d = GoldStore.correctRequisition(ob, { batchNo: "BB", grams: 90, roomTemp: 25, operator: "丙" }, "c6d");
expectReject("无变化更正退回", c6d, ["没有任何更正"]);

// 7. 重复投递认首次结果
freshStore();
GoldStore.submitRequisition({ workId: "w1", batchNo: "DUP", grams: 5, roomTemp: 24, operator: "甲" }, "same-key");
const dupAgain = GoldStore.submitRequisition(
  { workId: "w2", batchNo: "OTHER", grams: 9, roomTemp: 99, operator: "乙" }, "same-key"
);
check("同 requestId 第二次返回首次结果且不新增单", dupAgain.duplicate === true && dupAgain.ok === true && GoldStore.listOrders().length === 1, dupAgain);

// 退回结果也被首次锁定
GoldStore.submitRequisition({ workId: "", batchNo: "", grams: "", roomTemp: "", operator: "" }, "fail-key");
const dupFail = GoldStore.submitRequisition({ workId: "w1", batchNo: "X", grams: 1, roomTemp: 24, operator: "甲" }, "fail-key");
check("首次退回后同 requestId 仍认首次（退回）", dupFail.duplicate === true && dupFail.ok === false, dupFail);

// 8. 持久化：刷新（重新 init 读 localStorage）后列表与履历一致
const snapshotOrders = GoldStore.listOrders();
const snapshotLedger = GoldStore.listLedger();
GoldStore.init({ workExists: id => works.has(id), workLabel: label });
const reOrders = GoldStore.listOrders();
const reLedger = GoldStore.listLedger();
check("刷新后列表一致", JSON.stringify(reOrders) === JSON.stringify(snapshotOrders));
check("刷新后履历一致", JSON.stringify(reLedger) === JSON.stringify(snapshotLedger));

// 9. 已核销单不能直接称重，提示走更正
const doneId = reOrders[0].id;
GoldStore.submitWeighing(doneId, 5.05, "w9a"); // 偏差 1% → 核销
check("前置：偏差内称重已核销", GoldStore.listOrders().find(o => o.id === doneId).status === "已核销");
const w9 = GoldStore.submitWeighing(doneId, 1, "w9");
expectReject("已核销单拒绝再次称重", w9, ["更正"]);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

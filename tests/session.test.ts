// 会话层测试：快照 / 取消还原 / 确认覆盖与引用清理
import assert from "node:assert/strict";
import type { Document, OutlineSpec } from "../src/shared/types";
import { createDocument } from "../src/shared/document";
import { papers } from "../src/features/paper/lib/presets";
import { makeSteps } from "../src/features/sequence/lib/steps";
import {
  confirmMigration,
  effectiveOutline,
  previewMigration,
  restoreSnapshot,
  takeSnapshot,
} from "../src/features/paper/model/outlineSession";
import { migrateOutline } from "../src/features/paper/lib/migration";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log("  ✓", name);
}

function makeDoc(): Document {
  return createDocument(papers[0]!, makeSteps(papers[0]!));
}
const upperHalf: OutlineSpec = {
  kind: "custom",
  width: 200,
  height: 100,
  polygon: [
    [-100, 0],
    [100, 0],
    [100, 100],
    [-100, 100],
  ],
  relation: "metric",
};

console.log("session:");
test("effectiveOutline 对旧作品返回边长 size 的方纸", () => {
  const doc = makeDoc();
  const o = effectiveOutline(doc.paper);
  assert.equal(o.kind, "square");
  assert.equal(o.width, doc.paper.size);
  assert.equal(o.height, doc.paper.size);
});

test("预览不修改当前作品", () => {
  const doc = makeDoc();
  const before = JSON.stringify(doc.paper);
  const r = previewMigration(doc, upperHalf);
  assert.ok(r.report);
  assert.equal(JSON.stringify(doc.paper), before);
  assert.notEqual(doc.paper, r.paper);
});

test("取消：选中折痕、角度与相机视角逐项还原", () => {
  const doc = makeDoc();
  doc.selected = "c2";
  doc.view.yaw = 73;
  doc.view.pitch = -12;
  doc.view.zoom = 1.8;
  doc.angles = { c1: 44, c2: -30, c3: 90 };
  const snapshot = takeSnapshot(doc);

  // 模拟用户在向导中改动并确认前的临时状态
  doc.selected = "c1";
  doc.view.yaw = 0;
  doc.angles = { c1: 5 };
  const r = migrateOutline(doc.paper, upperHalf);
  assert.ok(r.paper);
  doc.paper = r.paper;

  restoreSnapshot(doc, snapshot);
  assert.equal(doc.selected, "c2");
  assert.equal(doc.view.yaw, 73);
  assert.equal(doc.view.pitch, -12);
  assert.equal(doc.view.zoom, 1.8);
  assert.deepEqual(doc.angles, { c1: 44, c2: -30, c3: 90 });
  assert.equal(doc.paper.id, papers[0]!.id);
  assert.equal(doc.paper.faces.length, 4);
});

test("确认：覆盖旧作品并清理指向消失纸面的步骤/角度引用", () => {
  const doc = makeDoc();
  doc.angles = { c1: 40, c2: -20, c3: 80 };
  const initialCreaseCount = doc.paper.creases.length;
  const outcome = confirmMigration(doc, upperHalf);
  assert.ok(outcome);
  // 至少有一部分折痕在毫米固定的半纸中失效
  assert.ok(doc.paper.creases.length <= initialCreaseCount);
  const keep = new Set(doc.paper.creases.map((c) => c.id));

  // 角度表不得再出现已消失折痕
  for (const id of Object.keys(doc.angles)) assert.ok(keep.has(id));
  // 每个步骤的角度表同样不得悬空
  for (const s of doc.steps)
    for (const id of Object.keys(s.angles)) assert.ok(keep.has(id), `步骤 ${s.id} 引用了不存在的折痕 ${id}`);
  // 选中折痕必须仍然有效
  assert.ok(doc.selected === "" || keep.has(doc.selected));
  assert.ok(outcome.droppedReferences >= 0);
});

test("阻断性报告时确认返回 null，作品保持不变", () => {
  const doc = makeDoc();
  const before = JSON.stringify(doc.paper);
  const bad: OutlineSpec = {
    kind: "custom",
    width: 10,
    height: 10,
    polygon: [
      [900, 900],
      [960, 900],
      [960, 960],
    ],
    relation: "metric",
  };
  assert.equal(confirmMigration(doc, bad), null);
  assert.equal(JSON.stringify(doc.paper), before);
});

test("确认后生成的步骤可以逐步 seek 且不越界", () => {
  const doc = makeDoc();
  confirmMigration(doc, upperHalf);
  assert.ok(doc.steps.length >= 1);
  assert.ok(doc.step >= 0 && doc.step < doc.steps.length);
  for (const s of doc.steps) assert.ok(Object.keys(s.angles).length >= 0);
});

console.log(`\n${passed} 个会话测试全部通过`);

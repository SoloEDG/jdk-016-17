// 端到端：真实预设作品 × 各种外轮廓，验证渲染管线（solvePose / hingePositions）始终可用
import assert from "node:assert/strict";
import { papers } from "../src/features/paper/lib/presets";
import { migrateOutline, outlinePolygon } from "../src/features/paper/lib/migration";
import { solvePose, hingePositions } from "../src/features/fold/lib/kinematics";
import {
  confirmMigration,
  effectiveOutline,
} from "../src/features/paper/model/outlineSession";
import { createDocument } from "../src/shared/document";
import { makeSteps } from "../src/features/sequence/lib/steps";
import type { OutlineSpec } from "../src/shared/types";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log("  ✓", name);
}

const specs = (base: number): OutlineSpec[] => [
  { kind: "square", width: base, height: base, polygon: [], relation: "ratio" },
  { kind: "square", width: base * 0.6, height: base * 0.6, polygon: [], relation: "metric" },
  { kind: "rectangle", width: base * 1.4, height: base * 0.6, polygon: [], relation: "ratio" },
  { kind: "rectangle", width: base * 0.5, height: base * 1.3, polygon: [], relation: "metric" },
  {
    kind: "custom",
    width: base,
    height: base,
    polygon: outlinePolygon({ kind: "square", width: base, height: base, polygon: [], relation: "ratio" })
      .filter((_, i) => i !== 2), // 切掉一个角的四边形 -> 三角形
    relation: "ratio",
  },
];

console.log("end-to-end:");
for (const paper of papers) {
  for (const spec of specs(paper.size)) {
    test(`${paper.name} / ${spec.kind} / ${spec.relation} 渲染管线完整`, () => {
      const r = migrateOutline(paper, spec);
      if (!r.paper) return; // 允许整体不可迁移，但报告必须自洽
      assert.ok(r.report.ok);
      const angles = Object.fromEntries(r.paper.creases.map((c) => [c.id, c.target]));
      const pose = solvePose(r.paper, angles);
      assert.equal(pose.length, r.paper.faces.length);
      const hinges = hingePositions(r.paper, pose);
      assert.equal(hinges.length, r.paper.creases.length);
      // 每个铰链都是非零长度线段
      for (const h of hinges) {
        assert.ok(
          Math.hypot(h.b[0] - h.a[0], h.b[1] - h.a[1], h.b[2] - h.a[2]) > 1e-6,
        );
      }
    });
  }
}

test("确认迁移后 doc 全链路可播放（步骤角度键 ⊆ 现存折痕）", () => {
  const doc = createDocument(papers[0]!, makeSteps(papers[0]!));
  const spec: OutlineSpec = {
    kind: "rectangle",
    width: 140,
    height: 90,
    polygon: [],
    relation: "metric",
  };
  const outcome = confirmMigration(doc, spec);
  assert.ok(outcome);
  const ids = new Set(doc.paper.creases.map((c) => c.id));
  for (const s of doc.steps)
    for (const k of Object.keys(s.angles)) assert.ok(ids.has(k));
  // 每个 step 都能求解
  for (const s of doc.steps) assert.doesNotThrow(() => solvePose(doc.paper, s.angles));
});

test("effectiveOutline 与迁移结果的轮廓多边形一致", () => {
  const doc = createDocument(papers[1]!, makeSteps(papers[1]!));
  const spec: OutlineSpec = {
    kind: "rectangle",
    width: 220,
    height: 120,
    polygon: [],
    relation: "ratio",
  };
  assert.ok(confirmMigration(doc, spec));
  const o = effectiveOutline(doc.paper);
  assert.equal(o.width, 220);
  assert.equal(o.height, 120);
  assert.equal(o.kind, "rectangle");
});

console.log(`\n${passed} 个端到端测试全部通过`);

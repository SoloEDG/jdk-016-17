// 外轮廓迁移测试：使用 vite 自带的 esbuild 转译后在 Node 中运行
//   npx esbuild tests/migration.test.ts --bundle --platform=node --format=esm --outfile=tests/.build/test.mjs && node tests/.build/test.mjs
import assert from "node:assert/strict";
import type { Face, OutlineSpec, Paper, Vec3 } from "../src/shared/types";
import {
  area,
  clipPolygon,
  linePolygonCrossings,
  pointInPolygon,
  samePoint,
  segmentBoundaryHits,
  splitPolygonByLine,
} from "../src/shared/geometry";import {
  migrateOutline,
  outlinePolygon,
  validateOutline,
} from "../src/features/paper/lib/migration";
import { solvePose } from "../src/features/fold/lib/kinematics";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log("  ✓", name);
}

/* ---------------- 夹具：与预设同构的四纸面方形作品 ---------------- */

function squarePaper(size = 200): Paper {
  const faces: Face[] = [
    { id: "a", points: tri([[-1, -1], [1, -1], [1, 0]]) },
    {
      id: "b",
      parent: "a",
      crease: "c1",
      hinge: [
        [-1, 0, -1],
        [1, 0, 0],
      ],
      points: tri([[-1, -1], [1, 0], [1, 1]]),
    },
    {
      id: "c",
      parent: "b",
      crease: "c2",
      hinge: [
        [-1, 0, -1],
        [1, 0, 1],
      ],
      points: tri([[-1, -1], [1, 1], [0, 1]]),
    },
    {
      id: "d",
      parent: "c",
      crease: "c3",
      hinge: [
        [-1, 0, -1],
        [0, 0, 1],
      ],
      points: tri([[-1, -1], [0, 1], [-1, 1]]),
    },
  ];
  return {
    id: "fixture",
    name: "夹具",
    subtitle: "test",
    size,
    faces,
    creases: ["c1", "c2", "c3"].map((id, i) => ({
      id,
      name: "折痕" + id,
      description: "",
      face: ["b", "c", "d"][i]!,
      target: 60,
    })),
  };
}
function tri(points: [number, number][]): Vec3[] {
  return points.map(([x, z]) => [x, 0, z] as Vec3);
}
const square = (w: number, h = w): OutlineSpec => ({
  kind: w === h ? "square" : "rectangle",
  width: w,
  height: h,
  polygon: [],
  relation: "ratio",
});
const polySpec = (polygon: [number, number][], relation: "metric" | "ratio" = "ratio"): OutlineSpec => ({
  kind: "custom",
  width: 200,
  height: 200,
  polygon,
  relation,
});

/* ================= 1. 几何库 ================= */

console.log("geometry:");
test("clipPolygon 保留内部多边形", () => {
  const out = clipPolygon(
    [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ],
    outlinePolygon(square(120)),
  );
  assert.equal(out.length, 4);
  assert.ok(Math.abs(area(out) - 20 * 20) < 1e-6);
});
test("clipPolygon 裁出轮廓内的部分", () => {
  const out = clipPolygon(
    [
      [-100, -100],
      [100, -100],
      [100, 100],
      [-100, 100],
    ],
    outlinePolygon(square(120)),
  );
  assert.ok(Math.abs(area(out) - 120 * 120) < 1e-6);
});
test("splitPolygonByLine 切出两侧且直线上的点共享", () => {
  const r = splitPolygonByLine(
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    [0, 5],
    [1, 0],
  );
  assert.equal(r.positive.length, 4);
  assert.equal(r.negative.length, 4);
  assert.ok(r.positive.some((p) => samePoint(p, [0, 5])));
  assert.ok(r.negative.some((p) => samePoint(p, [0, 5])));
});
test("边缘恰好经过顶点时不产生重复点", () => {
  // 裁剪边精确经过 (0,0)
  const out = clipPolygon(
    [
      [-10, -10],
      [0, 0],
      [10, -10],
      [10, 10],
      [-10, 10],
    ],
    [
      [0, -20],
      [20, -20],
      [20, 20],
      [0, 20],
    ],
  );
  const keys = new Set(out.map((p) => `${p[0]}|${p[1]}`));
  assert.equal(keys.size, out.length);
  assert.ok(pointInPolygon([0, 0], out));
});
test("segmentBoundaryHits 端点落在边界上也被记录", () => {
  const hits = segmentBoundaryHits(
    [-50, 0],
    [50, 0],
    [
      [-30, -30],
      [30, -30],
      [30, 30],
      [-30, 30],
    ],
  );
  assert.equal(hits.length, 2);
});
test("linePolygonCrossings 返回直线与凸多边形的两个穿点", () => {
  const hits = linePolygonCrossings(
    [0, -50],
    [0, 1],
    [
      [-30, -30],
      [30, -30],
      [30, 30],
      [-30, 30],
    ],
  );
  assert.equal(hits.length, 2);
  assert.ok(samePoint(hits[0]!, [0, -30]));
  assert.ok(samePoint(hits[1]!, [0, 30]));
});

/* ================= 2. 方纸 → 方纸（比例 / 毫米） ================= */

console.log("migration: square -> square");
test("比例跟随：折痕端点按比例映射，身份全部保留", () => {
  const r = migrateOutline(squarePaper(200), square(100));
  assert.ok(r.paper);
  assert.equal(r.paper.creases.length, 3);
  assert.deepEqual(r.paper.faces.map((f) => f.id), ["a", "b", "c", "d"]);
  const b = r.paper.faces.find((f) => f.id === "b")!;
  // 原 [-100,-100] 应映射到 [-50,-50]
  assert.ok(samePoint([b.hinge![0][0], b.hinge![0][2]], [-50, -50]));
});
test("毫米固定：缩纸后折痕毫米位置不动，超出部分被裁掉", () => {
  const r = migrateOutline(
    squarePaper(200),
    { ...square(120), relation: "metric" },
  );
  assert.ok(r.paper);
  const b = r.paper.faces.find((f) => f.id === "b")!;
  // c1 原端点 (-100,-100) 在新轮廓 [-60,60] 之外，铰链必须被重新截取且端点落在自身顶点上
  const own = b.points.map((p) => [p[0], p[2]]);
  for (const h of b.hinge!) assert.ok(own.some((v) => samePoint(v, [h[0], h[2]])));
  assert.ok(
    r.report.creaseTraces.some((t) => t.id === "c1" && t.status === "shortened"),
  );
});

/* ================= 3. 方纸 → 长方纸 ================= */

console.log("migration: square -> rectangle");
test("长方纸重新分割受影响纸面，相邻面仍共享边", () => {
  const r = migrateOutline(squarePaper(200), square(240, 120));
  assert.ok(r.paper);
  const shared = (id1: string, id2: string) => {
    const f1 = r.paper!.faces.find((f) => f.id === id1)!;
    const f2 = r.paper!.faces.find((f) => f.id === id2)!;
    return f1.points.some((p) =>
      f2.points.some((q) => samePoint([p[0], p[2]], [q[0], q[2]])),
    );
  };
  assert.ok(shared("a", "b"));
  assert.ok(shared("b", "c"));
  assert.ok(shared("c", "d"));
});
test("迁移结果可以通过运动学求解，无悬空连接", () => {
  const r = migrateOutline(squarePaper(200), square(240, 120));
  const pose = solvePose(r.paper!, { c1: 40, c2: -30, c3: 70 });
  assert.equal(pose.length, r.paper!.faces.length);
});

/* ================= 4. 自定义外轮廓 ================= */

console.log("migration: custom outline");
test("内切六边形：所有纸面与折痕保留，铰链在父纸面内", () => {
  const hex: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    hex.push([100 * Math.cos(a), 100 * Math.sin(a)]);
  }
  const r = migrateOutline(squarePaper(200), polySpec(hex));
  assert.ok(r.paper);
  assert.equal(r.paper.creases.length, 3);
  for (const f of r.paper.faces) {
    if (!f.parent || !f.hinge) continue;
    const parent = r.paper.faces.find((x) => x.id === f.parent)!;
    const m: [number, number] = [
      (f.hinge[0][0] + f.hinge[1][0]) / 2,
      (f.hinge[0][2] + f.hinge[1][2]) / 2,
    ];
    assert.ok(
      pointInPolygon(m, parent.points.map((p) => [p[0], p[2]])),
      `纸面 ${f.id} 铰链中点必须在父纸面内`,
    );
  }
});
test("自交外轮廓被 outline 阶段阻断且不产出 paper", () => {
  const bowtie: [number, number][] = [
    [-50, -50],
    [50, 50],
    [50, -50],
    [-50, 50],
  ];
  const r = migrateOutline(squarePaper(200), polySpec(bowtie));
  assert.equal(r.paper, null);
  assert.ok(r.report.issues.some((i) => i.code === "self-intersect"));
});

/* ================= 5. 边界情形 ================= */

console.log("edge cases:");
test("纸面全部消失：毫米固定 + 远离主体的轮廓，返回错误且 paper 为 null", () => {
  const r = migrateOutline(squarePaper(200), {
    kind: "custom",
    width: 60,
    height: 60,
    polygon: [
      [300, 300],
      [360, 300],
      [360, 360],
    ],
    relation: "metric",
  });
  assert.equal(r.paper, null);
  assert.ok(r.report.issues.some((i) => i.code === "all-vanished"));
  assert.equal(r.report.faceTraces.every((t) => t.status === "vanished"), true);
});
test("父纸面消失且无存活祖先：子面转为独立根部，无悬空 parent 引用", () => {
  // 毫米固定，只保留 z >= 0：纸面 a（完全位于 z<=0）消失
  const upper: [number, number][] = [
    [-100, 0],
    [100, 0],
    [100, 100],
    [-100, 100],
  ];
  const r = migrateOutline(squarePaper(200), polySpec(upper, "metric"));
  assert.ok(r.paper);
  const ids = new Set(r.paper.faces.map((f) => f.id));
  assert.equal(ids.has("a"), false);
  for (const f of r.paper.faces) assert.ok(!f.parent || ids.has(f.parent));
  const b = r.paper.faces.find((f) => f.id === "b")!;
  assert.equal(b.parent, undefined);
  assert.ok(r.report.issues.some((i) => i.code === "orphan-root"));
});
test("中间纸面消失：子面重新挂靠到存活祖先并保留折痕", () => {
  // 合成树 r -> x(将消失) -> y；模型使用归一化单位坐标，size=200 换算为毫米
  const r: Face = {
    id: "r",
    points: tri([
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]),
  };
  const x: Face = {
    id: "x",
    parent: "r",
    crease: "cx",
    hinge: [
      [1.6, 0, -0.4],
      [2.4, 0, -0.4],
    ],
    points: tri([
      [1.5, -0.5],
      [2.5, -0.5],
      [2, 0.5],
    ]),
  };
  const y: Face = {
    id: "y",
    parent: "x",
    crease: "cy",
    hinge: [
      [-0.5, 0, -0.5],
      [0.5, 0, -0.5],
    ],
    points: tri([
      [-0.5, -0.5],
      [0.5, -0.5],
      [0, 0.5],
    ]),
  };
  const src: Paper = {
    id: "tree",
    name: "树",
    subtitle: "",
    size: 200,
    faces: [r, x, y],
    creases: [
      { id: "cx", name: "x折", description: "", face: "x", target: 40 },
      { id: "cy", name: "y折", description: "", face: "y", target: 50 },
    ],
  };
  // 毫米固定、与原纸同尺寸：x 完全在外侧消失，r 与 y 完整保留
  const r2 = migrateOutline(src, { ...square(200), relation: "metric" });
  assert.ok(r2.paper, JSON.stringify(r2.report.issues));
  const ids = new Set(r2.paper.faces.map((f) => f.id));
  assert.deepEqual([...ids], ["r", "y"]);
  const yFace = r2.paper.faces.find((f) => f.id === "y")!;
  assert.equal(yFace.parent, "r");
  assert.equal(yFace.crease, "cy");
  assert.ok(r2.paper.creases.some((c) => c.id === "cy"));
  assert.equal(r2.paper.creases.some((c) => c.id === "cx"), false);
  assert.ok(r2.report.issues.some((i) => i.code === "reparent"));
});
test("狭长区域：低于面积阈值的碎片被丢弃或标记，且不产生自交面", () => {
  // 一条远离主体的薄条：a 面只剩狭长区域，其余纸面彻底消失
  const sliver: [number, number][] = [
    [-100, -100],
    [100, -100],
    [100, -99.9],
    [-100, -99.9],
  ];
  const r = migrateOutline(squarePaper(200), polySpec(sliver, "metric"));
  assert.ok(
    r.report.issues.some(
      (i) => i.code === "all-vanished" || i.code === "face-vanished" || i.code === "sliver-face",
    ),
  );
  if (r.paper)
    for (const f of r.paper.faces) {
      assert.ok(f.points.length >= 3);
      assert.ok(
        area(f.points.map((p) => [p[0], p[2]])) > 1e-4,
        `纸面 ${f.id} 不得是零面积碎片`,
      );
    }
});
test("边缘恰好经过折痕交点：保留共享顶点，无零长度铰链", () => {
  // 毫米固定，新边缘 x=0 恰好经过多条折痕
  const half: [number, number][] = [
    [-100, -100],
    [0, -100],
    [0, 100],
    [-100, 100],
  ];
  const r = migrateOutline(squarePaper(200), polySpec(half, "metric"));
  assert.ok(r.paper);
  for (const f of r.paper.faces) {
    if (f.hinge) {
      const a = f.hinge[0];
      const b = f.hinge[1];
      assert.ok(Math.hypot(b[0] - a[0], b[2] - a[2]) > 1e-6);
      const own = f.points.map((p) => [p[0], p[2]]);
      for (const h of f.hinge) assert.ok(own.some((v) => samePoint(v, [h[0], h[2]])));
    }
  }
  assert.ok(r.report.issues.some((i) => i.code === "edge-through-vertex"));
});
test("不可迁移折痕被列入报告，且不再出现在新作品中", () => {
  const upper: [number, number][] = [
    [-100, 0],
    [100, 0],
    [100, 100],
    [-100, 100],
  ];
  const r = migrateOutline(squarePaper(200), polySpec(upper, "metric"));
  assert.ok(r.paper);
  const removed = r.report.creaseTraces.filter((t) => t.status === "removed");
  assert.ok(removed.length > 0);
  for (const t of removed)
    assert.equal(r.paper.creases.some((c) => c.id === t.id), false);
  const angles = Object.fromEntries(r.paper.creases.map((c) => [c.id, c.target]));
  assert.doesNotThrow(() => solvePose(r.paper!, angles));
});
test("validateOutline 拒绝顶点不足与零面积轮廓", () => {
  assert.ok(
    validateOutline(polySpec([[0, 0], [10, 0]])).some((i) => i.code === "too-few-points"),
  );
  assert.ok(
    validateOutline(polySpec([[0, 0], [10, 0], [20, 0]])).some((i) => i.code === "zero-area"),
  );
});
test("迁移是纯函数：源作品不被修改", () => {
  const src = squarePaper(200);
  const before = JSON.stringify(src);
  migrateOutline(src, square(100));
  assert.equal(JSON.stringify(src), before);
});

/* ================= 6. 沿折痕重新分割纸面 ================= */

console.log("face splitting:");
test("折痕穿过面内部：该面被切成共享折边的两个面，且仍能运动求解", () => {
  // 单个方形纸面 root，内部有一条横贯折痕（折痕端点在面的两条对边上，属于内部折痕）
  const root: Face = {
    id: "root",
    points: tri([
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]),
  };
  const holder: Face = {
    id: "holder",
    parent: "root",
    crease: "cx",
    hinge: [
      [-1, 0, 0],
      [1, 0, 0],
    ],
    // 与 root 同区域，模拟折痕把同一纸面分成上下两片
    points: tri([
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]),
  };
  const src: Paper = {
    id: "split-fixture",
    name: "分割夹具",
    subtitle: "",
    size: 200,
    faces: [root, holder],
    creases: [
      { id: "cx", name: "横贯折", description: "", face: "holder", target: 70 },
    ],
  };
  // 毫米固定、裁掉下沿，迫使折痕端点被新边缘截断并重新分割
  const spec: OutlineSpec = {
    kind: "rectangle",
    width: 200,
    height: 120,
    polygon: [],
    relation: "metric",
  };
  const r = migrateOutline(src, spec);
  assert.ok(r.paper, JSON.stringify(r.report.issues));
  const trace = r.report.faceTraces.find((t) => t.originId === "holder")!;
  assert.equal(trace.status, "split");
  assert.ok(trace.faceIds.length >= 2);
  // 分割出的同级面挂在承载面下，并通过同一折痕共享折边
  const carrier = r.paper.faces.find((f) => f.id === "holder")!;
  const sibling = r.paper.faces.find((f) => f.id !== "holder" && f.id.startsWith("holder"))!;
  assert.equal(sibling.parent, "holder");
  assert.equal(carrier.crease, "cx");
  // 两个面必须共享至少两个顶点（共享折边）
  const shared = carrier.points.filter((p) =>
    sibling.points.some((q) => samePoint([p[0], p[2]], [q[0], q[2]])),
  );
  assert.ok(shared.length >= 2, "分割后的两个纸面必须共享折边");
  // 折轴端点必须落在承载面顶点上
  const own = carrier.points.map((p) => [p[0], p[2]]);
  for (const h of carrier.hinge!)
    assert.ok(own.some((v) => samePoint(v, [h[0], h[2]])));
  // 面积守恒：同级面 + 承载面 = 承载面被裁出的整块区域（无重叠、无缝隙）
  const holderArea = area(carrier.points.map((p) => [p[0], p[2]]));
  const siblingArea = area(sibling.points.map((p) => [p[0], p[2]]));
  assert.ok(holderArea > 0 && siblingArea > 0);
  // 承载面原本铺满 200×120 的裁剪区域，被折痕一分为二，两片面积之和应等于整块
  assert.ok(Math.abs(holderArea + siblingArea - 200 * 120) < 1e-2);
  // 完整运动学求解不抛错
  assert.doesNotThrow(() => solvePose(r.paper!, { cx: 60 }));
});
test("分割产生的纸面身份在 faceTraces 中可追溯", () => {
  const root: Face = {
    id: "root",
    points: tri([
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]),
  };
  const holder: Face = {
    id: "holder",
    parent: "root",
    crease: "cx",
    hinge: [
      [-1, 0, 0.2],
      [1, 0, 0.2],
    ],
    points: tri([
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]),
  };
  const src: Paper = {
    id: "split2",
    name: "分割夹具2",
    subtitle: "",
    size: 200,
    faces: [root, holder],
    creases: [
      { id: "cx", name: "斜折", description: "", face: "holder", target: 45 },
    ],
  };
  const r = migrateOutline(src, square(200));
  assert.ok(r.paper);
  const allOutputs = r.report.faceTraces.flatMap((t) => t.faceIds);
  for (const f of r.paper.faces) assert.ok(allOutputs.includes(f.id));
});

console.log(`\n${passed} 个测试全部通过`);

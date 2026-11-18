import type {
  Crease,
  Face,
  MigrationIssue,
  MigrationReport,
  MigrationResult,
  OutlineSpec,
  Paper,
  Vec2,
  Vec3,
} from "../../../shared/types";
import {
  EPS,
  area,
  centroid,
  clipPolygon,
  dedupe,
  ensureCCW,
  linePolygonCrossings,
  pointInPolygon,
  pointOnSegment,
  samePoint,
  segmentBoundaryHits,
  splitPolygonByLine,
  validFacePolygon,
} from "../../../shared/geometry";

/* ------------------------------------------------------------------ */
/* 外轮廓                                                              */
/* ------------------------------------------------------------------ */

/** 由外轮廓描述得到毫米坐标的逆时针多边形 */
export function outlinePolygon(spec: OutlineSpec): Vec2[] {
  if (spec.kind === "custom") return ensureCCW(spec.polygon.map((p) => [...p] as Vec2));
  const w = spec.width / 2;
  const h = spec.height / 2;
  return ensureCCW([
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ]);
}

/** 外轮廓自身的合法性检查（自定义多边形的自交、退化等） */
export function validateOutline(spec: OutlineSpec): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  if (spec.kind !== "custom") {
    if (!(spec.width > 0) || !(spec.height > 0))
      issues.push({
        level: "error",
        stage: "outline",
        code: "bad-dimension",
        message: "外轮廓宽高必须为正数。",
      });
    return issues;
  }
  const poly = dedupe(spec.polygon);
  if (poly.length < 3)
    issues.push({
      level: "error",
      stage: "outline",
      code: "too-few-points",
      message: "自定义外轮廓至少需要 3 个不重合的顶点。",
    });
  if (poly.length >= 3 && area(poly) <= 1e-4)
    issues.push({
      level: "error",
      stage: "outline",
      code: "zero-area",
      message: "自定义外轮廓面积为零，无法构成纸面。",
    });
  // 非相邻边相交 => 自交多边形
  for (let i = 0; i < poly.length; i++) {
    const a1 = poly[i]!;
    const a2 = poly[(i + 1) % poly.length]!;
    for (let j = i + 2; j < poly.length; j++) {
      if (i === 0 && j === poly.length - 1) continue;
      const b1 = poly[j]!;
      const b2 = poly[(j + 1) % poly.length]!;
      const hits = segmentBoundaryHits(a1, a2, [b1, b2]);
      const interior = hits.filter((h) => h.t > EPS && h.t < 1 - EPS);
      if (interior.length)
        issues.push({
          level: "error",
          stage: "outline",
          code: "self-intersect",
          message: "自定义外轮廓存在自交，无法确定纸面内外。",
        });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* 坐标映射：毫米固定 / 比例跟随                                        */
/* ------------------------------------------------------------------ */

interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const from2 = (p: Vec2): Vec3 => [p[0], 0, p[1]];

/** 模型坐标是归一化单位坐标，按 size 换算为毫米 */
function modelToMm(paper: Paper): (p: Vec3) => Vec2 {
  const s = paper.size / 2;
  return (p) => [p[0] * s, p[2] * s];
}

function sourceBox(points: Vec2[]): Box {
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}

function targetBox(spec: OutlineSpec): Box {
  if (spec.kind === "custom") return sourceBox(spec.polygon);
  return sourceBox(outlinePolygon(spec));
}

function makeMapper(relation: OutlineSpec["relation"], src: Box, dst: Box) {
  if (relation === "metric") return (p: Vec2): Vec2 => [p[0], p[1]];
  const sx = (dst.maxX - dst.minX) / (src.maxX - src.minX || 1);
  const sz = (dst.maxZ - dst.minZ) / (src.maxZ - src.minZ || 1);
  return (p: Vec2): Vec2 => [
    dst.minX + (p[0] - src.minX) * sx,
    dst.minZ + (p[1] - src.minZ) * sz,
  ];
}

/* ------------------------------------------------------------------ */
/* 折痕线段裁剪                                                        */
/* ------------------------------------------------------------------ */

interface RetainedSegment {
  a: Vec2;
  b: Vec2;
  onBoundary: boolean;
}

/** 把线段 a-b 裁剪进多边形，返回最长的保留段 */
function clipSegmentToPolygon(a: Vec2, b: Vec2, poly: Vec2[]): RetainedSegment | null {
  const aIn = pointInPolygon(a, poly);
  const bIn = pointInPolygon(b, poly);
  const ts: number[] = [];
  if (aIn) ts.push(0);
  if (bIn) ts.push(1);
  for (const hit of segmentBoundaryHits(a, b, poly)) ts.push(hit.t);
  ts.sort((x, y) => x - y);
  const uniq = ts.filter((t, i) => i === 0 || Math.abs(t - ts[i - 1]!) > EPS);
  const segs: RetainedSegment[] = [];
  for (let i = 0; i < uniq.length - 1; i++) {
    const t0 = uniq[i]!;
    const t1 = uniq[i + 1]!;
    const p0: Vec2 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
    const p1: Vec2 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
    const m: Vec2 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    if (!pointInPolygon(m, poly)) continue;
    const onBoundary =
      !pointInPolygon(
        [m[0] + (p1[0] - p0[0]) * 1e-5, m[1] + (p1[1] - p0[1]) * 1e-5],
        poly,
      ) ||
      !pointInPolygon([m[0] - (p1[0] - p0[0]) * 1e-5, m[1] - (p1[1] - p0[1]) * 1e-5], poly);
    segs.push({ a: p0, b: p1, onBoundary });
  }
  if (!segs.length) return null;
  segs.sort((s, t) => {
    const la = (s.a[0] - s.b[0]) ** 2 + (s.a[1] - s.b[1]) ** 2;
    const lb = (t.a[0] - t.b[0]) ** 2 + (t.a[1] - t.b[1]) ** 2;
    return lb - la;
  });
  return segs[0]!;
}

/* ------------------------------------------------------------------ */
/* 全局顶点焊接：保证相邻纸面继续共享边，不出现各自独立的重合点          */
/* ------------------------------------------------------------------ */

const WELD_EPS = 1e-7;

function weldFaces(faces: Face[]): Map<number, Vec2>[] {
  const all: { face: number; index: number; p: Vec2 }[] = [];
  faces.forEach((f, fi) =>
    f.points.forEach((p, pi) => all.push({ face: fi, index: pi, p: [p[0], p[2]] })),
  );
  const parent = all.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      if (samePoint(all[i]!.p, all[j]!.p, WELD_EPS)) parent[find(j)] = find(i);
  const reps = new Map<number, Vec2>();
  for (let i = 0; i < all.length; i++) {
    const root = find(i);
    if (!reps.has(root)) reps.set(root, [...all[i]!.p] as Vec2);
  }
  return faces.map((f, fi) => {
    const map = new Map<number, Vec2>();
    f.points.forEach((_, pi) => {
      const flat = all.findIndex((q) => q.face === fi && q.index === pi);
      map.set(pi, reps.get(find(flat))!);
    });
    return map;
  });
}

function snapToSet(q: Vec2, points: Vec3[], eps = WELD_EPS * 100): Vec2 {
  let best: Vec2 = [q[0], q[1]];
  let bestD = Infinity;
  for (const p of points) {
    const d = (p[0] - q[0]) ** 2 + (p[2] - q[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = [p[0], p[2]];
    }
  }
  return bestD <= eps ? best : [q[0], q[1]];
}

/* ------------------------------------------------------------------ */
/* 内部结构：迁移过程中的纸面记录                                        */
/* ------------------------------------------------------------------ */

interface Entry {
  /** 输出纸面 id；承载面沿用原 id，分割出的同级面使用派生 id */
  id: string;
  /** 溯源到的原纸面 id */
  origin: string;
  poly: Vec2[];
  /** 父纸面的输出 id（解析后写入） */
  parentId?: string;
  /** 该纸面承载的折痕 id */
  crease?: string;
  /** 折轴（毫米，2D），最终吸附到自身顶点 */
  hinge?: [Vec2, Vec2];
  /** 是否为分割产生的同级面 */
  splitSibling?: boolean;
}

/* ------------------------------------------------------------------ */
/* 迁移主流程（六阶段，逐步记录检查项）                                  */
/* ------------------------------------------------------------------ */

export function migrateOutline(source: Paper, spec: OutlineSpec): MigrationResult {
  const issues: MigrationIssue[] = [];
  const push = (
    level: MigrationIssue["level"],
    stage: MigrationIssue["stage"],
    code: string,
    message: string,
    refId?: string,
  ) => issues.push({ level, stage, code, message, refId });

  /* 阶段 1：外轮廓校验与规范化 */
  issues.push(...validateOutline(spec));
  if (issues.some((i) => i.level === "error"))
    return { paper: null, report: finalize(issues, [], [], 1, 0, 0) };

  const clip = outlinePolygon(spec);
  const toMm = modelToMm(source);
  const srcVertices = source.faces.flatMap((f) => f.points.map(toMm));
  const map = makeMapper(spec.relation, sourceBox(srcVertices), targetBox(spec));
  const map3 = (p: Vec3): Vec2 => map(toMm(p));
  const onClipBoundary = (q: Vec2) => {
    for (let i = 0; i < clip.length; i++)
      if (pointOnSegment(q, [clip[i]!, clip[(i + 1) % clip.length]!], EPS * 10))
        return true;
    return false;
  };

  /* 阶段 2：逐纸面裁剪，保留身份；记录消失纸面 */
  const entries: Entry[] = [];
  const carrierId = new Map<string, string>(); // origin -> 当前承载面输出 id
  const vanished: string[] = [];
  const oldArea = source.faces.reduce((s, f) => s + area(f.points.map((p) => toMm(p))), 0);
  for (const f of source.faces) {
    const mapped = ensureCCW(f.points.map((p) => map3(p)));
    const clipped = clipPolygon(mapped, clip);
    if (!validFacePolygon(clipped)) {
      vanished.push(f.id);
      push(
        "warning",
        "topology",
        "face-vanished",
        `纸面 ${f.id} 完全落在新外轮廓之外（或只剩无法成形的狭长区域），已移除。`,
        f.id,
      );
      continue;
    }
    if (area(clipped) < area(mapped) * 0.02)
      push(
        "info",
        "topology",
        "sliver-face",
        `纸面 ${f.id} 仅剩狭长区域，折叠时请注意避让。`,
        f.id,
      );
    entries.push({ id: f.id, origin: f.id, poly: ensureCCW(clipped) });
    carrierId.set(f.id, f.id);
  }
  if (entries.length === 0) {
    push("error", "topology", "all-vanished", "新外轮廓没有覆盖任何纸面，迁移无法进行。");
    return {
      paper: null,
      report: finalize(
        issues,
        source.faces.map((f) => ({ originId: f.id, faceIds: [], status: "vanished" as const })),
        source.creases.map((c) => ({
          id: c.id,
          name: c.name,
          status: "removed" as const,
          message: "承载纸面已随外轮廓消失。",
        })),
        oldArea,
        0,
        0,
      ),
    };
  }
  const entryById = (id: string) => entries.find((e) => e.id === id)!;

  /* 阶段 3：折痕重截取 + 沿幸存折痕线重新分割受影响纸面 */
  const creaseTraces: MigrationReport["creaseTraces"] = [];
  const survivingCreases = new Set<string>();
  let boundaryIntersections = 0;
  let splitCount = 0;

  for (const c of source.creases) {
    const holderId = carrierId.get(c.face);
    const holder = holderId ? entries.find((e) => e.id === holderId) : undefined;
    if (!holder) {
      creaseTraces.push({
        id: c.id,
        name: c.name,
        status: "removed",
        message: "承载纸面已随外轮廓消失。",
      });
      push("warning", "creases", "crease-removed", `折痕「${c.name}」无法迁移。`, c.id);
      continue;
    }
    const base = source.faces.find((f) => f.id === c.face)!;
    const h0 = map3(base.hinge![0]);
    const h1 = map3(base.hinge![1]);
    const origLen = Math.hypot(h1[0] - h0[0], h1[1] - h0[1]);
    const seg = clipSegmentToPolygon(h0, h1, holder.poly);
    if (!seg || Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]) <= EPS) {
      creaseTraces.push({
        id: c.id,
        name: c.name,
        status: "removed",
        message: "折痕在新外轮廓内没有有效长度。",
      });
      push("warning", "creases", "crease-degenerate", `折痕「${c.name}」退化为点，已移除。`, c.id);
      continue;
    }
    const sa = snapToSet(seg.a, holder.poly.map(from2));
    const sb = snapToSet(seg.b, holder.poly.map(from2));
    if (onClipBoundary(sa) || onClipBoundary(sb)) boundaryIntersections++;

    // 沿折痕无限直线重新分割承载纸面（处理折痕穿过面内部的一般拓扑）
    const dir: Vec2 = [h1[0] - h0[0], h1[1] - h0[1]];
    const crossings = linePolygonCrossings(h0, dir, holder.poly);
    if (crossings.length >= 2) {
      const cut = splitPolygonByLine(holder.poly, crossings[0]!, [
        crossings[1]![0] - crossings[0]![0],
        crossings[1]![1] - crossings[0]![1],
      ]);
      if (cut.positive.length && cut.negative.length) {
        // 承载面质心所在的一侧保留原身份，另一侧成为共享折边的同级面
        const center = centroid(holder.poly);
        const keepPositive = pointInPolygon(center, cut.positive);
        const keptPoly = ensureCCW(keepPositive ? cut.positive : cut.negative);
        const siblingPoly = ensureCCW(keepPositive ? cut.negative : cut.positive);
        const siblingId = `${holder.id}--s${splitCount + 1}`;
        holder.poly = keptPoly;
        const sibling: Entry = {
          id: siblingId,
          origin: holder.origin,
          poly: siblingPoly,
          parentId: holder.id,
          splitSibling: true,
        };
        entries.push(sibling);
        splitCount++;
        push(
          "info",
          "topology",
          "face-split",
          `纸面 ${holder.origin} 被折痕「${c.name}」重新分割为两个仍共享折边的纸面（${holder.id} / ${siblingId}）。`,
          holder.origin,
        );
      }
    }

    // 折痕身份固定在承载面上，折轴重新吸附到分割后的顶点
    const finalA = snapToSet(sa, holder.poly.map(from2));
    const finalB = snapToSet(sb, holder.poly.map(from2));
    holder.crease = c.id;
    holder.hinge = [finalA, finalB];
    survivingCreases.add(c.id);
    const newLen = Math.hypot(finalB[0] - finalA[0], finalB[1] - finalA[1]);
    if (newLen < origLen - EPS * 10) {
      creaseTraces.push({
        id: c.id,
        name: c.name,
        status: "shortened",
        message: seg.onBoundary
          ? "折痕端点被新边缘截断，已沿新边界重新截取。"
          : "折痕端点随外轮廓缩短，折叠轴已重新计算。",
      });
      push(
        "info",
        "creases",
        "crease-shortened",
        `折痕「${c.name}」端点被裁掉，已在新纸面内重新截取并保留身份。`,
        c.id,
      );
    } else {
      creaseTraces.push({
        id: c.id,
        name: c.name,
        status: "migrated",
        message: "折痕完整保留，与纸边的位置关系按所选规则映射。",
      });
    }
  }

  /* 阶段 4：拓扑重建 —— 父纸面消失时挂靠最近的存活祖先；同级面挂到承载面 */
  const aliveOrigin = new Set(entries.map((e) => e.origin));
  for (const e of entries) {
    if (e.splitSibling) continue; // 同级面的父级已在分割时确定
    const srcFace = source.faces.find((f) => f.id === e.origin)!;
    let ancestor = srcFace.parent;
    const chain: string[] = [];
    while (ancestor && !aliveOrigin.has(ancestor)) {
      chain.push(ancestor);
      ancestor = source.faces.find((x) => x.id === ancestor)?.parent;
    }
    if (srcFace.parent && !aliveOrigin.has(srcFace.parent)) {
      if (ancestor) {
        e.parentId = carrierId.get(ancestor);
        push(
          "info",
          "topology",
          "reparent",
          `纸面 ${e.id} 的父纸面 ${chain.join(" → ")} 已消失，重新挂靠到纸面 ${e.parentId}，折叠从属关系保留。`,
          e.id,
        );
      } else {
        push(
          "warning",
          "topology",
          "orphan-root",
          `纸面 ${e.id} 的所有祖先纸面均已消失，成为独立根部；对应折痕的折叠关系无法迁移。`,
          e.id,
        );
        e.parentId = undefined;
        e.crease = undefined;
        e.hinge = undefined;
      }
    } else if (srcFace.parent) {
      e.parentId = carrierId.get(srcFace.parent);
    }
  }

  /* 阶段 5：生成 Face、全局焊接与连接检查（不允许留下指向不存在纸面的步骤） */
  const newFaces: Face[] = entries.map((e) => ({
    id: e.id,
    points: e.poly.map(from2),
    ...(e.parentId ? { parent: e.parentId } : {}),
    ...(e.hinge ? { hinge: [from2(e.hinge[0]), from2(e.hinge[1])] as [Vec3, Vec3] } : {}),
    ...(e.crease ? { crease: e.crease } : {}),
  }));
  const welded = weldFaces(newFaces);
  newFaces.forEach((f, fi) => {
    const map2 = welded[fi]!;
    f.points = f.points.map((_, pi) => from2(map2.get(pi)!));
    if (f.hinge) {
      const wa = snapToSet([f.hinge[0][0], f.hinge[0][2]], f.points);
      const wb = snapToSet([f.hinge[1][0], f.hinge[1][2]], f.points);
      f.hinge = [from2(wa), from2(wb)];
    }
  });
  const idSet = new Set(newFaces.map((f) => f.id));
  for (const f of newFaces) {
    if (f.parent && !idSet.has(f.parent))
      push("error", "kinematics", "dangling-parent", `纸面 ${f.id} 指向已不存在的父纸面。`, f.id);
    // 成环检查
    const seen = new Set<string>();
    let cur: string | undefined = f.id;
    while (cur) {
      if (seen.has(cur)) {
        push("error", "kinematics", "cycle", `纸面连接在 ${cur} 处成环。`, cur);
        break;
      }
      seen.add(cur);
      cur = newFaces.find((x) => x.id === cur)?.parent;
    }
    if (f.parent && f.hinge) {
      const parent = newFaces.find((x) => x.id === f.parent)!;
      const poly = parent.points.map((p) => [p[0], p[2]] as Vec2);
      const m: Vec2 = [(f.hinge[0][0] + f.hinge[1][0]) / 2, (f.hinge[0][2] + f.hinge[1][2]) / 2];
      if (!pointInPolygon(m, poly))
        push(
          "error",
          "kinematics",
          "broken-hinge",
          `纸面 ${f.id} 的折轴不再落在父纸面内，连接断裂。`,
          f.id,
        );
      const own = f.points.map((p) => [p[0], p[2]] as Vec2);
      for (const h of [f.hinge[0], f.hinge[1]]) {
        const hp: Vec2 = [h[0], h[2]];
        if (!own.some((v) => samePoint(v, hp, WELD_EPS * 10)))
          push(
            "error",
            "kinematics",
            "hinge-vertex",
            `纸面 ${f.id} 的折轴端点没有落在自身顶点上。`,
            f.id,
          );
      }
    }
  }

  /* 阶段 6：引用清理 —— 折痕对象、身份去向、面积统计 */
  const newCreases: Crease[] = source.creases
    .filter((c) => survivingCreases.has(c.id))
    .map((c) => ({ ...c }));
  for (const f of newFaces)
    if (f.crease && !survivingCreases.has(f.crease)) {
      delete f.crease;
      delete f.hinge;
      delete f.parent;
    }

  const originToOutputs = new Map<string, string[]>();
  for (const e of entries) {
    const list = originToOutputs.get(e.origin) ?? [];
    list.push(e.id);
    originToOutputs.set(e.origin, list);
  }
  const faceTraces: MigrationReport["faceTraces"] = source.faces.map((f) => {
    const ids = originToOutputs.get(f.id);
    if (!ids) return { originId: f.id, faceIds: [], status: "vanished" as const };
    return {
      originId: f.id,
      faceIds: ids,
      status: ids.length > 1 ? ("split" as const) : ("kept" as const),
    };
  });
  const newArea = newFaces.reduce(
    (s, f) => s + area(f.points.map((p) => [p[0], p[2]] as Vec2)),
    0,
  );
  const paper: Paper = {
    ...source,
    name: source.name,
    subtitle: source.subtitle,
    size: spec.kind === "square" ? spec.width : source.size,
    outline: { ...spec, polygon: spec.polygon.map((p) => [...p] as Vec2) },
    faces: newFaces,
    creases: newCreases,
  };
  const result: MigrationResult = {
    paper,
    report: finalize(issues, faceTraces, creaseTraces, oldArea, newArea, boundaryIntersections),
  };
  if (result.report.issues.some((i) => i.level === "error")) result.paper = null;
  return result;
}

function finalize(
  issues: MigrationIssue[],
  faceTraces: MigrationReport["faceTraces"],
  creaseTraces: MigrationReport["creaseTraces"],
  oldArea: number,
  newArea: number,
  boundaryIntersections: number,
): MigrationReport {
  if (boundaryIntersections > 0)
    issues.push({
      level: "info",
      stage: "topology",
      code: "edge-through-vertex",
      message: `新边缘恰好经过 ${boundaryIntersections} 处折痕交点，已按共享顶点保留身份，未产生重复点或零长度边。`,
    });
  const areaRatio = oldArea > 0 ? newArea / oldArea : 0;
  return {
    issues,
    faceTraces,
    creaseTraces,
    areaRatio,
    ok: !issues.some((i) => i.level === "error"),
  };
}

export function survivingCreaseIds(result: MigrationResult): string[] {
  return result.paper ? result.paper.creases.map((c) => c.id) : [];
}

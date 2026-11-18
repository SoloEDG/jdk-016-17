import type { Vec2 } from "./types";

/**
 * 纸面平面几何工具。
 * 纸面铺在 y = 0 平面，使用 (x, z) 两个毫米坐标，即 Vec2 = [x, z]。
 * 所有重合 / 过交点判断都经过统一的 EPS 分类，避免边缘恰好经过交点时
 * 产生重复顶点、零长度边或方向翻转。
 */
export const EPS = 1e-6;
export const SLIVER_AREA = 1e-4;

export const v = (x: number, z: number): Vec2 => [x, z];
export const clone = (p: Vec2): Vec2 => [p[0], p[1]];
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const len = (a: Vec2) => Math.hypot(a[0], a[1]);
export const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** 带容差的相等判断 */
export function samePoint(a: Vec2, b: Vec2, eps = EPS) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}

/** 有符号面积：正值表示逆时针 */
export function signedArea(poly: Vec2[]) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += cross(a, b);
  }
  return s / 2;
}

export const area = (poly: Vec2[]) => Math.abs(signedArea(poly));

/** 去除连续重复点（含首尾相接） */
export function dedupe(poly: Vec2[], eps = EPS): Vec2[] {
  const out: Vec2[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || !samePoint(last, p, eps)) out.push(clone(p));
  }
  if (out.length > 1 && samePoint(out[0]!, out[out.length - 1]!, eps)) out.pop();
  return out;
}

/** 统一逆时针方向 */
export function ensureCCW(poly: Vec2[]): Vec2[] {
  const p = dedupe(poly);
  return signedArea(p) < 0 ? p.slice().reverse() : p;
}

/** 点是否在多边形内（含边界，射线法） */
export function pointInPolygon(p: Vec2, poly: Vec2[], eps = EPS): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (pointOnSegment(p, [a, b], eps)) return true;
    const intersect =
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] || EPS) + a[0];
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 点到线段的距离 */
export function distanceToSegment(p: Vec2, [a, b]: [Vec2, Vec2]) {
  const ab = sub(b, a);
  const t = len(ab) <= EPS ? 0 : dot(sub(p, a), ab) / dot(ab, ab);
  const c = add(a, scale(ab, Math.max(0, Math.min(1, t))));
  return dist(p, c);
}

export function pointOnSegment(p: Vec2, seg: [Vec2, Vec2], eps = EPS) {
  return distanceToSegment(p, seg) <= eps;
}

/** 两线段交点；无交点返回 null（重合共线视为无唯一点，返回 null） */
export function segmentIntersection(
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  p4: Vec2,
  eps = EPS,
): { point: Vec2; t: number; u: number } | null {
  const d1 = sub(p2, p1);
  const d2 = sub(p4, p3);
  const denom = cross(d1, d2);
  if (Math.abs(denom) <= eps) return null; // 平行或共线
  const t = cross(sub(p3, p1), d2) / denom;
  const u = cross(sub(p3, p1), d1) / denom;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  const tc = Math.max(0, Math.min(1, t));
  return { point: add(p1, scale(d1, tc)), t: tc, u };
}

/**
 * 两条无限直线的交点（点 + 沿第一条直线的参数 t）。
 * 裁剪算法（Sutherland–Hodgman 等）需要无限直线语义，
 * 不能用有限线段求交，否则交点落在裁剪边延长线上时会被漏掉。
 */
export function lineIntersection(
  p1: Vec2,
  d1: Vec2,
  p3: Vec2,
  d2: Vec2,
  eps = EPS,
): { point: Vec2; t: number } | null {
  const denom = cross(d1, d2);
  if (Math.abs(denom) <= eps) return null;
  const w = sub(p3, p1);
  const t = cross(w, d2) / denom;
  return { point: add(p1, scale(d1, t)), t };
}

/**
 * Sutherland–Hodgman 多边形裁剪：返回 subject 在 clip 内部的部分。
 * clip 必须为逆时针凸/凹多边形（逐边半平面求交）。
 */
export function clipPolygon(subject: Vec2[], clip: Vec2[], eps = EPS): Vec2[] {
  let output = dedupe(subject, eps);
  if (output.length < 3) return [];
  const cp = ensureCCW(clip);
  for (let i = 0; i < cp.length; i++) {
    const a = cp[i]!;
    const b = cp[(i + 1) % cp.length]!;
    const edge = sub(b, a);
    const inside = (p: Vec2) => cross(edge, sub(p, a)) >= -eps;
    const input = output;
    output = [];
    if (input.length === 0) break;
    for (let j = 0; j < input.length; j++) {
      const cur = input[j]!;
      const prev = input[(j + input.length - 1) % input.length]!;
      const curIn = inside(cur);
      const prevIn = inside(prev);
      const hitLine = () => lineIntersection(prev, sub(cur, prev), a, edge);
      if (curIn) {
        if (!prevIn) {
          const hit = hitLine();
          output.push(hit ? clone(hit.point) : clone(cur));
        }
        output.push(clone(cur));
      } else if (prevIn) {
        const hit = hitLine();
        if (hit) output.push(clone(hit.point));
      }
    }
    output = dedupe(output, eps);
  }
  return output;
}

/** 多边形是否为有效的可渲染纸面（面积足够且边数 >= 3） */
export function validFacePolygon(poly: Vec2[]) {
  const p = dedupe(poly);
  return p.length >= 3 && area(p) > SLIVER_AREA;
}

/**
 * 用一条无限直线把多边形切成两侧。
 * 直线由点 a 与方向 d 定义；返回 { positive, negative }，
 * 分别对应 cross(d, p-a) >= 0 与 <= 0 一侧（直线上的点两侧都保留）。
 * 任一侧退化为空或狭长面时对应数组为空。
 */
export function splitPolygonByLine(
  poly: Vec2[],
  a: Vec2,
  d: Vec2,
): { positive: Vec2[]; negative: Vec2[] } {
  const p = ensureCCW(poly);
  const side = (q: Vec2) => cross(d, sub(q, a));
  const pos: Vec2[] = [];
  const neg: Vec2[] = [];
  const inPos = (s: number) => s >= -EPS;
  const inNeg = (s: number) => s <= EPS;
  for (let i = 0; i < p.length; i++) {
    const cur = p[i]!;
    const prev = p[(i + p.length - 1) % p.length]!;
    const sc = side(cur);
    const sp = side(prev);
    const crossing = (sp > EPS && sc < -EPS) || (sp < -EPS && sc > EPS);
    const hit = crossing ? lineIntersection(prev, sub(cur, prev), a, d) : null;
    // 标准 SH 顺序：跨越时先推入交点，再推入当前点，保证环序正确
    if (inPos(sc)) {
      if (!inPos(sp) && hit) pos.push(clone(hit.point));
      pos.push(clone(cur));
    } else if (inPos(sp) && hit) {
      pos.push(clone(hit.point));
    }
    if (inNeg(sc)) {
      if (!inNeg(sp) && hit) neg.push(clone(hit.point));
      neg.push(clone(cur));
    } else if (inNeg(sp) && hit) {
      neg.push(clone(hit.point));
    }
  }
  return {
    positive: validFacePolygon(pos) ? ensureCCW(dedupe(pos)) : [],
    negative: validFacePolygon(neg) ? ensureCCW(dedupe(neg)) : [],
  };
}

/** 线段与多边形边界的所有交点（去重，按参数 t 排序），端点在边界上也计入 */
export function segmentBoundaryHits(
  a: Vec2,
  b: Vec2,
  poly: Vec2[],
  eps = EPS,
): { point: Vec2; t: number }[] {
  const hits: { point: Vec2; t: number }[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p3 = poly[i]!;
    const p4 = poly[(i + 1) % poly.length]!;
    const hit = segmentIntersection(a, b, p3, p4, eps);
    if (hit) hits.push({ point: clone(hit.point), t: hit.t });
  }
  hits.sort((x, y) => x.t - y.t);
  const out: { point: Vec2; t: number }[] = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (!last || !samePoint(last.point, h.point, eps)) out.push(h);
  }
  return out;
}

/** 计算多边形质心 */
export function centroid(poly: Vec2[]): Vec2 {
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p[0];
    cz += p[1];
  }
  return [cx / poly.length, cz / poly.length];
}

/**
 * 无限直线与多边形边界的两个交点（直线穿过凸多边形时）。
 * 直线与多边形相切 / 只碰顶点时返回单个点；完全不相交返回空数组。
 */
export function linePolygonCrossings(
  a: Vec2,
  d: Vec2,
  poly: Vec2[],
  eps = EPS,
): Vec2[] {
  const hits: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p3 = poly[i]!;
    const p4 = poly[(i + 1) % poly.length]!;
    const edge = sub(p4, p3);
    const hit = lineIntersection(a, d, p3, edge, eps);
    if (!hit) continue;
    // 交点必须落在该边线段上
    const tEdge =
      Math.abs(edge[0]) >= Math.abs(edge[1])
        ? (hit.point[0] - p3[0]) / (edge[0] || eps)
        : (hit.point[1] - p3[1]) / (edge[1] || eps);
    if (tEdge < -eps || tEdge > 1 + eps) continue;
    if (!hits.some((q) => samePoint(q, hit.point, eps))) hits.push(clone(hit.point));
  }
  return hits;
}

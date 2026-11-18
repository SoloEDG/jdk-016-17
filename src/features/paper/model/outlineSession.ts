import type {
  Document,
  MigrationReport,
  MigrationResult,
  OutlineSpec,
  Paper,
  Step,
  Vec2,
} from "../../../shared/types";
import { migrateOutline, outlinePolygon } from "../lib/migration";
import { makeSteps } from "../../sequence/lib/steps";

/** 当前纸张的有效外轮廓（缺省即边长 size 的正方形） */
export function effectiveOutline(paper: Paper): OutlineSpec {
  if (paper.outline)
    return {
      ...paper.outline,
      polygon: paper.outline.polygon.map((p) => [...p] as Vec2),
    };
  return {
    kind: "square",
    width: paper.size,
    height: paper.size,
    polygon: [],
    relation: "ratio",
  };
}

export function defaultOutline(kind: OutlineSpec["kind"], base: OutlineSpec): OutlineSpec {
  if (kind === "custom") {
    // 初始给一个内切六边形，用户可在向导中继续拖拽编辑
    const box = polygonBox(outlinePolygon(base));
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    const rx = (box.maxX - box.minX) / 2;
    const rz = (box.maxZ - box.minZ) / 2;
    const hex: Vec2[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      hex.push([cx + rx * Math.cos(a), cz + rz * Math.sin(a)]);
    }
    return { kind, width: base.width, height: base.height, polygon: hex, relation: base.relation };
  }
  return {
    kind,
    width: base.width,
    height: kind === "square" ? base.width : Math.round(base.width * 0.7),
    polygon: [],
    relation: base.relation,
  };
}

function polygonBox(poly: Vec2[]) {
  return {
    minX: Math.min(...poly.map((p) => p[0])),
    maxX: Math.max(...poly.map((p) => p[0])),
    minZ: Math.min(...poly.map((p) => p[1])),
    maxZ: Math.max(...poly.map((p) => p[1])),
  };
}

/* ------------------------------------------------------------------ */
/* 预览：纯函数，绝不触碰当前作品                                        */
/* ------------------------------------------------------------------ */

export function previewMigration(doc: Document, spec: OutlineSpec): MigrationResult {
  return migrateOutline(doc.paper, normalizeSpec(spec));
}

function normalizeSpec(spec: OutlineSpec): OutlineSpec {
  return {
    ...spec,
    polygon: spec.polygon.map((p) => [p[0], p[1]] as Vec2),
  };
}

/* ------------------------------------------------------------------ */
/* 会话快照：打开向导时保存，取消时逐项还原                              */
/* ------------------------------------------------------------------ */

export interface SessionSnapshot {
  paper: Paper;
  selected: string;
  angles: Record<string, number>;
  directions: Record<string, number>;
  steps: Step[];
  step: number;
  view: Document["view"];
}

export function takeSnapshot(doc: Document): SessionSnapshot {
  return {
    paper: doc.paper,
    selected: doc.selected,
    angles: { ...doc.angles },
    directions: { ...doc.directions },
    steps: doc.steps.map((s) => ({ ...s, angles: { ...s.angles } })),
    step: doc.step,
    view: { ...doc.view },
  };
}

/** 取消迁移：选中折痕与相机必须完整回到打开向导之前 */
export function restoreSnapshot(doc: Document, snapshot: SessionSnapshot) {
  doc.paper = snapshot.paper;
  doc.selected = snapshot.selected;
  doc.angles = { ...snapshot.angles };
  doc.directions = { ...snapshot.directions };
  doc.steps = snapshot.steps.map((s) => ({ ...s, angles: { ...s.angles } }));
  doc.step = snapshot.step;
  doc.view = { ...snapshot.view };
  doc.playing = false;
}

/* ------------------------------------------------------------------ */
/* 确认：只在此处覆盖旧作品，并清理所有指向已消失纸面/折痕的引用          */
/* ------------------------------------------------------------------ */

export interface ConfirmOutcome {
  report: MigrationReport;
  /** 确认后被清理掉的角度/步骤引用数量，用于提示“不能迁移的部分” */
  droppedReferences: number;
}

export function confirmMigration(
  doc: Document,
  spec: OutlineSpec,
): ConfirmOutcome | null {
  const result = migrateOutline(doc.paper, normalizeSpec(spec));
  if (!result.paper || !result.report.ok) return null;
  const paper = result.paper;
  const keep = new Set(paper.creases.map((c) => c.id));
  let dropped = 0;

  const angles: Record<string, number> = {};
  for (const [id, value] of Object.entries(doc.angles)) {
    if (keep.has(id)) angles[id] = value;
    else dropped++;
  }
  const directions: Record<string, number> = {};
  for (const [id, value] of Object.entries(doc.directions))
    if (keep.has(id)) directions[id] = value;

  // 步骤重建：平展步保留；折叠步按仍存在的折痕过滤，全部失效的步骤删除
  const steps: Step[] = [doc.steps[0] ?? makeSteps(paper)[0]!];
  for (const s of doc.steps.slice(1)) {
    const filtered = Object.fromEntries(
      Object.entries(s.angles).filter(([id]) => keep.has(id)),
    );
    dropped += Object.keys(s.angles).length - Object.keys(filtered).length;
    if (Object.keys(filtered).length > 0)
      steps.push({ ...s, id: s.id, angles: filtered });
  }
  const fallback = makeSteps(paper);
  for (const c of paper.creases) {
    if (!steps.some((s) => c.id in s.angles)) {
      const target = fallback.find((s) => c.id in s.angles);
      if (target) steps.push({ ...target, angles: { ...target.angles } });
    }
  }

  doc.paper = paper;
  doc.angles = angles;
  doc.directions = directions;
  doc.steps = steps;
  doc.step = Math.min(doc.step, steps.length - 1);
  doc.selected = keep.has(doc.selected)
    ? doc.selected
    : (paper.creases[0]?.id ?? "");
  doc.playing = false;
  return { report: result.report, droppedReferences: dropped };
}

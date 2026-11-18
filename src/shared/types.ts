export type Vec3 = [number, number, number];
/** 纸面平面坐标（纸面始终铺在 y = 0 平面，单位为毫米） */
export type Vec2 = [number, number];
export interface Face {
  id: string;
  points: Vec3[];
  parent?: string;
  hinge?: [Vec3, Vec3];
  crease?: string;
}
export interface Crease {
  id: string;
  name: string;
  description: string;
  face: string;
  target: number;
}
/** 外轮廓形状 */
export type OutlineKind = "square" | "rectangle" | "custom";
/** 折痕与纸边的位置关系：按毫米固定 / 按比例跟随 */
export type EdgeRelation = "metric" | "ratio";
export interface OutlineSpec {
  kind: OutlineKind;
  /** 矩形/方纸宽度，毫米（x 方向） */
  width: number;
  /** 矩形/方纸高度，毫米（z 方向） */
  height: number;
  /** 自定义外轮廓顶点（毫米，纸面平面坐标，逆时针） */
  polygon: Vec2[];
  /** 原折痕距边缘的位置关系 */
  relation: EdgeRelation;
}
export interface Paper {
  id: string;
  name: string;
  subtitle: string;
  /** 正方形边长（毫米）；外轮廓迁移后以 outline 为准 */
  size: number;
  /** 外轮廓描述；缺省视为边长 size 的正方形 */
  outline?: OutlineSpec;
  faces: Face[];
  creases: Crease[];
}
export interface Step {
  id: string;
  title: string;
  note: string;
  angles: Record<string, number>;
  duration: number;
}
export interface View {
  yaw: number;
  pitch: number;
  zoom: number;
  grid: boolean;
  wire: boolean;
}
export interface Document {
  paper: Paper;
  front: string;
  back: string;
  texture: string;
  selected: string;
  angles: Record<string, number>;
  directions: Record<string, number>;
  steps: Step[];
  step: number;
  playing: boolean;
  speed: number;
  view: View;
}
export interface PoseFace {
  id: string;
  points: Vec3[];
  normal: Vec3;
}
/** 迁移检查的阶段 */
export type MigrationStage =
  | "outline"
  | "mapping"
  | "creases"
  | "topology"
  | "kinematics"
  | "references";
export type IssueLevel = "error" | "warning" | "info";
export interface MigrationIssue {
  level: IssueLevel;
  stage: MigrationStage;
  code: string;
  message: string;
  /** 关联的折痕 / 纸面 id */
  refId?: string;
}
/** 单个原纸面的去向，用于在 UI 中展示身份保留情况 */
export interface FaceTrace {
  originId: string;
  /** 迁移后承载该纸面身份的面 id；消失时为空 */
  faceIds: string[];
  status: "kept" | "split" | "vanished";
}
/** 折痕迁移结果 */
export interface CreaseTrace {
  id: string;
  name: string;
  status: "migrated" | "shortened" | "removed";
  message: string;
}
/** 一次外轮廓迁移的完整报告（不包含不可迁移内容以外的产物时不生成 paper） */
export interface MigrationReport {
  issues: MigrationIssue[];
  faceTraces: FaceTrace[];
  creaseTraces: CreaseTrace[];
  /** 迁移后剩余纸面面积占原纸面的比例（0-1） */
  areaRatio: number;
  ok: boolean;
}
export interface MigrationResult {
  /** 整体不可迁移（如纸面全部消失）时为 null，报告仍会列出原因 */
  paper: Paper | null;
  report: MigrationReport;
}

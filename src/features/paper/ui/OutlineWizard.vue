<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  Move,
} from "lucide-vue-next";
import type {
  Document,
  IssueLevel,
  OutlineSpec,
  Vec2,
} from "../../../shared/types";
import {
  confirmMigration,
  defaultOutline,
  effectiveOutline,
  previewMigration,
  restoreSnapshot,
  takeSnapshot,
  type SessionSnapshot,
} from "../model/outlineSession";
import { outlinePolygon } from "../lib/migration";

const props = defineProps<{ doc: Document }>();
const emit = defineEmits<{ close: []; applied: [message: string] }>();

const base = effectiveOutline(props.doc.paper);
const spec = reactive<OutlineSpec>(defaultOutline("square", base));
let snapshot: SessionSnapshot | null = takeSnapshot(props.doc);

const kinds: { id: OutlineSpec["kind"]; label: string; hint: string }[] = [
  { id: "square", label: "方纸", hint: "等宽等高" },
  { id: "rectangle", label: "长方纸", hint: "宽高独立" },
  { id: "custom", label: "自定义外轮廓", hint: "拖拽多边形顶点" },
];

function chooseKind(kind: OutlineSpec["kind"]) {
  const next = defaultOutline(kind, spec);
  spec.kind = next.kind;
  spec.width = next.width;
  spec.height = next.height;
  spec.polygon = next.polygon;
}

watch(
  () => spec.kind,
  (k) => {
    if (k === "square") spec.height = spec.width;
  },
);

const preview = computed(() => previewMigration(props.doc, spec));
const report = computed(() => preview.value.report);
const levelIcon = { error: XCircle, warning: AlertTriangle, info: Info } as const;
const iconFor = (level: IssueLevel) => levelIcon[level];
const stageIcon = (level: IssueLevel | "ok") =>
  levelIcon[level === "ok" ? "info" : level];
const stageLabel: Record<string, string> = {
  outline: "外轮廓",
  mapping: "位置关系",
  creases: "折痕",
  topology: "纸面拓扑",
  kinematics: "连接检查",
  references: "引用清理",
};

const stageStatus = computed(() => {
  const order = ["outline", "mapping", "creases", "topology", "kinematics", "references"];
  return order.map((stage) => {
    const found = report.value.issues.filter((i) => i.stage === stage);
    const level: IssueLevel | "ok" = found.some((i) => i.level === "error")
      ? "error"
      : found.some((i) => i.level === "warning")
        ? "warning"
        : "ok";
    return { stage, level, label: stageLabel[stage]! };
  });
});

const nonMigrated = computed(
  () => report.value.creaseTraces.filter((t) => t.status === "removed").length,
);
const splitCount = computed(
  () => report.value.faceTraces.filter((t) => t.status === "split").length,
);

/* ---------------- 俯视预览投影（毫米 -> SVG） ---------------- */
const VIEW = 240;
function frame(polys: Vec2[][]) {
  const all = polys.flat();
  const xs = all.map((p) => p[0]);
  const zs = all.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxZ - minZ, 1);
  const scale = (VIEW * 2 - 28) / Math.max(w, h);
  const ox = VIEW - ((minX + maxX) / 2) * scale;
  const oz = VIEW - ((minZ + maxZ) / 2) * scale;
  return (p: Vec2) => ({ x: ox + p[0] * scale, y: oz + p[1] * scale, scale });
}
function pathOf(poly: Vec2[], project: (p: Vec2) => { x: number; y: number }) {
  return poly.map((p, i) => `${i === 0 ? "M" : "L"}${project(p).x},${project(p).y}`).join(" ") + " Z";
}

const oldPolys = computed(() =>
  props.doc.paper.faces.map((f) => f.points.map((p) => [p[0], p[2]] as Vec2)),
);
const newPolys = computed(() =>
  preview.value.paper
    ? preview.value.paper.faces.map((f) => f.points.map((p) => [p[0], p[2]] as Vec2))
    : [],
);
const clipPoly = computed(() => outlinePolygon(spec));
const oldProject = computed(() => frame(oldPolys.value));
const newFrame = computed(() =>
  frame([...oldPolys.value, clipPoly.value, ...newPolys.value]),
);
const projectNew = computed(() => newFrame.value);

/* ---------------- 自定义多边形顶点拖拽 ---------------- */
const svgRef = ref<SVGSVGElement>();
let dragging = -1;
function svgPoint(e: PointerEvent): Vec2 {
  const svg = svgRef.value!;
  const rect = svg.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * VIEW * 2;
  const y = ((e.clientY - rect.top) / rect.height) * VIEW * 2;
  const proj = projectNew.value;
  const origin = proj([0, 0]);
  const s = proj([1, 0]).x - origin.x || 1;
  return [(x - origin.x) / s, (y - origin.y) / s];
}
function startDrag(i: number, e: PointerEvent) {
  dragging = i;
  (e.target as Element).setPointerCapture(e.pointerId);
}
function onDrag(e: PointerEvent) {
  if (dragging < 0) return;
  const p = svgPoint(e);
  spec.polygon[dragging] = [Math.round(p[0]), Math.round(p[1])];
}
function endDrag() {
  dragging = -1;
}
function addVertex() {
  const poly = spec.polygon;
  let best = { len: -1, at: 0, point: [0, 0] as Vec2 };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best.len) best = { len: l, at: i + 1, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
  }
  poly.splice(best.at, 0, best.point);
}
function removeVertex(i: number) {
  if (spec.polygon.length <= 3) return;
  spec.polygon.splice(i, 1);
}

function confirm() {
  if (!preview.value.paper || !report.value.ok) return;
  const outcome = confirmMigration(props.doc, spec);
  if (!outcome) return;
  snapshot = null;
  const dropped = outcome.droppedReferences;
  emit(
    "applied",
    dropped > 0
      ? `外轮廓已更换，${dropped} 处指向消失纸面的角度/步骤引用已清理`
      : "外轮廓已更换，折痕身份与连接关系已保留",
  );
}
function cancel() {
  if (snapshot) restoreSnapshot(props.doc, snapshot);
  emit("close");
}
</script>
<template>
  <div class="modal-backdrop" @click.self="cancel">
    <section class="outline-modal">
      <header class="wizard-head">
        <div>
          <div class="eyebrow">PAPER OUTLINE</div>
          <h2>更换外轮廓</h2>
          <p>同一张作品在方纸、长方纸与自定义轮廓之间调整，折痕设计意图保持可追溯。</p>
        </div>
        <button class="close" aria-label="取消并关闭" @click="cancel">×</button>
      </header>

      <div class="wizard-body">
        <div class="wizard-controls">
          <label class="field-label">外轮廓形状</label>
          <div class="kind-tabs">
            <button
              v-for="k in kinds"
              :key="k.id"
              class="kind-tab"
              :class="{ active: spec.kind === k.id }"
              @click="chooseKind(k.id)"
            >
              <b>{{ k.label }}</b><small>{{ k.hint }}</small>
            </button>
          </div>

          <div class="line-label"><label>折痕与纸边的位置关系</label></div>
          <div class="relation-toggle">
            <button
              :class="{ active: spec.relation === 'metric' }"
              @click="spec.relation = 'metric'"
            >
              <b>毫米固定</b
              ><small>折痕距纸边保持原毫米数，不随尺寸缩放</small>
            </button>
            <button
              :class="{ active: spec.relation === 'ratio' }"
              @click="spec.relation = 'ratio'"
            >
              <b>比例跟随</b
              ><small>折痕按相对位置映射，随新轮廓等比变化</small>
            </button>
          </div>

          <template v-if="spec.kind !== 'custom'">
            <div class="dimension-grid">
              <div>
                <label class="field-label">宽度 mm</label>
                <input
                  v-model.number="spec.width"
                  type="number"
                  min="20"
                  max="600"
                  aria-label="外轮廓宽度"
                />
              </div>
              <div>
                <label class="field-label">高度 mm</label>
                <input
                  v-model.number="spec.height"
                  type="number"
                  min="20"
                  max="600"
                  :disabled="spec.kind === 'square'"
                  aria-label="外轮廓高度"
                />
              </div>
            </div>
            <p v-if="spec.kind === 'square'" class="muted small">
              方纸宽高锁定，修改任一边另一边自动跟随。
            </p>
          </template>

          <template v-else>
            <div class="custom-tools">
              <button class="text-button" @click="addVertex">＋ 在最长边上加顶点</button>
              <button
                class="text-button"
                :disabled="spec.polygon.length <= 3"
                @click="removeVertex(spec.polygon.length - 1)"
              >
                － 删除末顶点
              </button>
            </div>
            <p class="muted small">
              <Move :size="12" /> 拖动圆点调整顶点；点击多边形外部区域不会改动作品。
            </p>
            <ol class="vertex-list">
              <li v-for="(p, i) in spec.polygon" :key="i">
                <span>V{{ i + 1 }}</span>
                <input
                  v-model.number="spec.polygon[i][0]"
                  type="number"
                  aria-label="顶点 x"
                /><input
                  v-model.number="spec.polygon[i][1]"
                  type="number"
                  aria-label="顶点 z"
                />
              </li>
            </ol>
          </template>

          <div class="stage-checks">
            <label class="field-label">逐步验证</label>
            <div
              v-for="s in stageStatus"
              :key="s.stage"
              class="stage-row"
              :class="s.level"
            >
              <component :is="stageIcon(s.level)" v-if="s.level !== 'ok'" :size="13" />
              <CheckCircle2 v-else :size="13" />
              <span>{{ s.label }}</span>
              <b>{{ s.level === "ok" ? "通过" : s.level === "error" ? "阻断" : "注意" }}</b>
            </div>
          </div>
        </div>

        <div class="wizard-preview">
          <div class="preview-compare">
            <figure>
              <figcaption>当前作品（只读）</figcaption>
              <svg :viewBox="`0 0 ${VIEW * 2} ${VIEW * 2}`" class="preview-svg">
                <polygon
                  v-for="(p, i) in oldPolys"
                  :key="i"
                  :points="p.map((q) => `${oldProject(q).x},${oldProject(q).y}`).join(' ')"
                  class="old-face"
                />
              </svg>
            </figure>
            <figure>
              <figcaption>迁移预览（未保存）</figcaption>
              <svg
                ref="svgRef"
                :viewBox="`0 0 ${VIEW * 2} ${VIEW * 2}`"
                class="preview-svg"
                @pointermove="onDrag"
                @pointerup="endDrag"
                @pointercancel="endDrag"
              >
                <polygon
                  :points="clipPoly.map((p) => `${projectNew(p).x},${projectNew(p).y}`).join(' ')"
                  class="clip-outline"
                />
                <polygon
                  v-for="(p, i) in newPolys"
                  :key="i"
                  :points="p.map((q) => `${projectNew(q).x},${projectNew(q).y}`).join(' ')"
                  class="new-face"
                />
                <template v-if="spec.kind === 'custom'">
                  <circle
                    v-for="(p, i) in spec.polygon"
                    :key="i"
                    :cx="projectNew(p).x"
                    :cy="projectNew(p).y"
                    r="7"
                    class="vertex-handle"
                    @pointerdown="startDrag(i, $event)"
                  />
                </template>
              </svg>
            </figure>
          </div>

          <div class="report-area">
            <div class="report-summary">
              <span>保留纸面 {{ report.faceTraces.filter((t) => t.status !== 'vanished').length }} / {{ report.faceTraces.length }}</span>
              <span>重新分割 {{ splitCount }}</span>
              <span>保留折痕 {{ report.creaseTraces.filter((t) => t.status !== 'removed').length }} / {{ report.creaseTraces.length }}</span>
              <span>面积保留 {{ (report.areaRatio * 100).toFixed(0) }}%</span>
            </div>
            <ul class="issue-list">
              <li
                v-for="(issue, i) in report.issues"
                :key="i"
                :class="issue.level"
              >
                <component :is="iconFor(issue.level)" :size="13" />
                <span><b>{{ stageLabel[issue.stage] }}</b> · {{ issue.message }}</span>
              </li>
              <li v-if="!report.issues.length" class="ok-empty">
                <CheckCircle2 :size="13" /> 全部检查通过，没有需要迁移取舍的部分。
              </li>
            </ul>
            <ul v-if="nonMigrated" class="non-migrated">
              <li v-for="t in report.creaseTraces.filter((x) => x.status === 'removed')" :key="t.id">
                不可迁移：{{ t.name }} —— {{ t.message }}
              </li>
            </ul>
          </div>
        </div>
      </div>

      <footer class="wizard-foot">
        <p class="muted small">
          确认前仅生成预览，不会覆盖当前作品；取消后选中折痕与相机视角都会还原。
        </p>
        <div>
          <button class="ghost" @click="cancel">取消</button>
          <button
            class="primary"
            :disabled="!preview.paper || !report.ok"
            @click="confirm"
          >
            确认更换外轮廓
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { Document } from "../../../shared/types";
import { papers, swatches } from "../lib/presets";
import { setMaterial } from "../model/paper";
import { effectiveOutline } from "../model/outlineSession";
defineProps<{ doc: Document }>();
defineEmits<{ paper: [id: string]; outline: [] }>();
function dimensionText(doc: Document) {
  const o = effectiveOutline(doc.paper);
  if (o.kind === "custom") return `自定义 · ${o.polygon.length} 边形`;
  return `${o.width} × ${o.height} mm`;
}
</script>
<template>
  <section class="panel">
    <div class="section-heading">
      <span>01 / 纸张</span><small>PAPER</small>
    </div>
    <label class="field-label">折纸模型</label
    ><button
      v-for="(p, i) in papers"
      :key="p.id"
      class="model-card"
      :class="{ active: doc.paper.id === p.id }"
      @click="$emit('paper', p.id)"
    >
      <span class="mini-paper" :class="{ green: i === 1 }">◇</span
      ><span
        ><b>{{ p.name }}</b
        ><small>{{ p.subtitle }}</small></span
      ><span class="radio-dot"></span>
    </button>
    <div class="line-label"><label>纸张颜色</label><span>双面配色</span></div>
    <div class="swatches">
      <button
        v-for="s in swatches"
        :key="s.name"
        :title="s.name"
        :aria-label="s.name"
        :style="{ background: s.front }"
        :class="{ chosen: doc.front === s.front }"
        @click="setMaterial(doc, s.front, s.back)"
      ></button>
    </div>
    <label class="field-label">表面纹理</label
    ><select v-model="doc.texture" aria-label="表面纹理">
      <option value="fiber">手工纤维纸</option>
      <option value="dots">细点纹理</option>
      <option value="plain">纯色纸</option>
    </select>
    <button class="outline-entry" @click="$emit('outline')">
      <span class="outline-icon">▱</span>
      <span><b>更换外轮廓</b><small>方纸 / 长方纸 / 自定义，保留折痕设计</small></span>
      <span class="entry-arrow">↗</span>
    </button>
    <div class="paper-info">
      <span>纸张轮廓</span><b>{{ dimensionText(doc) }}</b>
    </div>
  </section>
</template>

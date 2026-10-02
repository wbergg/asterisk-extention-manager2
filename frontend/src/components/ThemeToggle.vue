<script setup lang="ts">
import { setTheme, theme, type Theme } from "../theme";

const options: readonly Theme[] = ["dark", "light"];

/** Selected reads as a raised chip on the track, in both palettes. */
const segCls = (t: Theme) =>
  theme.value === t
    ? "bg-panel-950 text-ink-100"
    : "text-ink-500 hover:text-ink-300";
</script>

<template>
  <div
    class="flex items-center gap-0.5 rounded-sm border border-panel-600 bg-panel-800 p-0.5"
    role="group"
    aria-label="Colour theme"
  >
    <button
      v-for="opt in options"
      :key="opt"
      type="button"
      class="flex-1 rounded-sm px-2 py-1 text-[11px] capitalize transition-colors"
      :class="segCls(opt)"
      :aria-pressed="theme === opt"
      @click="setTheme(opt)"
    >
      {{ opt }}
    </button>
  </div>
</template>

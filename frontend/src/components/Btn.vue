<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    variant?: "primary" | "ghost" | "danger";
    size?: "sm" | "md";
    disabled?: boolean;
    busy?: boolean;
  }>(),
  { variant: "ghost", size: "sm", disabled: false, busy: false },
);

const cls = computed(() => {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-sm border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  const size =
    props.size === "md" ? "px-3.5 py-2 text-sm" : "px-2.5 py-1 text-xs";
  const variant = {
    primary:
      "border-accent-400/40 bg-accent-900 text-accent-400 hover:bg-accent-400/15 hover:border-accent-400/70",
    ghost:
      "border-panel-600 bg-panel-800 text-ink-300 hover:bg-panel-700 hover:text-ink-100",
    danger:
      "border-bad-400/30 bg-bad-900 text-bad-400 hover:bg-bad-400/15 hover:border-bad-400/60",
  }[props.variant];
  return `${base} ${size} ${variant}`;
});
</script>

<template>
  <button :class="cls" :disabled="disabled || busy" type="button">
    <span
      v-if="busy"
      class="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"
      aria-hidden="true"
    />
    <slot />
  </button>
</template>

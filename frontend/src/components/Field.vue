<script setup lang="ts">
defineProps<{ label: string; hint?: string; mono?: boolean }>();
const model = defineModel<string | number | null>();
</script>

<template>
  <label class="block">
    <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
      {{ label }}
    </span>
    <input
      v-model="model"
      v-bind="$attrs"
      class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 transition-colors placeholder:text-ink-500/60 focus:border-accent-400/60"
      :class="mono ? 'ident' : ''"
    />
    <span v-if="hint" class="mt-1 block text-[11px] text-ink-500">{{ hint }}</span>
  </label>
</template>

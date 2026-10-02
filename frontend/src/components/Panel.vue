<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
  <section class="border border-panel-700 bg-panel-900">
    <header
      class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-panel-700 bg-panel-850 px-4 py-2.5"
    >
      <div class="flex items-baseline gap-3">
        <h2 class="text-[13px] font-semibold tracking-wide text-ink-100 uppercase">
          {{ title }}
        </h2>
        <p v-if="subtitle" class="text-xs text-ink-500">{{ subtitle }}</p>
      </div>
      <div class="flex items-center gap-2"><slot name="actions" /></div>
    </header>
    <slot />
  </section>
</template>

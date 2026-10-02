<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";

const props = defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div
    class="scrim fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[8vh] backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div
      class="elev-hi w-full border border-panel-600 bg-panel-900"
      :class="props.wide ? 'max-w-3xl' : 'max-w-lg'"
      role="dialog"
      aria-modal="true"
    >
      <header
        class="flex items-center justify-between border-b border-panel-700 bg-panel-850 px-4 py-2.5"
      >
        <h2 class="text-[13px] font-semibold tracking-wide uppercase">
          {{ title }}
        </h2>
        <button
          class="text-ink-500 transition-colors hover:text-ink-100"
          aria-label="Close"
          @click="emit('close')"
        >
          ✕
        </button>
      </header>
      <div class="px-4 py-4"><slot /></div>
      <footer
        v-if="$slots.footer"
        class="flex justify-end gap-2 border-t border-panel-700 bg-panel-850 px-4 py-3"
      >
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

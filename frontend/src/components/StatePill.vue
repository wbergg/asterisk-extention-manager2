<script setup lang="ts">
import { computed } from "vue";

import type { Pbx } from "../api";

const props = defineProps<{
  state: Pbx["state"];
  /** Whether a socket is up right now, if known. */
  live?: boolean;
}>();

/**
 * `state` is the verdict of the last reconcile, not connectivity — a PBX that
 * converged and then went offline still reads "converged". The live dot is
 * what distinguishes the two, so it is deliberately a separate signal rather
 * than folded into the colour.
 */
const look = computed(() => {
  switch (props.state) {
    case "converged":
      return { label: "converged", cls: "bg-ok-900 text-ok-400 border-ok-400/25" };
    case "syncing":
      return {
        label: "syncing",
        cls: "bg-accent-900 text-accent-400 border-accent-400/25",
      };
    case "connecting":
      return {
        label: "connecting",
        cls: "bg-accent-900 text-accent-400 border-accent-400/25",
      };
    case "degraded":
      return {
        label: "degraded",
        cls: "bg-warn-900 text-warn-400 border-warn-400/25",
      };
    case "blocked":
      return { label: "blocked", cls: "bg-bad-900 text-bad-400 border-bad-400/25" };
    default:
      return {
        label: "never connected",
        cls: "bg-idle-900 text-idle-400 border-idle-400/25",
      };
  }
});
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase"
    :class="look.cls"
  >
    <span
      v-if="live !== undefined"
      class="h-1.5 w-1.5 rounded-full"
      :class="live ? 'bg-current live-dot' : 'bg-current opacity-30'"
      :title="live ? 'socket connected' : 'no socket'"
    />
    {{ look.label }}
  </span>
</template>

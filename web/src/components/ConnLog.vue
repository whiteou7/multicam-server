<script setup lang="ts">
import { computed } from "vue";
import { logLines } from "../log";

const newestFirst = computed(() => [...logLines.value].reverse().join("\n"));
</script>

<template>
  <details>
    <summary>Nhật ký kết nối ({{ logLines.length }})</summary>
    <pre class="log">{{ newestFirst }}</pre>
  </details>
</template>

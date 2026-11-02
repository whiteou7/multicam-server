<script setup lang="ts">
import { session } from "./api";
import Dashboard from "./components/Dashboard.vue";
import LoginForm from "./components/LoginForm.vue";
</script>

<template>
  <Dashboard v-if="session.tokens" />
  <LoginForm v-else />
</template>

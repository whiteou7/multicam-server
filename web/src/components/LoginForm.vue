<script setup lang="ts">
import { ref } from "vue";
import { deviceId, errText, login } from "../api";

const phone = ref("");
const password = ref("");
const msg = ref("");
const busy = ref(false);

async function submit() {
  busy.value = true;
  msg.value = "Đang đăng nhập...";
  try {
    await login(phone.value.trim(), password.value);
  } catch (e) {
    msg.value = errText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="narrow">
    <h1>Multi-Cam Dashboard</h1>
    <form class="stack" @submit.prevent="submit">
      <label>
        Số điện thoại
        <input v-model="phone" autocomplete="username" inputmode="tel" required />
      </label>
      <label>
        Mật khẩu
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>
      <div class="row">
        <button class="primary" :disabled="busy">Đăng nhập</button>
        <span class="muted">{{ msg }}</span>
      </div>
      <p class="muted">Thiết bị: <span class="mono">{{ deviceId }}</span></p>
    </form>
  </main>
</template>

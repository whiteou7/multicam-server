<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, errText } from "../api";

interface Video {
  id: string;
  name: string | null;
  camera_name: string | null;
  created_at: string;
  size: number;
}

const videos = ref<Video[]>([]);
const error = ref("");
const playing = ref("");

async function load() {
  error.value = "";
  try {
    videos.value = (await api("/videos?index=0&count=20")).videos ?? [];
  } catch (e) {
    error.value = errText(e);
  }
}

async function play(id: string) {
  try {
    playing.value = (await api(`/videos/${id}`)).url;
  } catch (e) {
    error.value = errText(e);
  }
}

async function download(id: string) {
  try {
    window.open((await api(`/videos/${id}/download`)).download_url, "_blank");
  } catch (e) {
    error.value = errText(e);
  }
}

onMounted(load);
</script>

<template>
  <section>
    <h2>
      Video trên server
      <button class="small" @click="load">Tải lại</button>
    </h2>
    <p v-if="error" class="bad">{{ error }}</p>
    <div class="scroll">
      <table v-if="videos.length">
        <thead>
          <tr><th>Tên</th><th>Camera</th><th>Thời gian</th><th>Dung lượng</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="v in videos" :key="v.id">
            <td>{{ v.name || v.id.slice(0, 8) }}</td>
            <td>{{ v.camera_name }}</td>
            <td>{{ new Date(v.created_at).toLocaleString() }}</td>
            <td>{{ (v.size / 1024 / 1024).toFixed(1) }} MB</td>
            <td class="actions">
              <button class="small" @click="play(v.id)">Xem</button>
              <button class="small" @click="download(v.id)">Tải</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">Chưa có video.</p>
    </div>
    <video v-if="playing" :src="playing" class="player" controls autoplay />
  </section>
</template>

<script setup lang="ts">
import { reactive } from "vue";
import { logout, session } from "../api";
import { usePreview } from "../usePreview";
import { useRoom } from "../useRoom";
import ConnLog from "./ConnLog.vue";
import MembersPanel from "./MembersPanel.vue";
import PreviewPanel from "./PreviewPanel.vue";
import RoomPanel from "./RoomPanel.vue";
import VideoPanel from "./VideoPanel.vue";

const roomApi = useRoom();
const room = reactive(roomApi);
const preview = usePreview(roomApi.roomId);
</script>

<template>
  <header>
    <strong>Multi-Cam Dashboard</strong>
    <span class="spacer" />
    <span class="muted">{{ session.who?.phone }} · {{ session.who?.role }}</span>
    <button @click="logout">Đăng xuất</button>
  </header>
  <main>
    <RoomPanel :room="room" />
    <MembersPanel :room="room" :snap="preview.snap.value" />
    <PreviewPanel :snap="preview.snap.value" :enabled="!!room.roomId" @start="preview.start" @stop="preview.stop" />
    <VideoPanel />
    <ConnLog />
  </main>
</template>

<script setup lang="ts">
import type { Room } from "../useRoom";

defineProps<{ room: Room }>();
</script>

<template>
  <section>
    <h2>Phòng</h2>
    <div class="row">
      <button class="primary" @click="room.createRoom">Tạo phòng</button>
      <button :disabled="!room.roomId" @click="room.refreshCode">Mã mời mới</button>
      <button class="danger" :disabled="!room.roomId" @click="room.closeRoom">Đóng phòng</button>
    </div>
    <p v-if="room.roomId" class="muted">
      room_id <span class="mono">{{ room.roomId }}</span> · mã mời <strong class="mono code">{{ room.inviteCode }}</strong>
    </p>
    <p v-else class="muted">Chưa chọn phòng. Tạo phòng mới hoặc dùng một phòng bên dưới.</p>
    <p v-if="room.roomNotice" class="bad">{{ room.roomNotice }}</p>

    <h3>
      Phòng của tôi
      <button class="small" @click="room.loadMyRooms">Làm mới</button>
    </h3>
    <div class="scroll">
      <table v-if="room.myRooms.length">
        <thead>
          <tr><th>Tên</th><th>Mã mời</th><th>Thành viên</th><th>Tham gia</th><th>Trạng thái</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="r in room.myRooms" :key="r.room_id">
            <td>{{ r.room_name || r.room_id.slice(0, 8) }}</td>
            <td class="mono">{{ r.invite_code }}</td>
            <td>{{ r.member_count ?? 0 }}/{{ r.max_members ?? "?" }}</td>
            <td>{{ r.open_for_join ? "mở" : "chỉ mã mời" }}</td>
            <td>{{ r.status }}</td>
            <td class="actions">
              <span v-if="r.room_id === room.roomId" class="muted">đang dùng</span>
              <template v-else>
                <button v-if="r.status === 'open'" class="small" @click="room.select(r.room_id, r.invite_code)">Dùng</button>
                <button class="small danger" @click="room.deleteRoom(r.room_id)">Xóa</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">Chưa có phòng nào.</p>
    </div>
  </section>
</template>

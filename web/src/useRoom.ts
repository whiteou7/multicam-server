import { onScopeDispose, ref, type UnwrapNestedRefs } from "vue";
import { api, errText } from "./api";
import { log } from "./log";

const SYNC_MS = 4000;

export interface Member {
  member_id: string;
  device_id: string;
  camera_name: string | null;
  device_name: string | null;
  device_model: string | null;
  device_short_id: string | null;
  is_online: number;
  recording_state: string;
  upload_state: string | null;
  upload_percent: number | null;
}

export interface RoomRow {
  room_id: string;
  room_name: string | null;
  invite_code: string;
  member_count: number;
  max_members: number;
  open_for_join: number;
  status: string;
}

export type Room = UnwrapNestedRefs<ReturnType<typeof useRoom>>;

export function useRoom() {
  const roomId = ref<string | null>(null);
  const inviteCode = ref("");
  const members = ref<Member[]>([]);
  const revision = ref(0);
  const myRooms = ref<RoomRow[]>([]);
  const roomNotice = ref("");
  const recNotice = ref("");

  let syncGen = 0;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;

  function stopSync(): void {
    syncGen++;
    clearTimeout(syncTimer);
  }

  function startSync(): void {
    stopSync();
    const gen = syncGen;
    const id = roomId.value;
    let since = 0;
    const tick = async () => {
      try {
        const d = await api(`/rooms/${id}/sync?since=${since}`);
        if (gen !== syncGen) return;
        since = d.revision;
        revision.value = d.revision;
        members.value = d.members ?? [];
      } catch (e) {
        if (gen !== syncGen) return;
        log(`sync: ${errText(e)}`);
      }
      syncTimer = setTimeout(tick, SYNC_MS);
    };
    void tick();
  }

  function select(id: string, code: string): void {
    roomId.value = id;
    inviteCode.value = code;
    members.value = [];
    revision.value = 0;
    startSync();
  }

  function leave(): void {
    stopSync();
    roomId.value = null;
    inviteCode.value = "";
    members.value = [];
  }

  async function run(notice: { value: string }, fn: () => Promise<void>): Promise<void> {
    notice.value = "";
    try {
      await fn();
    } catch (e) {
      notice.value = errText(e);
      log(`lỗi: ${notice.value}`);
    }
  }

  async function loadMyRooms(): Promise<void> {
    await run(roomNotice, async () => {
      myRooms.value = (await api("/rooms/mine")).rooms ?? [];
    });
  }

  async function createRoom(): Promise<void> {
    await run(roomNotice, async () => {
      const r = await api("/rooms", { method: "POST", body: { max_members: 8, auto_approve: 1, open_for_join: 1 } });
      log(`createRoom ${r.room_id} ${r.invite_code}`);
      select(r.room_id, r.invite_code);
      await loadMyRooms();
    });
  }

  async function refreshCode(): Promise<void> {
    await run(roomNotice, async () => {
      inviteCode.value = (await api(`/rooms/${roomId.value}/invite-code`, { method: "POST" })).invite_code;
    });
  }

  async function removeRoom(id: string): Promise<void> {
    await run(roomNotice, async () => {
      await api(`/rooms/${id}`, { method: "DELETE" });
      log(`deleted room ${id.slice(0, 8)}`);
      if (roomId.value === id) leave();
      await loadMyRooms();
    });
  }

  function closeRoom(): Promise<void> {
    return removeRoom(roomId.value!);
  }

  function deleteRoom(id: string): Promise<void> {
    if (!confirm("Xóa hẳn phòng này?")) return Promise.resolve();
    return removeRoom(id);
  }

  const nameOf = (memberId: string) =>
    members.value.find((m) => m.member_id === memberId)?.camera_name ?? memberId.slice(0, 6);

  async function startRecording(): Promise<void> {
    await run(recNotice, async () => {
      const r = await api(`/rooms/${roomId.value}/recording/start`, {
        method: "POST",
        body: { target: "all", client_command_id: "cmd_" + Date.now() },
      });
      const rejected: { member_id: string; reason: string }[] = r.rejected ?? [];
      recNotice.value =
        `Đã gửi lệnh ghi tới ${(r.targets ?? []).length} máy` +
        (r.already_active ? " (phiên đang chạy, lệnh được gửi lại)" : "") +
        (rejected.length ? `. Bị loại: ${rejected.map((x) => `${nameOf(x.member_id)}: ${x.reason}`).join(", ")}` : "");
      log(`start recording session=${(r.session_id ?? "").slice(0, 8)}`);
    });
  }

  async function stopRecording(): Promise<void> {
    await run(recNotice, async () => {
      const r = await api(`/rooms/${roomId.value}/recording/stop`, {
        method: "POST",
        body: { target: "all", client_command_id: "cmd_" + Date.now() },
      });
      recNotice.value = `Đã gửi lệnh dừng tới ${(r.results ?? []).length} máy. Chờ phone lưu và tải video lên.`;
      log(`stop recording session=${(r.session_id ?? "").slice(0, 8)}`);
    });
  }

  async function flash(memberId: string): Promise<void> {
    await run(recNotice, async () => {
      await api(`/rooms/${roomId.value}/members/${memberId}/camera`, {
        method: "PUT",
        body: { flash_mode: "auto", zoom_factor: 2.0, client_command_id: "cam_" + Date.now() },
      });
      log(`setCamera ${memberId}`);
    });
  }

  onScopeDispose(stopSync);
  void loadMyRooms();

  return {
    roomId, inviteCode, members, revision, myRooms, roomNotice, recNotice,
    select, loadMyRooms, createRoom, refreshCode, closeRoom, deleteRoom,
    startRecording, stopRecording, flash,
  };
}

import * as mediasoup from "mediasoup";
import type { WebSocket } from "@fastify/websocket";

// All of this is in-process, in-memory state, same tradeoff as the rest of
// this codebase's SQLite storage (see README "Known simplifications" —
// single instance only, doesn't survive a restart or scale horizontally).

export interface MemberMedia {
  memberId: string;
  socket: WebSocket;
  transports: Map<string, mediasoup.types.WebRtcTransport>;
  producers: Map<string, mediasoup.types.Producer>;
  consumers: Map<string, mediasoup.types.Consumer>;
}

export interface RoomMedia {
  router: mediasoup.types.Router;
  members: Map<string, MemberMedia>; // keyed by member_id
}

const rooms = new Map<string, RoomMedia>();

export const mediaState = {
  getRoom(roomId: string): RoomMedia | undefined {
    return rooms.get(roomId);
  },

  setRoom(roomId: string, room: RoomMedia): void {
    rooms.set(roomId, room);
  },

  deleteRoom(roomId: string): void {
    rooms.delete(roomId);
  },

  listOtherMembers(roomId: string, exceptMemberId: string): MemberMedia[] {
    const room = rooms.get(roomId);
    if (!room) return [];
    return [...room.members.values()].filter((m) => m.memberId !== exceptMemberId);
  },
};

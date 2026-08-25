import { FastifyInstance } from "fastify";
import * as mediasoup from "mediasoup";
import { MEDIA_CODECS } from "../../plugins/mediasoup";
import { env } from "../../config/env";
import { mediaState, MemberMedia, RoomMedia } from "./media.state";

export async function getOrCreateRoomMedia(app: FastifyInstance, roomId: string): Promise<RoomMedia> {
  const existing = mediaState.getRoom(roomId);
  if (existing) return existing;

  const worker = app.mediasoup.getWorker();
  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  const room: RoomMedia = { router, members: new Map() };
  mediaState.setRoom(roomId, room);
  return room;
}

export function registerMember(room: RoomMedia, memberId: string, socket: MemberMedia["socket"]): MemberMedia {
  const existing = room.members.get(memberId);
  if (existing) {
    closeMember(existing);
  }
  const member: MemberMedia = {
    memberId,
    socket,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  };
  room.members.set(memberId, member);
  return member;
}

export async function createWebRtcTransport(
  router: mediasoup.types.Router
): Promise<mediasoup.types.WebRtcTransport> {
  return router.createWebRtcTransport({
    listenIps: [{ ip: env.mediasoup.listenIp, announcedIp: env.mediasoup.announcedIp ?? undefined }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });
}

function closeMember(member: MemberMedia): void {
  for (const transport of member.transports.values()) transport.close();
  member.transports.clear();
  member.producers.clear();
  member.consumers.clear();
}

// Called when a Remote/Controller leaves a room (leave, kick, or socket
// close) — tears down its transports and tells every other member in the
// room that its producers are gone so grid tiles can drop the feed.
export function closeMemberMedia(roomId: string, memberId: string): void {
  const room = mediaState.getRoom(roomId);
  if (!room) return;
  const member = room.members.get(memberId);
  if (!member) return;

  const producerIds = [...member.producers.keys()];
  closeMember(member);
  room.members.delete(memberId);
  if (member.socket.readyState === member.socket.OPEN) member.socket.close();

  for (const other of room.members.values()) {
    for (const producerId of producerIds) {
      sendToSocket(other.socket, { type: "producer-closed", member_id: memberId, producer_id: producerId });
    }
  }
}

// Called when a room closes entirely — tears down its Router (which
// transitively closes every transport/producer/consumer still open on it).
export function closeRoomMedia(roomId: string): void {
  const room = mediaState.getRoom(roomId);
  if (!room) return;
  for (const memberId of [...room.members.keys()]) {
    closeMemberMedia(roomId, memberId);
  }
  room.router.close();
  mediaState.deleteRoom(roomId);
}

export function sendToSocket(socket: MemberMedia["socket"], payload: Record<string, unknown>): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export function broadcastToOthers(
  roomId: string,
  exceptMemberId: string,
  payload: Record<string, unknown>
): void {
  for (const member of mediaState.listOtherMembers(roomId, exceptMemberId)) {
    sendToSocket(member.socket, payload);
  }
}

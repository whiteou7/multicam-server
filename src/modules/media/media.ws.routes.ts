import { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { authenticate } from "../../middleware/authenticate";
import { roomsRepo } from "../../db/repositories/rooms.repo";
import { roomMembersRepo } from "../../db/repositories/room-members.repo";
import {
  broadcastToOthers,
  closeMemberMedia,
  createWebRtcTransport,
  getOrCreateRoomMedia,
  registerMember,
  sendToSocket,
} from "./media.service";
import { MemberMedia } from "./media.state";

const CONTROLLER_PARTICIPANT_ID = "controller";

type Role = "controller" | "remote";

function send(socket: WebSocket, payload: Record<string, unknown>): void {
  sendToSocket(socket, payload);
}

function sendError(socket: WebSocket, message: string, requestId?: unknown): void {
  send(socket, { type: "error", message, request_id: requestId ?? null });
}

// Minimal mediasoup signaling: SDP/ICE never travels over this codebase's
// REST+polling transport (see rooms.service.getPreviewToken), so this socket
// carries create-transport/connect-transport/produce/consume instead. Once a
// transport is connected, actual RTP media flows device <-> mediasoup
// directly over UDP — this channel only ever carries JSON control messages.
export default async function mediaWsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { room_id: string } }>(
    "/rooms/:room_id/media",
    { websocket: true, preHandler: authenticate },
    async (socket, request) => {
      const room = roomsRepo.findById(request.params.room_id);
      if (!room || room.status !== "open") {
        sendError(socket, "room not found or closed");
        socket.close();
        return;
      }

      const auth = request.auth!;
      let role: Role;
      let participantId: string;

      // Controller chỉ cần userId khớp owner_id (không bắt deviceId, vì cùng user có thể có nhiều device web/app)
      if (auth.userId === room.owner_id) {
        role = "controller";
        participantId = CONTROLLER_PARTICIPANT_ID;
      } else {
        const member = roomMembersRepo.findActiveByRoomAndDevice(room.id, auth.deviceId);
        if (!member || member.user_id !== auth.userId) {
          sendError(socket, "not an active member of this room");
          socket.close();
          return;
        }
        role = "remote";
        participantId = member.id;
      }

      const roomMedia = await getOrCreateRoomMedia(app, room.id);
      const member: MemberMedia = registerMember(roomMedia, participantId, socket);

      send(socket, {
        type: "welcome",
        participant_id: participantId,
        role,
        rtp_capabilities: roomMedia.router.rtpCapabilities,
      });

      socket.on("message", async (raw: Buffer) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          sendError(socket, "invalid JSON");
          return;
        }

        try {
          switch (msg.type) {
            case "create-transport": {
              const direction = msg.direction;
              if (role === "remote" && direction !== "send") {
                throw new Error("a remote may only open a send transport");
              }
              if (role === "controller" && direction !== "recv") {
                throw new Error("the controller may only open recv transports");
              }
              const transport = await createWebRtcTransport(roomMedia.router);
              member.transports.set(transport.id, transport);
              transport.on("dtlsstatechange", (state) => {
                if (state === "closed") transport.close();
              });
              send(socket, {
                type: "transport-created",
                request_id: msg.request_id ?? null,
                direction,
                transport_id: transport.id,
                ice_parameters: transport.iceParameters,
                ice_candidates: transport.iceCandidates,
                dtls_parameters: transport.dtlsParameters,
              });
              break;
            }

            case "connect-transport": {
              const transport = member.transports.get(msg.transport_id);
              if (!transport) throw new Error("unknown transport_id");
              await transport.connect({ dtlsParameters: msg.dtls_parameters });
              send(socket, {
                type: "transport-connected",
                request_id: msg.request_id ?? null,
                transport_id: transport.id,
              });
              break;
            }

            case "produce": {
              if (role !== "remote") throw new Error("only a remote may produce");
              const transport = member.transports.get(msg.transport_id);
              if (!transport) throw new Error("unknown transport_id");
              const producer = await transport.produce({
                kind: msg.kind,
                rtpParameters: msg.rtp_parameters,
              });
              member.producers.set(producer.id, producer);
              producer.on("transportclose", () => member.producers.delete(producer.id));
              send(socket, {
                type: "produced",
                request_id: msg.request_id ?? null,
                producer_id: producer.id,
              });
              broadcastToOthers(room.id, participantId, {
                type: "new-producer",
                member_id: participantId,
                producer_id: producer.id,
                kind: producer.kind,
              });
              break;
            }

            case "consume": {
              if (role !== "controller") throw new Error("only the controller may consume");
              if (!roomMedia.router.canConsume({ producerId: msg.producer_id, rtpCapabilities: msg.rtp_capabilities })) {
                throw new Error("cannot consume this producer with the given rtp_capabilities");
              }
              const transport = member.transports.get(msg.transport_id);
              if (!transport) throw new Error("unknown transport_id");
              const consumer = await transport.consume({
                producerId: msg.producer_id,
                rtpCapabilities: msg.rtp_capabilities,
                paused: true, // resumed explicitly once the client's <video> is ready
              });
              member.consumers.set(consumer.id, consumer);
              consumer.on("transportclose", () => member.consumers.delete(consumer.id));
              consumer.on("producerclose", () => {
                member.consumers.delete(consumer.id);
                send(socket, { type: "producer-closed", producer_id: msg.producer_id });
              });
              send(socket, {
                type: "consumed",
                request_id: msg.request_id ?? null,
                consumer_id: consumer.id,
                producer_id: consumer.producerId,
                kind: consumer.kind,
                rtp_parameters: consumer.rtpParameters,
              });
              break;
            }

            case "resume-consumer": {
              const consumer = member.consumers.get(msg.consumer_id);
              if (!consumer) throw new Error("unknown consumer_id");
              await consumer.resume();
              send(socket, { type: "consumer-resumed", request_id: msg.request_id ?? null, consumer_id: consumer.id });
              break;
            }

            case "get-producers": {
              if (role !== "controller") throw new Error("only the controller may list producers");
              const list = [...roomMedia.members.entries()]
                .filter(([id]) => id !== participantId)
                .flatMap(([memberId, m]) =>
                  [...m.producers.values()].map((p) => ({ member_id: memberId, producer_id: p.id, kind: p.kind }))
                );
              send(socket, { type: "producers", request_id: msg.request_id ?? null, producers: list });
              break;
            }

            default:
              sendError(socket, `unknown message type: ${msg.type}`, msg.request_id);
          }
        } catch (err) {
          sendError(socket, err instanceof Error ? err.message : "unknown error", msg?.request_id);
        }
      });

      socket.on("close", () => closeMemberMedia(room.id, participantId));
      socket.on("error", (err: Error) => request.log.error(err, "media ws error"));
    }
  );
}

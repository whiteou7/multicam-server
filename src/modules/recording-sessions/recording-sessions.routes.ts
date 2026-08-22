import { FastifyInstance } from "fastify";
import { recordingSessionsRepo } from "../../db/repositories/recording-sessions.repo";
import { roomMembersRepo } from "../../db/repositories/room-members.repo";
import { roomsRepo } from "../../db/repositories/rooms.repo";
import { videosRepo } from "../../db/repositories/videos.repo";
import { authenticate } from "../../middleware/authenticate";
import { ApiError, CODE } from "../../utils/codes";
import { ok } from "../../utils/response";

export default async function recordingSessionsRoutes(app: FastifyInstance): Promise<void> {
  // get_recording_session — spec § 2.9. Viewable by the room's owner or by
  // any account that has (or had) a membership in that room.
  app.get<{ Params: { session_id: string } }>(
    "/recording-sessions/:session_id",
    { preHandler: authenticate },
    async (request) => {
      const session = recordingSessionsRepo.findById(request.params.session_id);
      if (!session) throw new ApiError(CODE.NOT_EXISTED);
      const room = roomsRepo.findById(session.room_id);
      if (!room) throw new ApiError(CODE.NOT_EXISTED);

      const isOwner = room.owner_id === request.auth!.userId;
      const isParticipant = !!roomMembersRepo.findAnyByRoomAndUser(room.id, request.auth!.userId);
      if (!isOwner && !isParticipant) {
        throw new ApiError(CODE.NOT_ACCESS);
      }

      const members = roomMembersRepo.listAllByRoom(room.id).map((m) => {
        const video = videosRepo.findByDeviceAndSession(m.device_id, session.id);
        return {
          member_id: m.id,
          camera_name: m.camera_name,
          state: m.recording_state,
          duration: video?.duration_ms ?? m.elapsed_ms ?? null,
          video_id: video?.id ?? null,
          uploaded: video ? 1 : 0,
        };
      });

      return ok({
        session_id: session.id,
        room_id: session.room_id,
        started_at: session.started_at,
        stopped_at: session.stopped_at,
        status: session.status,
        members,
      });
    }
  );
}

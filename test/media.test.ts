import { test } from "node:test";
import assert from "node:assert/strict";
import type { RoomMedia } from "../src/modules/media/media.state";

function fakeSocket() {
  const closed: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
      socket.readyState = 3;
    },
    send() {},
  };
  return { socket: socket as any, closed };
}

async function setup() {
  const service = await import("../src/modules/media/media.service");
  const { mediaState } = await import("../src/modules/media/media.state");
  const room: RoomMedia = { router: {} as any, members: new Map() };
  mediaState.setRoom("room-1", room);
  const transport = () => {
    const t = { closed: false, close: () => (t.closed = true) };
    return t;
  };
  return { service, room, transport };
}

test("late close of a replaced socket leaves the new member intact", async () => {
  const { service, room, transport } = await setup();
  const oldSock = fakeSocket();
  const newSock = fakeSocket();
  service.registerMember(room, "m1", oldSock.socket);
  const fresh = service.registerMember(room, "m1", newSock.socket);
  const t = transport();
  fresh.transports.set("t1", t as any);

  service.closeMemberMedia("room-1", "m1", oldSock.socket);

  assert.equal(room.members.get("m1"), fresh);
  assert.equal(t.closed, false);
  assert.equal(newSock.closed.length, 0);
});

test("close of the current socket tears the member down", async () => {
  const { service, room, transport } = await setup();
  const sock = fakeSocket();
  const member = service.registerMember(room, "m1", sock.socket);
  const t = transport();
  member.transports.set("t1", t as any);

  service.closeMemberMedia("room-1", "m1", sock.socket);

  assert.equal(room.members.has("m1"), false);
  assert.equal(t.closed, true);
});

test("a replaced socket is closed with 4001 and its transports are closed", async () => {
  const { service, room, transport } = await setup();
  const oldSock = fakeSocket();
  const old = service.registerMember(room, "m1", oldSock.socket);
  const t = transport();
  old.transports.set("t1", t as any);

  service.registerMember(room, "m1", fakeSocket().socket);

  assert.deepEqual(oldSock.closed, [{ code: 4001, reason: "replaced" }]);
  assert.equal(t.closed, true);
});

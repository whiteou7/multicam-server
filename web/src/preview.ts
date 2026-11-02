import { Device, types } from "mediasoup-client";

export type PreviewState = "idle" | "connecting" | "live" | "reconnecting" | "failed";
export type Health = "live" | "stalled" | "lost";

export interface Label {
  camera_name: string | null;
  device_name: string | null;
  device_model: string | null;
  device_short_id: string | null;
}

export interface TileInfo extends Label {
  memberId: string;
  producerId: string;
  stream: MediaStream;
  iceState: string;
  stalled: boolean;
}

export interface PreviewSnapshot {
  state: PreviewState;
  error: string | null;
  tiles: TileInfo[];
}

export interface PreviewDeps {
  roomId: string;
  api: (path: string, init?: { method?: string; body?: unknown }) => Promise<any>;
  accessToken: () => string | undefined;
  log: (msg: string) => void;
  onChange: (snapshot: PreviewSnapshot) => void;
}

export function tileHealth(t: { iceState: string; stalled: boolean }): Health {
  if (t.iceState === "disconnected" || t.iceState === "closed") return "lost";
  return t.stalled ? "stalled" : "live";
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const REQUEST_TIMEOUT_MS = 8000;
const POLL_MS = 5000;
const STATS_MS = 3000;
const DISCONNECT_GRACE_MS = 5000;
const CONNECT_TIMEOUT_MS = 15000;

// Server error text, and the API codes that mean the same: retrying cannot help.
const ROOM_GONE = "room not found or closed";
const TERMINAL_CODES = [9992 /* NOT_EXISTED */, 9998 /* TOKEN_INVALID, i.e. refresh already failed */];

function isTerminal(err: unknown): boolean {
  const e = err as { code?: number; message?: string };
  return e?.message === ROOM_GONE || (e?.code !== undefined && TERMINAL_CODES.includes(e.code));
}

const errMsg = (err: unknown): string => (err as Error)?.message ?? String(err);

interface ProducerInfo extends Label {
  member_id: string;
  producer_id: string;
  kind: string;
  ice_state?: string;
}

interface Slot {
  producerId: string;
  consumer: types.Consumer;
  lastFrames: number;
  flat: number; // consecutive stats polls without a new decoded frame
}

interface Entry extends Label {
  memberId: string;
  iceState: string;
  stalled: boolean;
  stream: MediaStream;
  video?: Slot;
  audio?: Slot;
}

interface Hooks {
  current(): boolean;
  lost(err: unknown): void;
  live(): void;
  changed(): void;
}

// One signaling WS + Device + recv transport. Never reused: any failure throws the
// whole thing away and Preview builds a new one.
class Connection {
  private ws?: WebSocket;
  private device!: Device;
  private recv?: types.Transport;
  private entries = new Map<string, Entry>();
  private consumed = new Set<string>();
  private pending = new Map<string, { res: (m: any) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private reqId = 0;
  private ready = false;
  private buffered: any[] = [];
  // Messages are handled strictly in order, so a poll cannot interleave with events.
  private chain: Promise<void> = Promise.resolve();
  private timers: ReturnType<typeof setInterval>[] = [];
  private discTimer?: ReturnType<typeof setTimeout>;
  private polling = false;

  constructor(private deps: PreviewDeps, private hooks: Hooks) {}

  async open(): Promise<void> {
    const { roomId, api, log } = this.deps;
    const tok = await api(`/rooms/${roomId}/preview-token`, { method: "POST", body: { quality: "low", protocol: "webrtc" } });
    if (!this.hooks.current()) return;

    // The WS cannot carry headers, so the JWT rides in the query (the server redacts it from logs).
    const token = encodeURIComponent(this.deps.accessToken() ?? "");
    const ws = (this.ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${tok.signaling_url}?token=${token}`));
    log(`ws connecting ${tok.signaling_url}`);
    const opened = new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws error"));
    });
    // Set before the Device loads: early messages (welcome!) are buffered, not lost.
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = (ev) => {
      log(`ws closed code=${ev.code} reason=${ev.reason}`);
      this.hooks.lost(new Error(`ws closed (${ev.code})`));
    };
    await opened;
    this.device = new Device(); // throws on an unsupported browser; connect() treats that like any failure
    await this.device.load({ routerRtpCapabilities: tok.rtp_capabilities });
    if (!this.hooks.current()) return;
    this.ready = true;
    for (const m of this.buffered.splice(0)) this.enqueue(() => this.handle(m));
  }

  tiles(): TileInfo[] {
    return [...this.entries.values()]
      .filter((e) => e.video)
      .map((e) => ({
        memberId: e.memberId,
        producerId: e.video!.producerId,
        camera_name: e.camera_name,
        device_name: e.device_name,
        device_model: e.device_model,
        device_short_id: e.device_short_id,
        stream: e.stream,
        iceState: e.iceState,
        stalled: e.stalled,
      }));
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.discTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.rej(new Error("closed"));
    }
    this.pending.clear();
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      this.ws.close();
    }
    for (const e of this.entries.values()) {
      e.video?.consumer.close();
      e.audio?.consumer.close();
    }
    this.entries.clear();
    this.recv?.close();
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain
      .then(() => (this.hooks.current() ? fn() : undefined))
      .catch((err) => this.hooks.lost(err));
  }

  private request(type: string, body: Record<string, unknown> = {}): Promise<any> {
    return new Promise((res, rej) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return rej(new Error(`ws not open (${type})`));
      const id = `req_${++this.reqId}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`timeout ${type}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ request_id: id, type, ...body }));
    });
  }

  private onMessage(data: string): void {
    let m: any;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const p = m.request_id && this.pending.get(m.request_id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(m.request_id);
      if (m.type === "error") p.rej(new Error(m.message));
      else p.res(m);
      return;
    }
    // Unsolicited error (e.g. room closed): handled at once, the server closes the WS right after.
    if (m.type === "error" && !m.request_id) {
      this.hooks.lost(new Error(m.message));
      return;
    }
    this.deps.log(`<= ${m.type}`);
    if (this.ready) this.enqueue(() => this.handle(m));
    else this.buffered.push(m);
  }

  private async handle(m: any): Promise<void> {
    switch (m.type) {
      case "welcome":
        return this.setupRecv();
      case "new-producer":
        return this.consume(m);
      case "producer-closed":
        return this.removeProducer(m.producer_id);
      case "member-state": {
        const e = this.entries.get(m.member_id);
        if (e) {
          e.iceState = m.ice_state;
          this.hooks.changed();
        }
      }
    }
  }

  private async setupRecv(): Promise<void> {
    const tr = await this.request("create-transport", { direction: "recv" });
    const recv = (this.recv = this.device.createRecvTransport({
      id: tr.transport_id,
      iceParameters: tr.ice_parameters,
      iceCandidates: tr.ice_candidates,
      dtlsParameters: tr.dtls_parameters,
    }));
    recv.on("connect", ({ dtlsParameters }, ok, fail) => {
      this.request("connect-transport", { transport_id: tr.transport_id, dtls_parameters: dtlsParameters }).then(() => ok(), fail);
    });
    recv.on("connectionstatechange", (state) => {
      this.deps.log(`recv connectionstate ${state}`);
      clearTimeout(this.discTimer);
      if (state === "failed") {
        this.hooks.lost(new Error("recv transport failed"));
      } else if (state === "disconnected") {
        this.discTimer = setTimeout(() => this.hooks.lost(new Error("recv transport disconnected >5s")), DISCONNECT_GRACE_MS);
      }
    });

    await this.reconcile();
    this.timers.push(setInterval(() => this.poll(), POLL_MS), setInterval(() => void this.pollStats(), STATS_MS));
    this.hooks.live();
  }

  private poll(): void {
    if (this.polling) return; // a slow get-producers must not stack up behind itself
    this.polling = true;
    this.enqueue(async () => {
      try {
        await this.reconcile();
      } finally {
        this.polling = false;
      }
    });
  }

  // Make the entries match the server's producer list: consume what was missed, drop what vanished.
  private async reconcile(): Promise<void> {
    const { producers } = (await this.request("get-producers")) as { producers: ProducerInfo[] };
    const listed = new Set(producers.map((p) => p.producer_id));
    for (const p of producers) {
      const e = this.entries.get(p.member_id);
      if (e && p.ice_state) e.iceState = p.ice_state;
      await this.consume(p);
    }
    for (const e of [...this.entries.values()]) {
      for (const slot of [e.video, e.audio]) {
        if (slot && !listed.has(slot.producerId)) this.removeProducer(slot.producerId);
      }
    }
    this.hooks.changed();
  }

  private async consume(p: ProducerInfo): Promise<void> {
    if (this.consumed.has(p.producer_id)) return;
    this.consumed.add(p.producer_id); // before any await, so two paths cannot consume the same producer

    let consumer: types.Consumer;
    try {
      const r = await this.request("consume", {
        transport_id: this.recv!.id,
        producer_id: p.producer_id,
        rtp_capabilities: this.device.rtpCapabilities,
      });
      consumer = await this.recv!.consume({ id: r.consumer_id, producerId: r.producer_id, kind: r.kind, rtpParameters: r.rtp_parameters });
    } catch (err) {
      this.consumed.delete(p.producer_id);
      if (this.hooks.current()) this.deps.log(`consume failed: ${errMsg(err)}`);
      return;
    }
    if (!this.hooks.current()) {
      consumer.close();
      return;
    }

    let entry = this.entries.get(p.member_id);
    if (!entry) {
      entry = {
        memberId: p.member_id,
        camera_name: p.camera_name,
        device_name: p.device_name,
        device_model: p.device_model,
        device_short_id: p.device_short_id,
        iceState: p.ice_state ?? "new",
        stalled: false,
        stream: new MediaStream(),
      };
      this.entries.set(p.member_id, entry);
    }
    // A second producer of the same kind from one member replaces the first (one tile per member).
    const kind = consumer.kind === "video" ? "video" : "audio";
    const prev = entry[kind];
    if (prev) {
      this.deps.log(`member ${p.member_id.slice(0, 8)} produced again, replacing ${prev.producerId.slice(0, 8)}`);
      entry.stream.removeTrack(prev.consumer.track);
      prev.consumer.close();
    }
    entry[kind] = { producerId: p.producer_id, consumer, lastFrames: -1, flat: 0 };
    entry.stream.addTrack(consumer.track);
    if (kind === "video") entry.stalled = false;
    this.hooks.changed();

    try {
      await this.request("resume-consumer", { consumer_id: consumer.id });
    } catch (err) {
      this.deps.log(`resume failed: ${errMsg(err)}`); // a stalled tile retries the resume
    }
  }

  private removeProducer(producerId: string): void {
    for (const e of this.entries.values()) {
      for (const kind of ["video", "audio"] as const) {
        const slot = e[kind];
        if (slot?.producerId !== producerId) continue;
        e.stream.removeTrack(slot.consumer.track);
        slot.consumer.close();
        e[kind] = undefined;
      }
      if (!e.video && !e.audio) this.entries.delete(e.memberId);
    }
    this.hooks.changed();
  }

  // framesDecoded flat over two polls = the picture is frozen even though the tile exists.
  private async pollStats(): Promise<void> {
    for (const e of [...this.entries.values()]) {
      const slot = e.video;
      if (!slot) continue;
      let frames = 0;
      try {
        (await slot.consumer.getStats()).forEach((s: any) => {
          if (s.type === "inbound-rtp") frames = s.framesDecoded ?? 0;
        });
      } catch {
        continue; // consumer closed meanwhile
      }
      if (e.video !== slot) continue;
      if (frames > slot.lastFrames) {
        slot.flat = 0;
        if (e.stalled) {
          e.stalled = false;
          this.hooks.changed();
        }
      } else if (++slot.flat >= 2) {
        if (!e.stalled) {
          e.stalled = true;
          this.hooks.changed();
        }
        // The server's keyframe pump is bounded; resume-consumer triggers a fresh burst.
        this.request("resume-consumer", { consumer_id: slot.consumer.id }).catch(() => undefined);
      }
      slot.lastFrames = frames;
    }
  }
}

// Owns the user's intent (`wanted`) and the retry loop. `gen` identifies the current
// Connection; every callback a Connection or timer makes is dropped if its gen is stale.
export class Preview {
  private wanted = false;
  private gen = 0;
  private attempt = 0;
  private state: PreviewState = "idle";
  private error: string | null = null;
  private conn: Connection | null = null;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;

  constructor(private deps: PreviewDeps) {
    window.addEventListener("online", this.onOnline);
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.attempt = 0;
    this.error = null;
    void this.connect();
  }

  stop(): void {
    this.wanted = false;
    this.teardown();
    this.error = null;
    this.setState("idle");
  }

  dispose(): void {
    window.removeEventListener("online", this.onOnline);
    this.stop();
  }

  private onOnline = (): void => {
    if (!this.wanted || this.state !== "reconnecting") return;
    this.deps.log("network online, retrying now");
    clearTimeout(this.retryTimer);
    void this.connect();
  };

  private teardown(): void {
    this.gen++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    this.conn?.close();
    this.conn = null;
  }

  private async connect(): Promise<void> {
    this.teardown();
    const gen = this.gen;
    const conn = (this.conn = new Connection(this.deps, {
      current: () => gen === this.gen,
      lost: (err) => this.lost(gen, err),
      live: () => {
        if (gen !== this.gen) return;
        clearTimeout(this.connectTimer);
        this.attempt = 0;
        this.setState("live");
      },
      changed: () => {
        if (gen === this.gen) this.emit();
      },
    }));
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    // Nothing else fires if the API hangs or the WS opens but welcome never comes.
    this.connectTimer = setTimeout(() => this.lost(gen, new Error("connect timeout")), CONNECT_TIMEOUT_MS);
    try {
      await conn.open();
    } catch (err) {
      this.lost(gen, err);
    }
  }

  private lost(gen: number, err: unknown): void {
    if (gen !== this.gen || !this.wanted) return;
    this.teardown();
    if (isTerminal(err)) {
      this.wanted = false;
      this.error = errMsg(err);
      this.deps.log(`preview stopped: ${this.error}`);
      this.setState("failed");
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)];
    this.deps.log(`preview lost (${errMsg(err)}), retry in ${delay / 1000}s`);
    this.setState("reconnecting");
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private setState(state: PreviewState): void {
    if (state !== this.state) this.deps.log(`preview ${this.state} -> ${state}`);
    this.state = state;
    this.emit();
  }

  private emit(): void {
    this.deps.onChange({ state: this.state, error: this.error, tiles: this.conn?.tiles() ?? [] });
  }
}

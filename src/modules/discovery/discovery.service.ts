import dgram from "node:dgram";
import os from "node:os";
import Bonjour from "bonjour-service";
import { env } from "../../config/env";

/**
 * LAN discovery — hai kênh tự động:
 *  1. mDNS/Bonjour: publish service `_multicam._tcp` (type "multicam") để app
 *     dùng react-native-zeroconf (cùng subnet) tự tìm server, không cần quét cổng.
 *  2. UDP broadcast responder: bất kỳ ai gửi chuỗi MULTICAM-DISCOVER tới
 *     UDP <ip>:55666 sẽ nhận lại JSON cấu hình hiện tại (phương án fallback).
 */
export const DISCOVER_PROBE = "MULTICAM-DISCOVER";
export const DISCOVERY_SERVICE_TYPE = "multicam"; // ==> _multicam._tcp.local
export const DISCOVER_UDP_PORT = env.discovery.udpPort;

export interface DiscoveryPayload {
  server_name: string;
  version: string;
  api_prefix: string;
  ip: string;
  ip_list: string[];
  http_port: number;
  protocol: "http";
  time: string;
}

export interface DiscoveryHandle {
  stop: () => void;
}

/** Danh sách địa chỉ IPv4 local (bỏ loopback). */
export function getLocalIPv4s(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        out.push(info.address);
      }
    }
  }
  return out;
}

function primaryIPv4(): string {
  const ips = getLocalIPv4s();
  return ips.length ? ips[0] : "0.0.0.0";
}

/**
 * Bắt đầu quảng bá server trên mạng LAN. Trả về handle để dừng khi shutdown.
 */
export function startDiscoveryService(opts: {
  version: string;
  apiPrefix: string;
  httpPort: number;
}): DiscoveryHandle {
  const ip = primaryIPv4();
  const ipList = getLocalIPv4s();
  const payload: DiscoveryPayload = {
    server_name: env.discovery.serverName,
    version: opts.version,
    api_prefix: opts.apiPrefix,
    ip,
    ip_list: ipList,
    http_port: opts.httpPort,
    protocol: "http",
    time: new Date().toISOString(),
  };
  const jsonPayload = JSON.stringify(payload);

  // ── Kênh 1: UDP probe responder ──
  const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
  udp.on("error", (err: Error) => {
    console.warn(`[discovery] UDP responder error: ${err.message}`);
  });
  udp.on("message", (msg: Buffer, rinfo) => {
    const text = msg.toString("utf8").trim();
    if (text === DISCOVER_PROBE || text === "multicam_discover") {
      udp.send(Buffer.from(jsonPayload), rinfo.port, rinfo.address);
    }
  });
  try {
    udp.bind(DISCOVER_UDP_PORT, () => {
      udp.setMulticastTTL(1);
      console.log(
        `[discovery] UDP responder listening on ${DISCOVER_UDP_PORT} (probe "${DISCOVER_PROBE}")`
      );
    });
  } catch (err) {
    console.warn(`[discovery] UDP bind failed: ${(err as Error).message}`);
  }

  // ── Kênh 2: mDNS publish ──
  const bonjour = new Bonjour(
    {},
    (err: Error) => {
      // Registry lỗi (vd "Service name already in use") không được throw —
      // chỉ log, mDNS vẫn đủ best-effort. Xem registry.ts trong bonjour-service:
      // lỗi này đi qua errorCallback, nếu thiếu Node sẽ throw làm crash server.
      console.warn(`[discovery] mDNS ${err.message}`);
    }
  );
  const publishName = `Multicam-${ip}@${env.discovery.serverName}`;
  const service = bonjour.publish({
    name: publishName,
    type: DISCOVERY_SERVICE_TYPE,
    protocol: "tcp",
    port: opts.httpPort,
    host: ip,
    txt: {
      server_name: env.discovery.serverName,
      version: opts.version,
      api_prefix: opts.apiPrefix,
      protocol: "http",
      ips: ipList.join(","),
    },
  });
  service.on("error", (err: Error) => {
    console.warn(`[discovery] mDNS service error: ${err.message}`);
  });

  console.log(
    `[discovery] mDNS published _${DISCOVERY_SERVICE_TYPE}._tcp on port ${opts.httpPort} (${env.discovery.serverName}, ${ip}) — ${jsonPayload}`
  );

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      service.stop();
    } catch {
      /* noop */
    }
    try {
      bonjour.destroy();
    } catch {
      /* noop */
    }
    try {
      udp.close();
    } catch {
      /* noop */
    }
    console.log("[discovery] stopped");
  };

  return { stop };
}
/**
 * The Live session over WebRTC (opt-in, voice.transport="webrtc"), the only transport with standby. `POST
 * /v1/live/sessions` starts the session with an SDP offer; JSON events travel on the `oai-events` data channel and
 * audio on an Opus media track. The adapter keeps the primary WebSocket's event vocabulary, so the session is unchanged:
 * its `session.start` becomes the creation request, `session.input_audio.append` feeds the track and received audio
 * comes back as `session.output_audio.delta`. werift (pure TypeScript) and the optional Opus codec load only when
 * `dori voice discord` starts with this transport.
 */
import type * as Werift from "werift";
import type { OpusCodec } from "./discord-link.ts";
import { parseLiveEvent } from "./provider.ts";
import type { OpenVoiceSocket, Wire } from "./types.ts";

type Rtc = Pick<
  typeof Werift,
  "RTCPeerConnection" | "RTCRtpCodecParameters" | "MediaStreamTrack" | "RtpPacket" | "RtpHeader"
>;
type Request = (url: string, init: RequestInit) => Promise<Response>;

const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const PAYLOAD_TYPE = 111;
/** 20 ms of 48 kHz mono PCM16: one Opus frame. */
const FRAME_BYTES = 1920;
/** Owner audio waiting for the real-time track; more than this means the pacing upstream broke. */
const MAX_PENDING_BYTES = 5 * 50 * FRAME_BYTES;

/** 24 kHz mono to 48 kHz mono, interpolating across chunk boundaries through `state.previous`. */
const upsample = (pcm24: Buffer, state: { previous: number }): Buffer => {
  const n = pcm24.length >> 1;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const s = pcm24.readInt16LE(i * 2);
    out.writeInt16LE((state.previous + s) >> 1, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
    state.previous = s;
  }
  return out;
};

/** 48 kHz mono to 24 kHz mono by averaging sample pairs. */
const downsample = (pcm48: Buffer): Buffer => {
  const n = pcm48.length >> 2;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE((pcm48.readInt16LE(i * 4) + pcm48.readInt16LE(i * 4 + 2)) >> 1, i * 2);
  return out;
};

/**
 * `codec` makes a 48 kHz mono Opus codec. Host candidates only: no STUN server is queried, as with a browser's default
 * configuration. A creation request is sent once and never retried; a failed one ends the transport.
 */
export const webrtcSocket =
  (
    rtc: Rtc,
    codec: () => OpusCodec,
    url = LIVE_SESSIONS_URL,
    request: Request = fetch,
    clock = performance,
  ): OpenVoiceSocket =>
  (key, handlers) => {
    const pc = new rtc.RTCPeerConnection({
      codecs: {
        audio: [
          new rtc.RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: 48_000,
            channels: 2,
            payloadType: PAYLOAD_TYPE,
          }),
        ],
      },
      iceServers: [],
      iceUseDefaultStunServer: false,
    });
    const channel = pc.createDataChannel("oai-events");
    const mic = new rtc.MediaStreamTrack({ kind: "audio" });
    const transceiver = pc.addTransceiver(mic, { direction: "sendrecv" });
    const encoder = codec();
    const decoder = codec();
    const abort = new AbortController();
    const resample = { previous: 0 };
    const rtp = { sequence: 0, timestamp: 0, ssrc: (Math.random() * 2 ** 32) >>> 0 };
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let due = 0;
    let started = false;
    let ended = false;
    let pump: NodeJS.Timeout | undefined;

    const end = (failed: boolean) => {
      if (ended) return;
      ended = true;
      clearInterval(pump);
      abort.abort();
      pending = [];
      try {
        channel.close();
        mic.stop();
      } catch {}
      void pc.close().catch(() => undefined);
      if (failed) handlers.error();
      handlers.closed();
    };
    const take = (): Buffer => {
      const frame = Buffer.concat(pending, FRAME_BYTES);
      let left = FRAME_BYTES;
      while (left > 0) {
        const head = pending[0]!;
        if (head.length > left) {
          pending[0] = head.subarray(left);
          left = 0;
        } else {
          pending.shift();
          left -= head.length;
        }
      }
      pendingBytes -= FRAME_BYTES;
      return frame;
    };
    // The track runs at real time: a burst of owner audio (the wake preroll) is spread out rather than sent at
    // once, a late timer sends at most three frames together, and a starved track does not catch up afterwards.
    const send = () => {
      const now = clock.now();
      if (pendingBytes < FRAME_BYTES) due = Math.max(due, now);
      else due = Math.max(due, now - 40);
      while (due <= now && pendingBytes >= FRAME_BYTES) {
        const header = new rtc.RtpHeader({
          payloadType: PAYLOAD_TYPE,
          sequenceNumber: rtp.sequence,
          timestamp: rtp.timestamp,
          ssrc: rtp.ssrc,
          marker: false,
        });
        mic.writeRtp(new rtc.RtpPacket(header, encoder.encode(take())));
        rtp.sequence = (rtp.sequence + 1) & 0xffff;
        rtp.timestamp = (rtp.timestamp + 960) >>> 0;
        due += 20;
      }
    };

    transceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((packet) => {
        if (ended) return;
        let pcm: Buffer;
        try {
          pcm = decoder.decode(packet.payload);
        } catch {
          return; // A corrupt Opus frame is skipped, as on the Discord side.
        }
        handlers.event({ type: "session.output_audio.delta", delta: downsample(pcm).toString("base64") });
      });
    });
    channel.onMessage.subscribe((data) => {
      if (ended) return;
      try {
        handlers.event(parseLiveEvent(JSON.parse(String(data))));
      } catch {
        handlers.error();
      }
    });
    channel.stateChanged.subscribe((state) => {
      if (state === "closed") end(false);
    });
    pc.connectionStateChange.subscribe((state) => {
      if (state === "failed") end(true);
    });

    const create = async (session: unknown) => {
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== "complete") await pc.iceGatheringStateChange.watch((s) => s === "complete");
      const response = await request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session, transport: { type: "webrtc", sdp: pc.localDescription?.sdp } }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`Live session HTTP ${response.status}`);
      const body: unknown = await response.json();
      const transport = body && typeof body === "object" && "transport" in body ? body.transport : undefined;
      const sdp = transport && typeof transport === "object" && "sdp" in transport ? transport.sdp : undefined;
      if (typeof sdp !== "string" || !sdp) throw new Error("Live session response has no SDP answer");
      if (ended) return;
      await pc.setRemoteDescription({ type: "answer", sdp });
      pump = setInterval(send, 20);
    };

    queueMicrotask(() => {
      if (!ended) handlers.open();
    });
    return {
      send: (event: Wire) => {
        if (ended) throw new Error("Live WebRTC transport is closed");
        if (event["type"] === "session.start") {
          if (started) throw new Error("Live WebRTC session already started");
          started = true;
          create(event["session"]).catch(() => end(true));
        } else if (event["type"] === "session.input_audio.append") {
          const pcm = upsample(Buffer.from(String(event["audio"]), "base64"), resample);
          if (pendingBytes + pcm.length > MAX_PENDING_BYTES) return void handlers.error();
          pending.push(pcm);
          pendingBytes += pcm.length;
        } else if (channel.readyState === "open") channel.send(JSON.stringify(event));
        else throw new Error("Live WebRTC data channel is not open");
      },
      close: () => end(false),
      terminate: () => end(false),
    };
  };

/** Loads the optional WebRTC and Opus packages; called only when voice.transport is "webrtc". */
export const openWebrtcVoice = async (): Promise<OpenVoiceSocket> => {
  // Dynamic on purpose: optional dependencies, absent or unloadable where this transport is not used.
  const rtc = await import("werift");
  const { OpusEncoder } = await import("@discordjs/opus");
  return webrtcSocket(rtc, () => new OpusEncoder(48_000, 1));
};

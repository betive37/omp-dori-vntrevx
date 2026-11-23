import { readSync } from "node:fs";
type ReadStaged = (offset: number, size: number) => Buffer | undefined;

const oggAudio = (read: ReadStaged, total: number): readonly string[] => {
  const mimes = ["audio/ogg", "application/ogg", "video/ogg"];
  let vorbis = false;
  let offset = 0;
  for (let pages = 0; pages < 32; pages++) {
    const page = read(offset, 27);
    // The initial BOS group ends at the first non-BOS page.
    if (!page || page.toString("latin1", 0, 4) !== "OggS" || page[4] !== 0 || page[5] !== 2) break;
    const lacing = read(offset + 27, page.readUInt8(26));
    if (!lacing?.length || page.readUInt32LE(18) !== 0) break;
    const data = offset + 27 + lacing.length;
    offset = data + lacing.reduce((size, lace) => size + lace, 0);
    if (offset > total) break;
    const last = lacing.findIndex((lace) => lace < 255);
    if (last < 0) continue;
    const length = last * 255 + lacing.readUInt8(last);
    const codec = read(data, Math.min(length, 21 + 255));
    if (!codec) break;
    const version = codec[8] ?? 0;
    if (length >= 19 && codec.toString("latin1", 0, 8) === "OpusHead" && version > 0 && version < 16) {
      const channels = codec.readUInt8(9);
      const family = codec.readUInt8(18);
      if (channels === 0) continue;
      if (family === 0 && channels <= 2) return [...mimes, "audio/opus"];
      if (family === 0 || (family === 1 && channels > 8) || length < 21 + channels) continue;
      const streams = codec.readUInt8(19);
      const coupled = codec.readUInt8(20);
      const coded = streams + coupled;
      const validMap = codec.subarray(21, 21 + channels).every((index) => index === 255 || index < coded);
      if (streams > 0 && coupled <= streams && coded <= 255 && validMap) return [...mimes, "audio/opus"];
    }
    if (
      length === 30 &&
      codec.toString("latin1", 0, 7) === "\x01vorbis" &&
      codec.readUInt32LE(7) === 0 &&
      codec[11] !== 0 &&
      codec.readUInt32LE(12) !== 0 &&
      codec[29] === 1
    )
      vorbis = true;
  }
  return vorbis ? mimes : [];
};

const mp4HasAudio = (read: ReadStaged, start: number, total: number): boolean => {
  const path = ["moov", "trak", "mdia", "hdlr"];
  let remaining = 4096;
  const walk = (offset: number, end: number, depth: number): boolean => {
    while (end - offset >= 8 && remaining > 0) {
      remaining--;
      const header = read(offset, 8);
      if (!header) break;
      let size = header.readUInt32BE(0);
      let headerSize = 8;
      if (size === 1) {
        if (end - offset < 16) break;
        const extended = read(offset + 8, 8);
        if (!extended) break;
        const wideSize = extended.readBigUInt64BE(0);
        if (wideSize > BigInt(end - offset)) break;
        size = Number(wideSize);
        headerSize = 16;
      } else if (size === 0) {
        // Size zero extends to EOF, so only use it at the top level.
        if (depth !== 0) break;
        size = end - offset;
      }
      if (size < headerSize || size > end - offset) break;
      if (header.toString("latin1", 4, 8) === path[depth]) {
        const data = offset + headerSize;
        if (depth === path.length - 1) {
          const handler = size - headerSize >= 24 ? read(data, 12) : undefined;
          if (handler?.[0] === 0 && handler.toString("latin1", 8, 12) === "soun") return true;
        } else if (walk(data, offset + size, depth + 1)) {
          return true;
        }
      }
      offset += size;
    }
    return false;
  };
  return walk(start, total, 0);
};

const mp3Audio = (head: Buffer, read: ReadStaged, total: number): boolean => {
  let offset = 0;
  if (
    head.length >= 10 &&
    head.toString("latin1", 0, 3) === "ID3" &&
    [2, 3, 4].includes(head.readUInt8(3)) &&
    [6, 7, 8, 9].every((i) => head.readUInt8(i) < 128)
  ) {
    const size = [6, 7, 8, 9].reduce((size, i) => (size << 7) | head.readUInt8(i), 0);
    offset = 10 + size + (head.readUInt8(3) === 4 && (head.readUInt8(5) & 0x10) !== 0 ? 10 : 0);
    const frame = read(offset, 4);
    if (!frame) return false;
    head = frame;
  }
  if (head.length < 4 || head[0] !== 0xff) return false;
  const flags = head.readUInt8(1);
  const rates = head.readUInt8(2);
  if ((flags & 0xe0) !== 0xe0 || ((flags >> 3) & 3) === 1 || ((flags >> 1) & 3) !== 1 || ((rates >> 2) & 3) === 3)
    return false;
  const bitrate = rates >> 4;
  if (bitrate !== 0) return bitrate !== 15;

  // Free format carries no frame size. Confirm three complete frames with the same unpadded spacing.
  const maxSpacing = 8192;
  const window = read(offset, Math.min(total - offset, 2 * maxSpacing + 5));
  if (!window) return false;
  const compatible = (at: number): boolean =>
    at <= window.length - 4 &&
    window[at] === 0xff &&
    (window.readUInt8(at + 1) & 0xfe) === (flags & 0xfe) &&
    (window.readUInt8(at + 2) & 0xfc) === (rates & 0xfc);
  const firstPadding = (rates >> 1) & 1;
  // Even mono frames must have room for the header and Layer III side information.
  const minSpacing = (flags & 0x18) === 0x18 ? 21 : 13;
  const lastCandidate = Math.min(maxSpacing, window.length - 4);
  for (let second = minSpacing + firstPadding; second <= lastCandidate; second++) {
    if (!compatible(second)) continue;
    const spacing = second - firstPadding;
    const third = second + spacing + ((window.readUInt8(second + 2) >> 1) & 1);
    if (compatible(third) && third + spacing + ((window.readUInt8(third + 2) >> 1) & 1) <= total - offset) return true;
  }
  return false;
};

export const audioMimes = (fd: number, total: number): readonly string[] => {
  const read: ReadStaged = (offset, size) => {
    if (offset < 0 || size < 0 || size > total - offset) return undefined;
    const bytes = Buffer.alloc(size);
    return readSync(fd, bytes, 0, size, offset) === size ? bytes : undefined;
  };
  const head = read(0, Math.min(total, 16));
  if (!head) return [];
  const magic = head.toString("latin1", 0, 4);
  if (head.length >= 12 && ["RIFF", "RIFX", "RF64"].includes(magic) && head.toString("latin1", 8, 12) === "WAVE")
    return ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"];
  if (magic === "OggS") return oggAudio(read, total);
  if (head.length >= 8 && magic === "fLaC") return ["audio/flac", "audio/x-flac"];
  if (head.length >= 16 && head.toString("latin1", 4, 8) === "ftyp") {
    const size = head.readUInt32BE(0);
    const brand = head.toString("latin1", 8, 12);
    if (
      size >= 16 &&
      size <= total &&
      ["M4A ", "M4B ", "isom", "iso2", "iso5", "iso6", "mp41", "mp42", "dash"].includes(brand) &&
      mp4HasAudio(read, size, total)
    )
      return ["audio/mp4", "audio/x-m4a", "application/mp4", "video/mp4"];
    return [];
  }
  return mp3Audio(head, read, total) ? ["audio/mpeg", "audio/mp3", "audio/x-mp3", "audio/mpeg3", "audio/x-mpeg"] : [];
};

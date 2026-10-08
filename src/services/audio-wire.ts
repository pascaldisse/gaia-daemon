// Wire helpers for the unmute call STT bridge: minimal msgpack (decode any,
// encode maps/strings/float arrays) + PCM→WAV. No TTS here.
export function unpackMessage(data: Uint8Array): unknown {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const take = (bytes: number): number => {
    const at = offset;
    offset += bytes;
    return at;
  };

  const decode = (): unknown => {
    const byte = view.getUint8(take(1));
    if (byte <= 0x7f) return byte;
    if (byte >= 0xe0) return byte - 0x100;
    if ((byte & 0xf0) === 0x80) return decodeMap(byte & 0x0f);
    if ((byte & 0xf0) === 0x90) return decodeArray(byte & 0x0f);
    if ((byte & 0xe0) === 0xa0) return decodeString(byte & 0x1f);
    switch (byte) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return decodeBin(view.getUint8(take(1)));
      case 0xc5:
        return decodeBin(view.getUint16(take(2)));
      case 0xc6:
        return decodeBin(view.getUint32(take(4)));
      case 0xca:
        return view.getFloat32(take(4));
      case 0xcb:
        return view.getFloat64(take(8));
      case 0xcc:
        return view.getUint8(take(1));
      case 0xcd:
        return view.getUint16(take(2));
      case 0xce:
        return view.getUint32(take(4));
      case 0xcf:
        return Number(view.getBigUint64(take(8)));
      case 0xd0:
        return view.getInt8(take(1));
      case 0xd1:
        return view.getInt16(take(2));
      case 0xd2:
        return view.getInt32(take(4));
      case 0xd3:
        return Number(view.getBigInt64(take(8)));
      case 0xd9:
        return decodeString(view.getUint8(take(1)));
      case 0xda:
        return decodeString(view.getUint16(take(2)));
      case 0xdb:
        return decodeString(view.getUint32(take(4)));
      case 0xdc:
        return decodeArray(view.getUint16(take(2)));
      case 0xdd:
        return decodeArray(view.getUint32(take(4)));
      case 0xde:
        return decodeMap(view.getUint16(take(2)));
      case 0xdf:
        return decodeMap(view.getUint32(take(4)));
      default:
        throw new Error(`Unsupported msgpack type 0x${byte.toString(16)}`);
    }
  };
  const decodeString = (length: number): string => Buffer.from(data.subarray(offset, (offset += length))).toString("utf8");
  const decodeBin = (length: number): Uint8Array => data.subarray(offset, (offset += length));
  const decodeArray = (length: number): unknown[] => Array.from({ length }, () => decode());
  const decodeMap = (length: number): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (let i = 0; i < length; i++) {
      const key = decode();
      result[String(key)] = decode();
    }
    return result;
  };

  return decode();
}

export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function packMsg(value: unknown): Buffer {
  const parts: Buffer[] = [];
  encode(value, parts);
  return Buffer.concat(parts);
}

function encode(value: unknown, out: Buffer[]): void {
  if (value === null || value === undefined) {
    out.push(Buffer.from([0xc0]));
  } else if (typeof value === "boolean") {
    out.push(Buffer.from([value ? 0xc3 : 0xc2]));
  } else if (typeof value === "number") {
    const buf = Buffer.allocUnsafe(5);
    buf[0] = 0xca;
    buf.writeFloatBE(value, 1);
    out.push(buf);
  } else if (typeof value === "string") {
    encodeString(value, out);
  } else if (Array.isArray(value)) {
    encodeArrayHeader(value.length, out);
    for (const item of value) encode(item, out);
  } else if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    encodeMapHeader(entries.length, out);
    for (const [key, item] of entries) {
      encodeString(key, out);
      encode(item, out);
    }
  } else {
    throw new Error(`packMsg: unsupported value ${typeof value}`);
  }
}

function encodeString(value: string, out: Buffer[]): void {
  const bytes = Buffer.from(value, "utf8");
  const len = bytes.length;
  if (len < 32) out.push(Buffer.from([0xa0 | len]));
  else if (len < 0x100) out.push(Buffer.from([0xd9, len]));
  else if (len < 0x10000) {
    const head = Buffer.allocUnsafe(3);
    head[0] = 0xda;
    head.writeUInt16BE(len, 1);
    out.push(head);
  } else {
    const head = Buffer.allocUnsafe(5);
    head[0] = 0xdb;
    head.writeUInt32BE(len, 1);
    out.push(head);
  }
  out.push(bytes);
}

function encodeArrayHeader(len: number, out: Buffer[]): void {
  if (len < 16) out.push(Buffer.from([0x90 | len]));
  else if (len < 0x10000) {
    const head = Buffer.allocUnsafe(3);
    head[0] = 0xdc;
    head.writeUInt16BE(len, 1);
    out.push(head);
  } else {
    const head = Buffer.allocUnsafe(5);
    head[0] = 0xdd;
    head.writeUInt32BE(len, 1);
    out.push(head);
  }
}

function encodeMapHeader(len: number, out: Buffer[]): void {
  if (len < 16) out.push(Buffer.from([0x80 | len]));
  else {
    const head = Buffer.allocUnsafe(3);
    head[0] = 0xde;
    head.writeUInt16BE(len, 1);
    out.push(head);
  }
}

// ---------------------------------------------------------------------------
// Streaming linear resampler: engine rate → 24 kHz, carrying one sample of
// history across frames so there is no discontinuity at frame boundaries. Works
// for both up- and down-sampling; a no-op when the rates already match.

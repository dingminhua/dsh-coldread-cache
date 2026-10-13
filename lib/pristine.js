/**
 * Verbatim ports of the private helpers this plugin needs from
 * @deepseek-ai/dsh-session-persistence-jsonl.
 *
 * The jsonl module keeps these module-local, so a plugin cannot import them.
 * Every function below is a line-for-line port of one pristine implementation,
 * with deliberate edits marked PORT NOTE. Nothing here reads or writes plugin
 * state; it is pure codec, scan, and decode logic.
 * @module dsh-coldread-cache/pristine
 */
import { constants, zstdDecompressSync } from "node:zlib";
import { stat } from "node:fs/promises";
import { assertV4RowAdmission } from "@deepseek-ai/dsh-session-format-v3-to-v4";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { SessionFormatUnsupportedMigrationError } from "@deepseek-ai/dsh-session-format";
import { SessionFormatUnsupportedError, SessionPersistenceRevision } from "@deepseek-ai/dsh-session-persistence";
import { SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";

const ZSTD_MAGIC = 4247762216;

/* ------------------------------------------------------------------ */
/* port of dsh-session-persistence-jsonl lib/index.js:1288-1363        */
/* ------------------------------------------------------------------ */

/**
 * Walk concatenated Zstandard frames and report each frame's byte range.
 * A trailing partial frame is not an error: it is reported as tornStart so the
 * caller can recover the records that did commit.
 * @param buffer - the artifact bytes.
 * @param maxFrames - stop after this many complete frames.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error("corrupt Zstandard session log: invalid frame magic at byte " + offset);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error("corrupt Zstandard session log: reserved frame-header bit at byte " + (offset - 1));
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error("corrupt Zstandard session log: reserved block type at byte " + (offset - 3));
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/**
 * One complete frame -> its plaintext.
 *
 * Slicing the frame out of the artifact is mandatory: zstdDecompressSync
 * silently returns only the first frame of a concatenated buffer.
 */
export function decompressZstdFrameSync(frame) {
  return zstdDecompressSync(frame);
}

/**
 * Frame decoder over an explicit frame list, ported from
 * lib/index.js:1252-1279.
 *
 * PORT NOTE: the plugin always uses the public one-shot decoder. It is the
 * upstream-declared fallback for every Node release (the jsonl backend prefers
 * a private _handle fast path when the running Node exposes it), the only
 * difference is throughput on a path the plugin has already made cheap, and the
 * public API is the only one whose behaviour this plugin can promise across
 * Node releases.
 */
export function createZstdFrameDecoder() {
  let closed = false;
  return {
    *decode(source, frames) {
      if (closed) throw new Error("cannot start a closed Zstandard frame decoder");
      try {
        for (const { start, end } of frames) {
          let decoded;
          try {
            decoded = zstdDecompressSync(source.subarray(start, end));
          } catch (error) {
            throw new Error("corrupt Zstandard session log: frame at byte " + start + " failed validation", {
              cause: error,
            });
          }
          yield decoded;
        }
      } finally {
        closed = true;
      }
    },
    close() {
      closed = true;
    },
  };
}

/** Decode every frame in a frame list into fresh, owned plaintext buffers. */
export function decodeFrames(buffer, frames) {
  const decoder = createZstdFrameDecoder();
  const chunks = [];
  try {
    for (const plaintext of decoder.decode(buffer, frames)) chunks.push(Buffer.from(plaintext));
  } finally {
    decoder.close();
  }
  return chunks;
}

/* ------------------------------------------------------------------ */
/* port of lib/index.js:1627-1635 (stat identity)                       */
/* ------------------------------------------------------------------ */

export function identityOf(value) {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}

/** stat with the exact options the pristine reader uses. */
export function statIdentity(path) {
  return stat(path, { bigint: true });
}

/**
 * lib/index.js:2324-2334 — a stat identity as the persistence revision token.
 *
 * SessionPersistenceRevision is the identity function, so the third
 * colon-separated token of a revision is the artifact's byte size.
 */
export function fileRevisionFromIdentity(identity) {
  return SessionPersistenceRevision(identityOf(identity));
}

export function revisionBytes(revision) {
  const size = Number(String(revision).split(":")[2]);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/* ------------------------------------------------------------------ */
/* lib/index.js:2299-2313 (deep freeze)                                 */
/* ------------------------------------------------------------------ */

/**
 * Deep-freeze one event graph in place, exactly as the pristine backend does.
 *
 * PORT NOTE: the pristine backend freezes the decoded event ARRAY in place,
 * which is only safe because it throws that array away and keeps the memo
 * entry instead. This port freezes one event, and the caller freezes a snapshot
 * array, so a resident decoder's own array stays extensible.
 */
export function freezeStoredEvent(event) {
  const pending = [event];
  while (pending.length > 0) {
    const current = pending.pop();
    Object.freeze(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const child = current[index];
        if (child !== null && typeof child === "object") pending.push(child);
      }
    } else {
      for (const key in current) {
        const child = current[key];
        if (child !== null && typeof child === "object") pending.push(child);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* ports of lib/index.js:777-841, 970-996 (header admission)            */
/* ------------------------------------------------------------------ */

const HEADER_REQUIRED_KEYS = ["type", "version", "id", "createdAt", "isSeeded", "delegationDepth"];
const HEADER_OPTIONAL_KEYS = ["cwd", "parentSession", "origin", "agentPreset"];
const HEADER_KEYS = new Set([...HEADER_REQUIRED_KEYS, ...HEADER_OPTIONAL_KEYS]);

function isHeaderLine(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    HEADER_REQUIRED_KEYS.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => HEADER_KEYS.has(key)) &&
    value.type === "session" &&
    typeof value.version === "number" &&
    typeof value.id === "string"
  );
}

function assertNoRetiredHeaderFields(value) {
  if (typeof value !== "object" || value === null) return;
  if (Object.hasOwn(value, "sandboxMode") || Object.hasOwn(value, "approvalPolicy")) {
    throw new Error("session header uses retired policy baseline fields");
  }
}

/**
 * PORT NOTE: the pristine module builds its refusal through the persistence
 * package's private sessionFormatVersionRefusal helper. This port raises the
 * same public refusal with an equivalent message, because a future-format
 * artifact must never be reported as a corrupt one. The plugin only reaches
 * this port for an artifact the pristine reader would also have refused, and
 * every refusal is turned into the pristine refusal by the caller's fallback.
 */
function refuseForeignFormatVersion(parsed) {
  const { version, id } = parsed;
  if (typeof version !== "number" || version === SESSION_FORMAT_VERSION) return;
  const sessionId = typeof id === "string" ? id : String(id);
  throw new SessionFormatUnsupportedError(
    "session " + JSON.stringify(sessionId) + " has session format v" + version + ", which this build does not read",
  );
}

function fromHeaderLine(line) {
  return {
    meta: {
      version: SESSION_FORMAT_VERSION,
      id: line.id,
      createdAt: line.createdAt,
      ...(line.cwd !== undefined ? { cwd: line.cwd } : {}),
      ...(line.parentSession !== undefined ? { parentSession: line.parentSession } : {}),
      isSeeded: line.isSeeded,
      ...(line.origin !== undefined ? { origin: line.origin } : {}),
      delegationDepth: line.delegationDepth,
      ...(line.agentPreset !== undefined ? { agentPreset: line.agentPreset } : {}),
    },
    inheritedEventCount: 0,
  };
}

/** lib/index.js:970-996 — one complete newline-terminated header record. */
export function parseHeaderRecord(record) {
  if (record.length === 0 || record.at(-1) !== 10 || record.indexOf(10) !== record.length - 1) {
    throw new Error("empty or header-less session log");
  }
  let parsed;
  try {
    parsed = JSON.parse(record.subarray(0, -1).toString("utf8"));
  } catch {
    throw new Error("corrupt session log: header line is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("corrupt session log: first line is not a JSON object");
  }
  refuseForeignFormatVersion(parsed);
  assertNoRetiredHeaderFields(parsed);
  if (!isHeaderLine(parsed)) throw new Error("corrupt session log: first line is not a session header");
  let restore;
  try {
    restore = sessionFormatCatalog.createRestore(parsed, { recovery: "strict", validation: "transformed" });
  } catch {
    throw new Error("corrupt session log: first line is not a session header");
  }
  return { meta: fromHeaderLine(parsed).meta, restore };
}

/** lib/index.js:964-968 — the first frame must be exactly one header record. */
export function assertZstdHeaderFrame(plaintext) {
  if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1) {
    throw new Error("corrupt Zstandard session log: first frame is not exactly one header record");
  }
}

/* ------------------------------------------------------------------ */
/* port of the SessionLogScanner (lib/index.js:1003-1116)               */
/* ------------------------------------------------------------------ */

/**
 * The pristine scanner over one independently supplied header record and the
 * raw plaintext chunks that follow it.
 *
 * PORT NOTE: this port fixes recoverable mode to strict, and exposes the
 * decoder instead of sealing it. Both follow from what the plugin does with it:
 * it is only ever fed an artifact grown by whole, internally decodable frames,
 * so a row this port rejects is a row the pristine reader would also have
 * rejected on the next full parse — and a resident decoder must stay open to be
 * extended.
 *
 * The scanner is stateful across chunks by construction: a JSONL record may
 * span frames, and a decoder may reuse its output buffer after write() returns,
 * so a fragment crossing a frame boundary is copied.
 */
export class LiveLogReader {
  #committedBytes;
  #eventLine = 0;
  #fragments = [];
  #fragmentBytes = 0;
  #inputBytes;
  #meta;
  #restore;

  /** @param headerRecord - the complete first JSONL record, including its newline. */
  constructor(headerRecord) {
    const parsed = parseHeaderRecord(headerRecord);
    this.#meta = parsed.meta;
    this.#restore = parsed.restore;
    this.#inputBytes = headerRecord.length;
    this.#committedBytes = headerRecord.length;
  }

  get meta() {
    return this.#meta;
  }

  /** Plaintext bytes accepted, including a retained incomplete final record. */
  get inputBytes() {
    return this.#inputBytes;
  }

  /** Plaintext bytes through the end of the last complete event record. */
  get committedBytes() {
    return this.#committedBytes;
  }

  /**
   * Consume the next raw plaintext chunk, retaining only an incomplete final
   * record. Bytes immediately follow all previously supplied bytes.
   */
  write(chunk) {
    const chunkStart = this.#inputBytes;
    this.#inputBytes += chunk.length;
    let lineStart = 0;
    for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, lineStart)) {
      const fragment = chunk.subarray(lineStart, newline);
      let line = fragment;
      if (this.#fragments.length > 0) {
        if (fragment.length > 0) this.#fragments.push(fragment);
        line = Buffer.concat(this.#fragments, this.#fragmentBytes + fragment.length);
        this.#fragments = [];
        this.#fragmentBytes = 0;
      }
      this.#consume(line, chunkStart + newline + 1);
      lineStart = newline + 1;
    }
    if (lineStart < chunk.length) {
      const fragment = Buffer.from(chunk.subarray(lineStart));
      this.#fragments.push(fragment);
      this.#fragmentBytes += fragment.length;
    }
  }

  /**
   * The decoder's artifact. Idempotent: the format decoder returns its logical
   * event list, and a later write may extend it.
   */
  artifact() {
    return this.#restore.finish();
  }

  /** Decode one complete event row and advance the committed prefix. */
  #consume(line, endByte) {
    this.#eventLine += 1;
    let decoded;
    try {
      decoded = JSON.parse(line.toString("utf8"));
    } catch {
      throw new Error("corrupt session log: unparsable committed event at line " + this.#eventLine);
    }
    try {
      assertV4RowAdmission(decoded, undefined);
    } catch (error) {
      if (error instanceof SessionFormatUnsupportedMigrationError) throw new SessionFormatUnsupportedError(error.message);
      throw error;
    }
    try {
      this.#restore.decodeRow(decoded);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error("corrupt session log: invalid committed event at line " + this.#eventLine + ": " + detail, {
        cause: error,
      });
    }
    this.#committedBytes = endByte;
  }
}


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
import { constants, createZstdDecompress, zstdDecompressSync } from "node:zlib";
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

/** Output chunk size for the reused-context decoder; upstream's value. */
const DECODE_CHUNK_SIZE = 1024 * 1024;

/**
 * Upstream's private-shape probe, copied predicate for predicate.
 *
 * @returns the observed private contract, or undefined when this Node release does not
 *   expose it -- in which case callers must fall back to the public decoder.
 */
function privateZstdStream(stream) {
  const candidate = stream;
  const handle = candidate._handle;
  const errorKey = Reflect.ownKeys(stream).find((key) => typeof key === "symbol" && key.description === "kError");
  if (typeof handle !== "object" || handle === null || typeof handle.writeSync !== "function") return undefined;
  if (!(candidate._writeState instanceof Uint32Array) || candidate._writeState.length < 2) return undefined;
  if (typeof candidate._defaultFlushFlag !== "number") return undefined;
  if (errorKey === undefined || candidate[errorKey] !== null) return undefined;
  return { stream, errorKey };
}

/**
 * Synchronous multi-frame Zstandard decoder backed by ONE Node Zstd stream handle.
 *
 * PORT NOTE -- this is a deliberate departure from the public-only port that used to be
 * here, and it is the fix for a measured regression. Upstream's backend does not decode
 * frames with the one-shot API: its createZstdFrameDecoder() returns
 * `NodePrivateZstdFrameDecoder.create() ?? PublicZstdFrameDecoder`, i.e. it PREFERS a decoder
 * that reuses one native context across frames. The plugin's first port copied only the
 * public half, so its cold read paid a fresh native context per frame. Measured on a 62 MB
 * artifact with 16665 frames, interleaved rounds with gc forced between arms: 906 ms public
 * against 439 ms reused -- 2.07x -- and the cold read is exactly what a user triggers when
 * opening a session from history.
 *
 * Node exposes synchronous decoding only as a one-shot call, so context reuse has to go
 * through the stream's private handle contract. That contract is probed before use and the
 * public decoder is the fallback, so nothing here assumes the fast path exists.
 *
 * YIELDED BUFFERS ARE SCRATCH: the returned view is valid only until the next decodeFrame
 * call, exactly as upstream documents. decodeFrames() copies; a streaming caller must consume
 * each view before advancing.
 */
function createNodePrivateZstdFrameDecoder() {
  let stream;
  try {
    stream = createZstdDecompress({ chunkSize: DECODE_CHUNK_SIZE });
  } catch {
    return undefined;
  }
  const access = privateZstdStream(stream);
  if (access === undefined) {
    try { stream.close(); } catch { /* never opened */ }
    return undefined;
  }
  const output = Buffer.allocUnsafe(DECODE_CHUNK_SIZE);
  let decoderError;
  stream.on("error", (error) => {
    decoderError ??= error;
  });
  let started = false;
  let closed = false;
  return {
    /** Reported through zstdFrameDecoderKind so the SELECTION can be asserted, not inferred. */
    kind: "private",
    *decode(source, frames) {
      if (started) throw new Error("Zstandard frame decoder was already started");
      if (closed) throw new Error("cannot start a closed Zstandard frame decoder");
      started = true;
      try {
        for (const { start, end } of frames) {
          let decoded;
          try {
            decoded = decodePrivateFrame(access.stream, access.errorKey, output, () => decoderError, source.subarray(start, end));
          } catch (error) {
            throw new Error("corrupt Zstandard session log: frame at byte " + start + " failed validation", {
              cause: error,
            });
          }
          yield decoded;
        }
      } finally {
        closed = true;
        close();
      }
    },
    close() {
      closed = true;
      close();
    },
  };
  function close() {
    try { stream.close(); } catch { /* already closed */ }
  }
}

/** Decode one frame against a reused context; the returned view lasts until the next call. */
function decodePrivateFrame(stream, errorKey, output, readError, input) {
  const handle = stream._handle;
  /* v8 ignore next -- decode() rejects a closed decoder before entering this operation. */
  if (handle === null) throw new Error("cannot decode with a closed Zstandard frame decoder");
  let inputOffset = 0;
  let inputRemaining = input.length;
  let outputBytes = 0;
  const fullChunks = [];
  for (;;) {
    handle.writeSync(stream._defaultFlushFlag, input, inputOffset, inputRemaining, output, 0, output.length);
    const failure = readError();
    if (failure !== undefined) throw failure;
    const internalError = stream[errorKey];
    if (internalError !== null && internalError !== undefined) {
      if (internalError instanceof Error) throw internalError;
      throw new Error("Zstandard decoder exposed a non-Error internal failure");
    }
    const outputAfter = stream._writeState[0];
    const inputAfter = stream._writeState[1];
    const consumed = inputRemaining - inputAfter;
    const produced = output.length - outputAfter;
    if (produced > 0) outputBytes += produced;
    if (outputAfter !== 0) {
      // A frame's final partial chunk ends the frame: no trailing input may remain.
      if (inputAfter !== 0) throw new Error("Zstandard frame decoder left trailing input");
      const finalChunk = output.subarray(0, produced);
      if (fullChunks.length === 0) return finalChunk;
      if (produced > 0) fullChunks.push(Buffer.from(finalChunk));
      const onlyChunk = fullChunks[0];
      return fullChunks.length === 1 ? onlyChunk : Buffer.concat(fullChunks, outputBytes);
    }
    fullChunks.push(Buffer.from(output));
    inputOffset += consumed;
    inputRemaining = inputAfter;
  }
}

/** Multi-frame adapter built exclusively from Node's supported one-shot API. */
function createPublicZstdFrameDecoder() {
  let closed = false;
  return {
    /** Reported through zstdFrameDecoderKind so a fallback is observable rather than implied. */
    kind: "public",
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

/**
 * Frame decoder over an explicit frame list, ported from lib/index.js:1385-1386.
 *
 * PORT NOTE -- the selection order here is upstream's, and that is the point. An earlier
 * version of this port used the public one-shot decoder unconditionally, reasoning that it
 * was "the upstream-declared fallback for every Node release". Upstream's declaration is
 * narrower than that: it is the fallback used only WHEN the private shape probe fails.
 * Upstream's own line is `NodePrivateZstdFrameDecoder.create() ?? new PublicZstdFrameDecoder()`,
 * and on Node 26 the probe succeeds. Choosing the fallback unconditionally therefore made the
 * plugin slower than the backend it replaces on the cold path -- a measured 1.48x regression
 * on opening a session from history, which is exactly the case the plugin exists for.
 *
 * The private path is probed before use and never assumed; when the probe fails this returns
 * the public decoder and behaviour is exactly what it was.
 */
export function createZstdFrameDecoder() {
  const privateDecoder = createNodePrivateZstdFrameDecoder();
  if (privateDecoder !== undefined) return privateDecoder;
  return createPublicZstdFrameDecoder();
}

/**
 * The decoder implementation {@link createZstdFrameDecoder} selects on this runtime.
 *
 * Exported because the selection is otherwise INVISIBLE, and an invisible selection cannot be
 * tested. A gate check that compared the selected decoder's speed against the public one looked
 * like it verified the choice -- but forcing the public path made both sides the same code, so
 * they compared equal and the check passed while the optimization was absent. That is a
 * fake-green gate, and it is the reason this reports the choice directly instead of implying it.
 *
 * @returns "private" when the reused-context decoder is available, otherwise "public".
 */
export function zstdFrameDecoderKind() {
  // It MUST go through createZstdFrameDecoder. The first version called
  // createNodePrivateZstdFrameDecoder() directly, so it reported what was AVAILABLE rather than
  // what was SELECTED -- and forcing the selection onto the public path left it reporting
  // "private" with the check still green. Probing around the code under test is not testing it.
  const decoder = createZstdFrameDecoder();
  const kind = decoder.kind;
  decoder.close();
  return kind;
}

/**
 * Decode every frame in a frame list into fresh, owned plaintext buffers.
 *
 * The copy is mandatory, not defensive: the reused-context decoder hands back a scratch view
 * that the next frame overwrites, so a caller that kept the views would read one frame's
 * bytes as another's.
 */
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
  // An already-frozen root means the whole graph is frozen: the only code that
  // freezes event objects is the walk below, and it always freezes a graph in one
  // pass, so a frozen root cannot have unfrozen descendants. Without this the walk
  // is O(whole session) on every extension, because extension re-freezes events
  // that a previous extension already froze -- measured at 191 ms per turn on a
  // 60k-event log, growing with the session.
  if (Object.isFrozen(event)) return;
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


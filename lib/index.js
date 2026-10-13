/**
 * dsh-coldread-cache — keep an active session's stored log parsed.
 *
 * THE PROBLEM. The JSONL session backend memoizes at most
 * COLD_LOG_MEMO_MAX_ENTRIES = 2 parsed logs, keyed by a stat-derived revision,
 * and every local append changes that revision. A session that is being written
 * therefore misses the memo on essentially every read, and a miss is a full
 * cold parse of the whole artifact — readFile, zstd decode, and JSON.parse of
 * every row. Measured on real logs: 73 MB / 39.7k events costs ~2.4 s per read,
 * a 16 MB / 16k-event log ~0.6 s, and a live host with one long session open
 * was reading 846 MB in 30 s. That is the lag.
 *
 * THE FIX. This plugin keeps one resident, incrementally fed decoder per
 * session. A read that finds the artifact unchanged is answered from the
 * resident parse (one stat). A read that finds it grown hands only the new
 * frames to the resident decoder, which extends the event list it already
 * built. Measured: extending a resident 16k-event decoder by the frames a real
 * append added costs under a millisecond, against 576 ms to parse the same log
 * cold, and the extended artifact is deep-equal to a whole-file parse.
 *
 * WHY IT IS NOT A SOURCE PATCH. It installs by writing own properties onto the
 * live backend instance behind the persistence service handle, which is the
 * cordis service surface (see resolveReal). It is delivered as a plugin, loaded
 * from a profile patch row, re-installed on mount, and reverted on unmount, so
 * an app update can never leave the harness in a modified state.
 *
 * CORRECTNESS CONTRACT. The resident parse is reused only when the reuse is
 * provably equivalent to a full parse:
 *   1. same artifact (device and inode), same path;
 *   2. the artifact only grew, and the header frame's bytes are unchanged;
 *   3. every byte after the resident length is a whole, independently
 *      decodable zstd frame (a torn tail falls back);
 *   4. feeding those frames to the resident decoder adds rows and nothing else,
 *      and the format decoder's own relationships still hold;
 *   5. the new rows pass the same released-v4 row admission, the same stored
 *      event validation, and the same relationship assertions the pristine
 *      reader runs, and the read reports the revision it actually observed.
 * Anything unprovable falls back to the pristine reader unchanged, so the only
 * possible regression is a read that stays as slow as it is today.
 *
 * @module dsh-coldread-cache
 */
import { open } from "node:fs/promises";
import z from "@deepseek-ai/schemastery";
import { assertReleasedV4Relationships } from "@deepseek-ai/dsh-session-format-v3-to-v4";
import { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { assertStoredId, validateStoredEvents } from "@deepseek-ai/dsh-session-persistence";
import {
  LiveLogReader,
  assertZstdHeaderFrame,
  decodeFrames,
  fileRevisionFromIdentity,
  freezeStoredEvent,
  revisionBytes,
  scanZstdFrames,
  statIdentity,
} from "./pristine.js";

/** The plugin id; also the profile patch row id. */
export const name = "dsh-coldread-cache";

/**
 * Bounds on how much source log one process keeps decoded at once. The pristine
 * backend's own two-entry memo is left exactly as it is; this budget is the
 * plugin's own, and it is what keeps residency from growing without limit.
 *
 * The budget is in SOURCE bytes, which is what the code can reason about, but the
 * cost it buys is heap: a parsed log is JS objects and arrays, measured at about
 * 8x its compressed size (202 MB of artifacts -> 1207 MB of heap), so 128 MB of
 * budget is roughly 1 GB of heap.
 *
 * It is tempting to shrink this, and measurement says not to. The extension path --
 * the one that removes the lag, by serving an append's read from the resident parse
 * instead of re-decoding the whole log -- already works with 16 MB, because a
 * written session is ranked ahead of read-only ones. What the budget beyond that
 * buys is residency for the sessions a host merely READS: browsing history, the
 * session list, switching between sessions. Measured on real artifacts with one
 * session being written and four read:
 *
 *   budget   resident   residency hit rate
 *   16 MB    35 MB      14%
 *   32 MB    35 MB      14%
 *   64 MB    35 MB      14%
 *   128 MB   99 MB      53%
 *   256 MB   167 MB     93%
 *
 * So the default stays where it was: it is the smallest budget that serves a real
 * working set, and lowering it would trade a measured regression for a memory
 * saving that is not the bottleneck. Raise it on a machine with room to spare.
 */
/**
 * The defaults, in one place.
 *
 * These are read by the schema AND by the install path, and those two used to carry
 * independent literals. They drifted during development -- the schema said 128 MB
 * while the fallback still said 32 MB -- so a caller that passed no config got a
 * budget that measurement had already shown to be a regression, while the schema
 * advertised the good one. One constant cannot drift from itself.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  maxEntries: 8,
  maxResidentBytes: 128 * 1024 * 1024,
  statusFile: "",
});

export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  maxEntries: z.number().default(DEFAULTS.maxEntries),
  maxResidentBytes: z.number().default(DEFAULTS.maxResidentBytes),
  statusFile: z.string().default(DEFAULTS.statusFile),
});

/** The service this plugin attaches to, so the fiber waits for its mount. */
export const inject = ["sessionPersistence"];

const TRACKER = Symbol.for("cordis.tracker");
const ORIGINAL = Symbol.for("cordis.original");
const OWNERSHIP = Symbol.for("dsh.coldread-cache.ownership");
const REPLACED = ["readStoredLog", "decodeStoredLog", "persistBatch", "persistHeader", "truncateTornTail"];

/**
 * The backend members this plugin CALLS but does not replace.
 *
 * `REPLACED` covers what gets patched; these are the helpers the patched code reaches
 * for while serving a read. They are listed separately because a backend can expose
 * every patch point and still be unusable -- and the failure mode is different: a
 * missing patch point means "do not install", while a missing helper means the
 * replacement would throw from inside a read path it cannot recover from.
 *
 * Verified against both installed DSH versions (0.2.0-rc.2 and 0.2.1-alpha.2) by
 * `pnpm run compat`, which runs the whole attach-and-extend cycle against each tree.
 */
const REQUIRED_MEMBERS = ["assertStoredIdentity", "locate", "memoizeStoredLog"];

/**
 * Why an install was refused, in the deployment's own words.
 *
 * A backend that moved must degrade to the pristine reader with a reason a human can
 * act on, not half-patch and fail later. "Which DSH am I actually running" is the first
 * question such a failure raises, so the backend's own version is included when it
 * reports one -- the installed `session-persistence-jsonl` does not (its `version` is
 * undefined), so in practice the message names the service and the missing members.
 */
function incompatible(real, missing, kind) {
  const version = typeof real?.version === "string" ? " (backend " + real.version + ")" : "";
  return kind + " missing on " + String(real?.name ?? "backend") + version + ": " + missing.join(", ");
}
const HEADER_PROBE_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ */
/* reaching the live backend instance                                   */
/* ------------------------------------------------------------------ */

/**
 * Resolve the real backend instance behind a persistence service handle.
 *
 * A cordis service handle is a traceable Proxy: reading a method off it yields
 * a fresh shadow-bound wrapper, so a patch written through the handle would not
 * be observable and an identity check against it would never be true. The
 * handle's own Symbol.for('cordis.original') IS the instance the backend's
 * methods run on, and that is where a patch has to land.
 *
 * @param ctx - the installing context, used as a fallback lookup.
 * @param service - the service handle to unwrap.
 * @returns the instance to patch, or undefined when none can be proven.
 */
export function resolveReal(ctx, service) {
  const asInstance = (value) => (value !== null && typeof value === "object" ? value : undefined);
  const direct = asInstance(service?.[ORIGINAL]);
  if (direct !== undefined) return direct;
  try {
    const viaContext = asInstance(ctx?.get?.("sessionPersistence")?.[ORIGINAL]);
    if (viaContext !== undefined) return viaContext;
  } catch {
    /* a lookup that throws is simply not a resolution */
  }
  try {
    const internal = asInstance(ctx?.reflect?.get?.("sessionPersistence", false));
    if (internal !== undefined) return internal;
  } catch {
    /* a lookup that throws is simply not a resolution */
  }
  // Last resort for a caller that hands over a plain instance: accept it only
  // when it carries no cordis tracker, because a tracked object without an
  // original is a proxy and patching a proxy changes nothing.
  if (asInstance(service) !== undefined && service[TRACKER] === undefined) return service;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* the resident parse                                                   */
/* ------------------------------------------------------------------ */

/**
 * One resident decoded log.
 *
 * \`reader\` holds the format decoder and therefore the only state that makes an
 * incremental read possible; \`events\` is the frozen snapshot a read returns,
 * which is kept separate on purpose — the pristine backend freezes the array it
 * decodes into, and that would permanently stop the decoder from being extended.
 */
class Resident {
  constructor(fields) {
    Object.assign(this, fields);
  }
}

const REASON = {
  noEntry: "no-entry",
  pathChanged: "path-changed",
  otherFile: "different-file",
  shrank: "artifact-shrank",
  tornTail: "torn-tail",
  emptyTail: "empty-tail",
  headerChanged: "header-frame-changed",
  badTail: "undecodable-tail",
  badRow: "rejected-row",
  noGrowth: "no-new-events",
  oversize: "tail-too-large",
  failed: "read-failed",
};

class ColdReadCache {
  #bytes = 0;
  #chains = new Map();
  #entries = new Map();
  #limitBytes;
  #maxBytes;
  #maxEntries;
  #enabled;
  #log;
  /** Monotonic count of observed appends, used to rank entries for eviction. */
  #writes = 0;
  /** Session id -> its last write rank, for sessions not currently resident. */
  #hot = new Map();
  /** Last heap reading, so the residency's real cost can be estimated live. */
  #lastHeap = 0;
  /** Measured heap per resident source byte, refined by every cold parse. */
  #heapRatio = 6;

  constructor({ enabled, log, maxEntries, maxResidentBytes }) {
    this.#enabled = enabled !== false;
    this.#log = typeof log === "function" ? log : () => {};
    this.#maxEntries = Math.max(1, Math.floor(maxEntries));
    this.#maxBytes = Math.max(1, Math.floor(maxResidentBytes));
    this.#limitBytes = this.#maxBytes;
    this.stats = { hits: 0, extensions: 0, coldParses: 0, fallbacks: 0, reasons: Object.create(null) };
  }

  get size() {
    return this.#entries.size;
  }

  get bytes() {
    return this.#bytes;
  }

  /** The configured source-byte budget, reported so a misconfiguration is visible. */
  get maxBytes() {
    return this.#maxBytes;
  }

  /** The configured entry budget, reported for the same reason. */
  get maxEntries() {
    return this.#maxEntries;
  }

  get enabled() {
    return this.#enabled;
  }

  /** How many sessions are ranked as being written, for the status document. */
  get hotCount() {
    return this.#hot.size;
  }

  /** Measured heap per resident source byte, as last sampled. */
  get heapRatio() {
    return this.#heapRatio;
  }

  /**
   * Which sessions are resident, least recently used first.
   *
   * This is the question a status file has to be able to answer. When the counters
   * showed zero extensions against hundreds of reads, the missing piece was simply
   * not knowing WHICH session was resident -- so the one being written could not be
   * told apart from a bystander that had just been read. Ids are truncated to stay
   * readable.
   */
  get residentIds() {
    const out = [];
    for (const id of this.#entries.keys()) out.push(id.slice(0, 12));
    return out;
  }

  /** Sessions ranked as being written, most recent first. */
  get hotIds() {
    const ranked = [...this.#hot].sort((a, b) => b[1] - a[1]);
    return ranked.slice(0, 8).map(([id]) => id.slice(0, 12));
  }

  /**
   * Refine the heap-per-source-byte estimate from a real cold parse.
   *
   * This is an estimate, not a measurement, and it is reported as such. Without a
   * forced GC, heapUsed reflects allocation since the last collection, so a single
   * sample can be far too high (the collector has not run) or near zero (it just
   * ran). Samples are therefore taken only when they land in a plausible band for
   * a parsed JSON log, and the first sample is used only to establish a baseline.
   * The default stands until real samples justify moving it.
   */
  #sampleHeap(bytes) {
    const heap = process.memoryUsage?.().heapUsed;
    if (!Number.isFinite(heap) || bytes <= 0) return;
    const previous = this.#lastHeap;
    this.#lastHeap = heap;
    // The first sample has no baseline to subtract, so it can only mislead.
    if (previous === 0 || heap <= previous) return;
    const ratio = (heap - previous) / bytes;
    // A parsed log is JS objects: below 0.5x the collector clearly ran mid-parse,
    // and above 20x the growth is something other than this parse.
    if (ratio < 0.5 || ratio > 20) return;
    this.#heapRatio = this.#heapRatio * 0.7 + ratio * 0.3;
  }

  reject(reason) {
    this.stats.fallbacks += 1;
    this.stats.reasons[reason] = (this.stats.reasons[reason] ?? 0) + 1;
  }

  get(id) {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    return entry;
  }

  drop(id) {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    this.#entries.delete(id);
    this.#bytes -= entry.size;
    void entry;
  }

  clear() {
    this.#entries.clear();
    this.#chains.clear();
    this.#hot.clear();
    this.#bytes = 0;
    this.#writes = 0;
  }

  /** Serialize mutating work per session, so two readers cannot interleave. */
  #serial(id, work) {
    const previous = this.#chains.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.#chains.set(
      id,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  /** One stat-fresh resident snapshot, or undefined to keep going. */
  hit(entry, revision) {
    if (!this.#enabled) return undefined;
    if (entry === undefined) return undefined;
    if (entry.revision !== revision) return undefined;
    this.stats.hits += 1;
    return entry.stored;
  }

  /**
   * Serve one read from the resident parse.
   *
   * @param path - the artifact the caller selected.
   * @param expectedId - the session identity the artifact must carry.
   * @param revision - the revision of the artifact the caller observed.
   * @param size - the artifact's byte size.
   * @param source - "file" to read the new bytes, or the caller's buffer.
   * @param signal - optional cancellation.
   * @returns the pristine-shaped stored log, or undefined to fall back.
   */
  serve(path, expectedId, revision, size, source, signal) {
    if (!this.#enabled) {
      this.reject(REASON.noEntry);
      return Promise.resolve(undefined);
    }
    const entry = this.get(expectedId);
    if (entry === undefined) {
      this.reject(REASON.noEntry);
      return Promise.resolve(undefined);
    }
    if (entry.path !== path) {
      this.drop(expectedId);
      this.reject(REASON.pathChanged);
      return Promise.resolve(undefined);
    }
    const parts = String(revision).split(":");
    if (parts.length < 5) {
      this.reject(REASON.otherFile);
      return Promise.resolve(undefined);
    }
    if (parts[0] !== entry.dev || parts[1] !== entry.ino) {
      this.drop(expectedId);
      this.reject(REASON.otherFile);
      return Promise.resolve(undefined);
    }
    const hit = this.hit(entry, revision);
    if (hit !== undefined) return Promise.resolve(hit);
    if (size <= entry.size) {
      this.reject(REASON.shrank);
      return Promise.resolve(undefined);
    }
    if (size - entry.size > this.#limitBytes) {
      this.reject(REASON.oversize);
      return Promise.resolve(undefined);
    }
    return this.#serial(expectedId, () => this.#grow(entry, path, expectedId, revision, size, source, signal));
  }

  /** Read the artifact's new bytes and merge them into the resident parse. */
  async #grow(entry, path, expectedId, revision, size, source, signal) {
    let handle;
    try {
      signal?.throwIfAborted();
      let tail;
      if (Buffer.isBuffer(source)) {
        if (source.length !== size) {
          this.reject(REASON.emptyTail);
          return undefined;
        }
        if (!source.subarray(0, entry.headerEnd).equals(entry.headerBytes)) {
          this.drop(expectedId);
          this.reject(REASON.headerChanged);
          return undefined;
        }
        tail = source.subarray(entry.size);
      } else {
        handle = await open(path, "r");
        const headerNow = Buffer.allocUnsafe(entry.headerEnd);
        await handle.read(headerNow, 0, entry.headerEnd, 0);
        if (!headerNow.equals(entry.headerBytes)) {
          this.drop(expectedId);
          this.reject(REASON.headerChanged);
          return undefined;
        }
        const length = size - entry.size;
        tail = Buffer.allocUnsafe(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(tail, filled, length - filled, entry.size + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        if (filled !== length) {
          this.reject(REASON.emptyTail);
          return undefined;
        }
      }
      signal?.throwIfAborted();
      return this.#merge(entry, path, expectedId, tail, revision, size);
    } catch (error) {
      this.reject(REASON.failed);
      this.#log("grow failed: " + describe(error));
      return undefined;
    } finally {
      if (handle !== undefined) await handle.close().catch(() => {});
    }
  }

  /** Decode, admit, and validate exactly the bytes the artifact gained. */
  #merge(entry, path, expectedId, tail, revision, size) {
    let frames;
    let tornStart;
    try {
      const scanned = scanZstdFrames(tail);
      frames = scanned.frames;
      tornStart = scanned.tornStart;
    } catch (error) {
      this.reject(REASON.badTail);
      this.#log("tail scan failed: " + describe(error));
      return undefined;
    }
    if (tornStart !== undefined) {
      // An interrupted append. The resident bytes are untouched, so the entry
      // survives, but recovery needs the pristine reader's torn-tail handling.
      this.reject(REASON.tornTail);
      return undefined;
    }
    if (frames.length === 0) {
      this.reject(REASON.emptyTail);
      return undefined;
    }
    let chunks;
    try {
      chunks = decodeFrames(tail, frames);
    } catch (error) {
      this.reject(REASON.badTail);
      this.#log("tail frame failed: " + describe(error));
      return undefined;
    }
    let artifact;
    try {
      for (const chunk of chunks) entry.reader.write(chunk);
      artifact = entry.reader.artifact();
    } catch (error) {
      // The decoder consumed part of the tail before refusing, so its position
      // no longer matches the resident length. The entry cannot be trusted.
      this.drop(expectedId);
      this.reject(REASON.badRow);
      this.#log("tail row refused: " + describe(error));
      return undefined;
    }
    const count = artifact.events.length;
    if (count <= entry.artifactCount) {
      this.drop(expectedId);
      this.reject(REASON.noGrowth);
      return undefined;
    }
    const inheritedEventCount = artifact.inheritedEventCount;
    const fresh = artifact.events.slice(entry.artifactCount);
    const events =
      inheritedEventCount === entry.inheritedEventCount ? entry.events.concat(fresh) : fresh.slice();
    try {
      validateStoredEvents(entry.meta, fresh, { kind: "jsonl", path });
      assertReleasedV4Relationships(
        { header: entry.meta, inheritedEventCount, events },
        KNOWN_SESSION_EVENT_TYPES,
      );
    } catch (error) {
      this.drop(expectedId);
      this.reject(REASON.badRow);
      this.#log("merged artifact refused: " + describe(error));
      return undefined;
    }
    // Only the appended events are new. The resident ones were frozen when they
    // first arrived (by a cold parse or an earlier extension) and are still the
    // same objects, so re-walking them is pure waste -- and it is waste that grows
    // with the session, on the one path a host takes every turn. The deep-frozen
    // invariant is asserted by the gate, which is what makes this safe to rely on.
    for (const event of fresh) freezeStoredEvent(event);
    Object.freeze(events);
    const stored = {
      status: "current",
      meta: entry.meta,
      inheritedEventCount,
      tornTruncateTo: undefined,
      recoveredTail: [],
      eventState: "shared-frozen",
      events,
      revision,
    };
    this.#commit(entry, stored, revision, size);
    this.stats.extensions += 1;
    return stored;
  }

  #commit(entry, stored, revision, size) {
    this.#bytes -= entry.size;
    entry.revision = revision;
    entry.size = size;
    entry.stored = stored;
    entry.events = stored.events;
    entry.artifactCount = stored.events.length;
    entry.inheritedEventCount = stored.inheritedEventCount;
    this.#bytes += size;
    this.get(entry.id);
    this.#evict();
  }

  /**
   * Decode one artifact cold, keeping the decoder alive as the resident parse.
   *
   * This is the pristine decodeStoredLog with one difference: the decoder is
   * not thrown away. The validations and the memo publication are the backend's
   * own methods, so a refusal here is the backend's own refusal, and any doubt
   * about the parse itself is handed to the pristine reader, which produces the
   * backend's own error for it.
   *
   * @returns the pristine-shaped stored log, or the sentinel \`unparsed\` when
   *   the pristine reader must handle the artifact itself.
   */
  async coldRead(path, expectedId, buffer, revision, signal, backend) {
    if (!this.#enabled) return unparsed;
    if (revisionBytes(revision) !== buffer.length) return unparsed;
    let reader;
    let scanned;
    try {
      // One scan, reused below for the frame list this entry records: the scan is
      // a full pass over every byte, and the cold path is the one that runs on
      // every append-and-read cycle.
      scanned = scanZstdFrames(buffer);
      if (scanned.tornStart !== undefined || scanned.frames.length < 2) return unparsed;
      const chunks = decodeFrames(buffer, scanned.frames);
      assertZstdHeaderFrame(chunks[0]);
      reader = new LiveLogReader(chunks[0]);
      for (let index = 1; index < chunks.length; index += 1) reader.write(chunks[index]);
      if (reader.committedBytes !== reader.inputBytes) {
        throw new Error("corrupt Zstandard session log: complete frame contains a torn JSONL record");
      }
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      this.#log("cold parse deferred to the backend: " + describe(error));
      return unparsed;
    }
    let artifact;
    try {
      artifact = reader.artifact();
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      this.#log("cold artifact deferred to the backend: " + describe(error));
      return unparsed;
    }
    const events = artifact.events.slice();
    try {
      signal?.throwIfAborted();
      await backend.assertStoredIdentity(path, SESSION_FORMAT_VERSION, reader.meta, expectedId, signal);
      signal?.throwIfAborted();
      assertStoredId(expectedId, reader.meta);
      validateStoredEvents(reader.meta, events, backend.locate(reader.meta));
      assertReleasedV4Relationships(
        { header: reader.meta, inheritedEventCount: artifact.inheritedEventCount, events },
        KNOWN_SESSION_EVENT_TYPES,
      );
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      this.#log("cold validation deferred to the backend: " + describe(error));
      return unparsed;
    }
    for (const event of events) freezeStoredEvent(event);
    Object.freeze(events);
    const stored = {
      status: "current",
      meta: reader.meta,
      inheritedEventCount: artifact.inheritedEventCount,
      tornTruncateTo: undefined,
      recoveredTail: [],
      eventState: "shared-frozen",
      events,
      revision,
    };
    this.set(
      new Resident({
        id: expectedId,
        path,
        dev: String(revision).split(":")[0],
        ino: String(revision).split(":")[1],
        size: buffer.length,
        revision,
        headerEnd: scanned.frames[0].end,
        headerBytes: Buffer.from(buffer.subarray(0, scanned.frames[0].end)),
        meta: reader.meta,
        reader,
        stored,
        events,
        artifactCount: events.length,
        inheritedEventCount: stored.inheritedEventCount,
        writes: this.#hot.get(expectedId),
      }),
    );
    this.stats.coldParses += 1;
    this.#sampleHeap(buffer.length);
    backend.memoizeStoredLog(expectedId, stored);
    return stored;
  }

  /** Adopt an entry for one freshly parsed stored log, if it can be reused. */
  set(entry) {
    const previous = this.#entries.get(entry.id);
    if (previous !== undefined) this.#bytes -= previous.size;
    entry.writes = this.#hot.get(entry.id);
    this.#entries.delete(entry.id);
    this.#entries.set(entry.id, entry);
    this.#bytes += entry.size;
    this.#evict();
  }

  /**
   * Evict down to the budget, keeping the sessions that are being written.
   *
   * Read recency alone is the wrong order here. A bystander read is a cold parse,
   * and a cold parse calls {@link set}, which makes that bystander the most
   * recently used entry — so a busy session list would push out the one session
   * whose resident parse is about to be extended. Measured on a real host: 85
   * minutes of use, 405 reads served from residency, and zero extensions, because
   * every append found its entry already evicted.
   *
   * A session that has been appended to is therefore kept ahead of one that has
   * only been read. Among equals the least recently read goes first, and the last
   * entry is never evicted, so a single-session host always keeps its resident
   * parse.
   */
  #evict() {
    while (this.#entries.size > 1 && (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes)) {
      let victim;
      for (const [id, entry] of this.#entries) {
        if (entry.writes !== undefined) continue;
        victim = id;
        break;
      }
      if (victim === undefined) {
        // Every entry is being written. Drop the least recently written, which is
        // the one least likely to be extended next.
        let oldestWrites = Number.POSITIVE_INFINITY;
        for (const [id, entry] of this.#entries) {
          const writes = entry.writes ?? 0;
          if (writes < oldestWrites) {
            oldestWrites = writes;
            victim = id;
          }
        }
      }
      if (victim === undefined) break;
      // Never evict the entry a read is about to extend when it is the only one.
      if (this.#entries.size === 1) break;
      this.drop(victim);
    }
  }

  /**
   * Note that a session was appended to, so its resident parse is worth keeping.
   *
   * Called from the write hooks. The count is monotonic, so "most recently
   * written" stays comparable across the whole process.
   */
  noteWrite(id) {
    if (typeof id !== "string" || id.length === 0) return;
    this.#writes += 1;
    this.#hot.set(id, this.#writes);
    const entry = this.#entries.get(id);
    if (entry !== undefined) entry.writes = this.#writes;
    // The map is bounded by the session count a process can plausibly write in
    // one run, but a very long run would grow it without limit, so trim to the
    // same order as the entry budget.
    if (this.#hot.size > this.#maxEntries * 8) {
      const cutoff = this.#writes - this.#maxEntries * 8;
      for (const [key, writes] of this.#hot) {
        if (writes < cutoff) this.#hot.delete(key);
      }
    }
  }
}

/** Sentinel: this cache cannot answer, the pristine reader must. */
const unparsed = Symbol("dsh-coldread-cache.unparsed");

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* installation                                                         */
/* ------------------------------------------------------------------ */

function install(ctx, real, config) {
  const warned = { count: 0 };
  const cache = new ColdReadCache({
    enabled: config.enabled,
    maxEntries: config.maxEntries,
    maxResidentBytes: config.maxResidentBytes,
    log: (message) => {
      // A fast path that silently stops working is worse than no fast path, so
      // the first few reasons are reported and the rest are counted.
      if (warned.count >= 5) return;
      warned.count += 1;
      try {
        ctx?.logger?.warn?.("coldread-cache: " + message);
      } catch {
        /* logging must never be the failure */
      }
    },
  });

  const originals = Object.create(null);
  const patched = Object.create(null);
  const failures = Object.create(null);

  originals.readStoredLog = real.readStoredLog;
  patched.readStoredLog = async function readStoredLog(path, expectedId, signal) {
    try {
      signal?.throwIfAborted();
      const identity = await statIdentity(path);
      const revision = fileRevisionFromIdentity(identity);
      const served = await cache.serve(path, expectedId, revision, Number(identity.size), "file", signal);
      if (served !== undefined) return served;
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
    }
    return originals.readStoredLog.call(real, path, expectedId, signal);
  };

  originals.decodeStoredLog = real.decodeStoredLog;
  patched.decodeStoredLog = async function decodeStoredLog(path, expectedId, buffer, revision, signal) {
    try {
      signal?.throwIfAborted();
      const served = await cache.serve(path, expectedId, revision, buffer.length, buffer, signal);
      if (served !== undefined) return served;
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      try {
        cache.reject(REASON.failed);
      } catch {
        /* counting must never be the failure */
      }
    }
    const cold = await cache.coldRead(path, expectedId, buffer, revision, signal, real);
    if (cold !== unparsed) return cold;
    return originals.decodeStoredLog.call(real, path, expectedId, buffer, revision, signal);
  };

  originals.persistBatch = real.persistBatch;
  patched.persistBatch = function persistBatch(header, events, isMaterialized, inheritedEventCount) {
    // Rank this session as being written BEFORE the write settles, so the entry
    // it will extend is protected from the bystander reads that follow. This is
    // every append, not only the materializing one: an append to an existing
    // session arrives with isMaterialized true.
    cache.noteWrite(header?.id);
    const promise = originals.persistBatch.call(real, header, events, isMaterialized, inheritedEventCount);
    promise.then(
      // A materializing write publishes a brand-new artifact, so every byte
      // offset the resident parse reasons about is void. An append keeps the
      // entry: the resident bytes are still a prefix of the artifact, and the
      // next read extends from the bytes it gained.
      () => {
        if (!isMaterialized) cache.drop(header?.id);
      },
      // A failed append is rolled back to the previous size, but a rollback can
      // itself fail, so the entry stops being provably a prefix.
      () => cache.drop(header?.id),
    );
    return promise;
  };

  originals.persistHeader = real.persistHeader;
  patched.persistHeader = function persistHeader(header, inheritedEventCount) {
    cache.noteWrite(header?.id);
    const promise = originals.persistHeader.call(real, header, inheritedEventCount);
    promise.then(
      () => cache.drop(header?.id),
      () => cache.drop(header?.id),
    );
    return promise;
  };

  originals.truncateTornTail = real.truncateTornTail;
  patched.truncateTornTail = function truncateTornTail(header, truncateTo) {
    const promise = originals.truncateTornTail.call(real, header, truncateTo);
    promise.then(
      // Truncating away bytes the resident parse already covers changes those
      // bytes' meaning, so the entry goes. Truncating only bytes beyond them
      // leaves the resident parse a valid prefix.
      () => {
        const entry = cache.get(header?.id);
        if (entry === undefined || Number(truncateTo) < entry.size) cache.drop(header?.id);
      },
      () => cache.drop(header?.id),
    );
    return promise;
  };

  // Probe the instance before writing anything: a backend whose shape moved
  // must not be half-patched. This reads the live instance, it does not guess.
  for (const key of REPLACED) {
    if (typeof originals[key] !== "function") failures[key] = "not-a-function";
  }
  // The helpers the replacements call are part of the contract too. Checking them here
  // is what turns "this DSH version is not supported" into a refusal at mount time
  // instead of a TypeError from inside somebody else's read.
  const missingHelpers = REQUIRED_MEMBERS.filter((key) => typeof real[key] !== "function");
  if (missingHelpers.length > 0) failures.required = incompatible(real, missingHelpers, "helpers");
  if (Object.keys(failures).length > 0) {
    return { cache, real, originals, patched, failures, installed: [], dispose: () => {} };
  }

  const installed = [];
  const inherited = Object.create(null);
  for (const key of REPLACED) {
    try {
      // Remember where the original came from: a method inherited from the
      // prototype must be restored by removing the own property, because
      // assigning the original back would leave an own property shadowing it.
      inherited[key] = !Object.hasOwn(real, key);
      real[key] = patched[key];
      if (real[key] !== patched[key]) {
        failures[key] = "not-own-property";
        delete real[key];
      } else {
        installed.push(key);
      }
    } catch (error) {
      failures[key] = describe(error);
    }
  }

  const startedAt = Date.now();
  const status = {
    plugin: name,
    // Mount time, deliberately distinct from the heartbeat below: a status file
    // whose heartbeat has stopped is stale, and reporting one timestamp for both
    // makes a dead plugin look alive.
    mountedAt: new Date(startedAt).toISOString(),
    pid: process.pid,
    backend: String(real.name),
    installed,
    failures,
  };
  const snapshot = () => ({
    ...status,
    at: new Date().toISOString(),
    uptimeMs: Date.now() - startedAt,
    stats: { ...cache.stats, reasons: { ...cache.stats.reasons } },
    resident: {
      entries: cache.size,
      bytes: cache.bytes,
      // Source bytes are the budget unit; heap is the bill. The ratio is sampled
      // from real cold parses, so the cost is reported rather than implied.
      heapEstimateBytes: Math.round(cache.bytes * cache.heapRatio),
      heapRatio: Number(cache.heapRatio.toFixed(1)),
      hot: cache.hotCount,
      // Least recently used first, and which sessions are ranked as written: without
      // these, a status file cannot distinguish "the written session is resident"
      // from "only bystanders are", which is the difference that matters.
      ids: cache.residentIds,
      hotIds: cache.hotIds,
      // The budget, and whether residency is actually able to hold a working set.
      // A budget smaller than one session degenerates residency to a single entry:
      // every read of a different session evicts the last, so the append-then-read
      // path never finds its entry. That misconfiguration is invisible in a byte
      // count but obvious here, and it is exactly what a real host was running when
      // its counters showed zero extensions against hundreds of reads.
      maxBytes: cache.maxBytes,
      maxEntries: cache.maxEntries,
      overBudget: cache.bytes > cache.maxBytes,
    },
  });
  writeStatus(config.statusFile, snapshot);
  // Keep the document live: a status file that only exists at mount time cannot
  // tell a running deployment whether the fast path is actually serving reads.
  let heartbeat;
  if (config.statusFile) {
    heartbeat = setInterval(() => writeStatus(config.statusFile, snapshot), 2000);
    heartbeat.unref?.();
  }

  const dispose = () => {
    for (const key of installed) {
      try {
        if (real[key] !== patched[key]) {
          failures[key] = "replaced-by-someone-else";
          continue;
        }
        if (inherited[key]) delete real[key];
        else real[key] = originals[key];
      } catch (error) {
        failures[key] = describe(error);
      }
    }
    cache.clear();
    if (heartbeat !== undefined) clearInterval(heartbeat);
  };

  return { cache, real, originals, patched, failures, installed, dispose, status };
}

/**
 * Write the plugin's status document, when the deployment asked for one.
 *
 * A plugin that silently stops working is worse than one that never worked, and
 * this file is how a deployment can see which hooks a running host actually
 * installed. It is opt-in: no path means no file.
 */
function writeStatus(path, build) {
  if (typeof path !== "string" || path.length === 0) return;
  try {
    const document = build();
    void import("node:fs/promises")
      .then((fs) => fs.writeFile(path, JSON.stringify(document, null, 2) + "\n"))
      .catch(() => {});
  } catch {
    /* diagnostics must never be the failure */
  }
}

/**
 * Attach to one persistence service handle.
 *
 * Exported because it is the whole plugin: the loader calls {@link apply}, and a
 * test can call this directly to drive the real backend without mounting a
 * profile.
 *
 * @param ctx - the context to install effects on.
 * @param service - the persistence service handle.
 * @param config - resolved plugin configuration.
 * @returns a disposer that restores the instance, or undefined when there is
 *   nothing to attach to.
 */
export function applyToService(ctx, service, config = {}) {
  const real = resolveReal(ctx, service);
  if (real === undefined) return undefined;
  const existing = OWNERS.get(real) ?? real[OWNERSHIP];
  if (existing !== undefined) {
    existing.refs += 1;
    return () => {
      existing.refs -= 1;
      if (existing.refs === 0) existing.dispose();
    };
  }
  const state = install(ctx, real, {
    enabled: config.enabled !== false,
    maxEntries: Number.isFinite(config.maxEntries) ? config.maxEntries : DEFAULTS.maxEntries,
    maxResidentBytes: Number.isFinite(config.maxResidentBytes)
      ? config.maxResidentBytes
      : DEFAULTS.maxResidentBytes,
    statusFile: typeof config.statusFile === "string" ? config.statusFile : DEFAULTS.statusFile,
  });
  state.refs = 1;
  const dispose = state.dispose;
  state.dispose = () => {
    dispose();
    writeStatus(config.statusFile, () => ({
      ...state.status,
      disposedAt: new Date().toISOString(),
      stats: { ...state.cache.stats, reasons: { ...state.cache.stats.reasons } },
    }));
    OWNERS.delete(real);
    try {
      delete real[OWNERSHIP];
    } catch {
      /* a frozen instance would have refused the install too */
    }
  };
  OWNERS.set(real, state);
  try {
    real[OWNERSHIP] = state;
  } catch {
    /* the WeakMap is the registry; the symbol is only for inspection */
  }
  const failed = Object.keys(state.failures);
  try {
    const logger = ctx?.logger;
    if (failed.length > 0) {
      logger?.warn?.("coldread-cache: not installed on " + String(real.name) + ": " + JSON.stringify(state.failures));
    } else {
      logger?.info?.("coldread-cache: active on " + String(real.name) + " (" + state.installed.join(", ") + ")");
    }
  } catch {
    /* logging must never be the failure */
  }
  return () => {
    state.refs -= 1;
    if (state.refs === 0) state.dispose();
  };
}

/** Per-instance ownership, so two plugin instances attach instead of stacking. */
const OWNERS = new WeakMap();

/**
 * Plugin entry.
 *
 * @param ctx - the plugin context.
 * @param rawConfig - plugin configuration, already resolved by {@link Config}.
 * @returns a disposer.
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {};
  const attach = (service) => {
    try {
      return applyToService(ctx, service, config);
    } catch (error) {
      try {
        ctx?.logger?.warn?.("coldread-cache: install failed: " + describe(error));
      } catch {
        /* logging must never be the failure */
      }
      return undefined;
    }
  };
  const disposers = [];
  const mounted = attach(ctx.get("sessionPersistence"));
  if (mounted !== undefined) disposers.push(mounted);
  else {
    // The service may mount after this plugin. Registering on the service
    // announcement keeps the plugin working under either mount order, and the
    // ownership registry makes a second delivery a no-op.
    const off = ctx.on("internal/service", (serviceName, value) => {
      if (serviceName !== "sessionPersistence" || value === undefined) return;
      const disposer = attach(value);
      if (disposer !== undefined) disposers.push(disposer);
    });
    disposers.push(typeof off === "function" ? off : () => {});
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        /* a failed disposer must not stop the rest */
      }
    }
  };
}

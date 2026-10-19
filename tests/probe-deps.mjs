import z from "@deepseek-ai/schemastery";
import * as sf from "@deepseek-ai/dsh-session-format";
import * as cat from "@deepseek-ai/dsh-session-format-catalog";
import * as v34 from "@deepseek-ai/dsh-session-format-v3-to-v4";
import * as sp from "@deepseek-ai/dsh-session-persistence";
import * as sj from "@deepseek-ai/dsh-session";
import * as jl from "@deepseek-ai/dsh-session-persistence-jsonl";
import { join } from "node:path";
console.log("schemastery", typeof z.object);
console.log("sessionFormatVersion", sj.SESSION_FORMAT_VERSION, "knownTypes", sj.KNOWN_SESSION_EVENT_TYPES?.size);
console.log("catalog.currentVersion", cat.sessionFormatCatalog.currentVersion, "createRestore", typeof cat.sessionFormatCatalog.createRestore, "encodeCurrentEvent", typeof cat.sessionFormatCatalog.encodeCurrentEvent);
console.log("v34.assertV4RowAdmission", typeof v34.assertV4RowAdmission, "assertReleasedV4Relationships", typeof v34.assertReleasedV4Relationships);
console.log("sp.assertStoredId", typeof sp.assertStoredId, "validateStoredEvents", typeof sp.validateStoredEvents, "SessionPersistenceRevision", typeof sp.SessionPersistenceRevision);
console.log("sp keystone", JSON.stringify(sp.SessionPersistenceRevision([1,2,345,4,5].join(":"))));
console.log("sessionFormat.exports", Object.keys(sf).join(","));
console.log("jsonl.exports", Object.keys(jl).join(","));
// From 0.2.1-rc.1 the backend class is no longer exported: the package exposes
// `{ Config, JsonlCompressionSchema, apply, name }` and builds its backend inside
// `apply`. There is no prototype to enumerate then, and reaching for one crashed this
// probe with "Cannot read properties of undefined (reading 'prototype')". Report the
// shape that is actually present instead of assuming the class.
const P = jl.default ?? jl.JsonlSessionPersistence;
if (P === undefined) {
  console.log("jsonl.backend   not exported (rc.1+ mount shape) apply:", typeof jl.apply, "name:", jl.name);
} else {
  console.log("jsonl.default", typeof P, "name", P?.name);
  console.log("jsonl proto methods sample", Object.getOwnPropertyNames(P.prototype).filter((k) => !k.startsWith("_")).slice(0, 40).join(","));
}

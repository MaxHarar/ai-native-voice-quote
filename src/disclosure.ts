import { createHash } from "node:crypto";

// The recording and non-binding disclosure every call opens with (both first messages embed it).
// Pennsylvania is an all-party-consent state (18 Pa.C.S. § 5704(4)); the consent record stores which
// wording the caller heard, so a changed disclosure is traceable per call.
export const RECORDING_DISCLOSURE = "This call is recorded, and quotes on this demo line aren't binding.";
export const DISCLOSURE_VERSION = createHash("sha256").update(RECORDING_DISCLOSURE).digest("hex").slice(0, 12);

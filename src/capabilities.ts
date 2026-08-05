/**
 * Per-backend tool availability: filters the 36-tool registry down to what a
 * given DriverKind can actually run, per ADR-001's rule that tools/list
 * discovers gaps, not runtime "unsupported" throws. Pure and I/O-free: driver
 * construction reads a static readonly `capabilities` set, it does not dial a
 * browser (verified against both cdp/driver.ts and bidi/driver.ts).
 */
import { createCdpDriver } from "./cdp/driver.ts";
import { createFirefoxDriver } from "./bidi/driver.ts";
import { REQUIRED_CAPABILITIES, type Capability, type DriverKind } from "./driver.ts";
import { TOOL_NAMES, type ToolName } from "./index.ts";

function capabilitiesFor(kind: DriverKind): ReadonlySet<Capability> {
  // Port 0 is never dialed here: only the driver's static `capabilities` set is read.
  return kind === "chrome" ? createCdpDriver().capabilities : createFirefoxDriver(0).capabilities;
}

export interface UnavailableTool {
  name: ToolName;
  missing: Capability[];
}

export interface ToolAvailability {
  kind: DriverKind;
  available: ToolName[];
  unavailable: UnavailableTool[];
}

/** Every tool name, split into what `kind` can run vs. what it can't and why. */
export function toolAvailability(kind: DriverKind): ToolAvailability {
  const caps = capabilitiesFor(kind);
  const available: ToolName[] = [];
  const unavailable: UnavailableTool[] = [];
  for (const name of TOOL_NAMES) {
    const required = REQUIRED_CAPABILITIES[name];
    if (!required || required.every((c) => caps.has(c))) {
      available.push(name);
    } else {
      unavailable.push({ name, missing: required.filter((c) => !caps.has(c)) });
    }
  }
  return { kind, available, unavailable };
}

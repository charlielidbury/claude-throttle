// Onboarding helpers for an untracked active account. Path-parameterized so
// they can be tested against a temp fake ~/.claude (never the real one).
import {
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

const CRED_MODE = 0o600;
const SLOT_RE = /^\.(.+)\.credentials\.json$/;

export const LABEL_RE = /^[A-Za-z0-9._-]+$/;

/** Derive a suggested slot label from an email local-part. */
export function suggestLabelFromEmail(email: string | null | undefined): string {
  if (!email) return "default";
  const local = email.split("@")[0] ?? "";
  const cleaned = local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

export type LabelValidation = { ok: true } | { ok: false; reason: string };

/** Validate a candidate label given the existing slot names. */
export function validateLabel(label: string, existing: string[]): LabelValidation {
  if (!label) return { ok: false, reason: "name cannot be empty" };
  if (!LABEL_RE.test(label)) return { ok: false, reason: "use letters, digits, . _ -" };
  if (existing.includes(label)) return { ok: false, reason: `slot "${label}" already exists` };
  return { ok: true };
}

/** List existing slot names in a .claude dir (excludes the active file). */
export function listSlotNames(claudeDir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(claudeDir)) {
    if (entry === ".credentials.json") continue;
    const m = entry.match(SLOT_RE);
    if (m) names.push(m[1]);
  }
  return names;
}

/** True if the active .credentials.json matches no slot file (untracked). */
export function activeIsUntracked(claudeDir: string): boolean {
  const active = join(claudeDir, ".credentials.json");
  if (!existsSync(active)) return false;
  const activeBytes = readFileSync(active);
  for (const name of listSlotNames(claudeDir)) {
    try {
      const slotBytes = readFileSync(join(claudeDir, `.${name}.credentials.json`));
      if (slotBytes.equals(activeBytes)) return false;
    } catch {
      // ignore unreadable slot
    }
  }
  return true;
}

/**
 * Save the active credentials into a new labelled slot.
 * Copies .credentials.json -> .{label}.credentials.json (atomic, 0600).
 * Returns the slot path. Does NOT write the state file (caller does that).
 */
export function saveActiveToSlot(claudeDir: string, label: string): string {
  const src = join(claudeDir, ".credentials.json");
  const dst = join(claudeDir, `.${label}.credentials.json`);
  const data = readFileSync(src);
  const tmp = `${dst}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, data, { mode: CRED_MODE });
  chmodSync(tmp, CRED_MODE);
  renameSync(tmp, dst);
  return dst;
}

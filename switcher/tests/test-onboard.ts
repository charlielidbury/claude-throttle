// Onboarding tests against a TEMP fake ~/.claude (copies only, never the real dir).
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  suggestLabelFromEmail,
  validateLabel,
  listSlotNames,
  activeIsUntracked,
  saveActiveToSlot,
} from "../src/onboard";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const SAMPLE_CRED = JSON.stringify({
  claudeAiOauth: {
    accessToken: "A",
    refreshToken: "R",
    expiresAt: 9_999_999_999_999,
    scopes: ["user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_5x",
  },
});

function main() {
  // ---- suggestLabelFromEmail ----
  console.log("\n[suggest] label from email local-part");
  check("robbiesbuxton@gmail.com -> robbiesbuxton", suggestLabelFromEmail("robbiesbuxton@gmail.com") === "robbiesbuxton");
  check("Foo.Bar+tag@x.com -> foo-bar-tag", suggestLabelFromEmail("Foo.Bar+tag@x.com") === "foo-bar-tag", suggestLabelFromEmail("Foo.Bar+tag@x.com"));
  check("null -> default", suggestLabelFromEmail(null) === "default");
  check("empty local -> default", suggestLabelFromEmail("@x.com") === "default");

  // ---- validateLabel ----
  console.log("\n[validate] label rules");
  check("empty rejected", !validateLabel("", []).ok);
  check("slash rejected", !validateLabel("a/b", []).ok);
  check("space rejected", !validateLabel("a b", []).ok);
  check("collision rejected", !validateLabel("robbie", ["robbie"]).ok);
  check("good label accepted", validateLabel("charlie", ["robbie"]).ok);
  check("dots/dashes/underscores accepted", validateLabel("a.b_c-1", []).ok);

  // ---- temp fake ~/.claude: untracked active, then onboard ----
  console.log("\n[onboard] temp fake .claude with only .credentials.json (no slots)");
  const dir = mkdtempSync(join(tmpdir(), "onboard-test-"));
  const activeFile = join(dir, ".credentials.json");
  writeFileSync(activeFile, SAMPLE_CRED, { mode: 0o600 });

  check("no slots discovered initially", listSlotNames(dir).length === 0);
  check("active is untracked (matches no slot)", activeIsUntracked(dir) === true);

  // simulate the suggestion path (email from a fetched profile)
  const suggestion = suggestLabelFromEmail("robbiesbuxton@gmail.com");
  check("suggested label = robbiesbuxton", suggestion === "robbiesbuxton");

  // confirm onboarding: save active -> .{label}.credentials.json
  const label = "robbie";
  const v = validateLabel(label, listSlotNames(dir));
  check("label valid before save", v.ok);
  const slotPath = saveActiveToSlot(dir, label);

  const srcBytes = readFileSync(activeFile);
  const slotBytes = readFileSync(slotPath);
  check("slot file byte-equal to source .credentials.json", srcBytes.equals(slotBytes));
  const mode = statSync(slotPath).mode & 0o777;
  check("slot file mode 0600", mode === 0o600, mode.toString(8));

  // now active should be TRACKED (matches the new slot)
  check("active now tracked (matches new slot)", activeIsUntracked(dir) === false);
  check("slot now discoverable", listSlotNames(dir).includes("robbie"));

  // collision now rejected
  check("re-using same label now collides", !validateLabel("robbie", listSlotNames(dir)).ok);

  rmSync(dir, { recursive: true, force: true });

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  if (failed > 0) process.exit(1);
}

main();

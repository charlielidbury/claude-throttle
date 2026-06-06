// Unit tests for the pure auto-balance decision function. No I/O, no network.
import {
  decideAutoSwitch,
  usageScore,
  HYSTERESIS_PCT,
  MIN_DWELL_MS,
  type BalanceAccount,
} from "../src/balance";

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

const NOW = 1_000_000_000_000;

function acct(name: string, score: number | null, inRotation = true): BalanceAccount {
  return { name, score, inRotation };
}

function main() {
  console.log("\n[score] usageScore = max(5h, 7d)");
  check("max picks 7d", usageScore({ fiveHour: { use: 10 }, sevenDay: { use: 40 } }) === 40);
  check("max picks 5h", usageScore({ fiveHour: { use: 62 }, sevenDay: { use: 7 } }) === 62);
  check("loading -> null", usageScore("loading") === null);
  check("error -> null", usageScore("error") === null);
  check("null -> null", usageScore(null) === null);

  console.log("\n[pick lowest] candidate is the lowest-scoring in-rotation acct");
  {
    const d = decideAutoSwitch({
      accounts: [acct("robbie", 62), acct("charlie", 11), acct("brit", 40)],
      active: "robbie",
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check("targets charlie (lowest)", d.target === "charlie", d.reason);
    check("activeScore=62", d.activeScore === 62);
    check("candidateScore=11", d.candidateScore === 11);
  }

  console.log("\n[hysteresis] no switch at 4% gap, switch at 5%+");
  {
    const at4 = decideAutoSwitch({
      accounts: [acct("a", 50), acct("b", 46)],
      active: "a",
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check(`no switch at 4% gap (hys=${HYSTERESIS_PCT})`, at4.target === null, at4.reason);

    const at5 = decideAutoSwitch({
      accounts: [acct("a", 50), acct("b", 45)],
      active: "a",
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check("switch at exactly 5% gap", at5.target === "b", at5.reason);

    const at6 = decideAutoSwitch({
      accounts: [acct("a", 50), acct("b", 44)],
      active: "a",
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check("switch at 6% gap", at6.target === "b", at6.reason);
  }

  console.log("\n[min-dwell] no switch before MIN_DWELL since last auto-switch");
  {
    const tooSoon = decideAutoSwitch({
      accounts: [acct("a", 90), acct("b", 10)],
      active: "a",
      lastAutoSwitchAt: NOW - (MIN_DWELL_MS - 1000), // 1s short of dwell
      now: NOW,
    });
    check("no switch within dwell window", tooSoon.target === null, tooSoon.reason);
    check("reason mentions min-dwell", tooSoon.reason.includes("min-dwell"));

    const afterDwell = decideAutoSwitch({
      accounts: [acct("a", 90), acct("b", 10)],
      active: "a",
      lastAutoSwitchAt: NOW - (MIN_DWELL_MS + 1000), // past dwell
      now: NOW,
    });
    check("switch allowed after dwell elapses", afterDwell.target === "b", afterDwell.reason);
  }

  console.log("\n[ignore out-of-rotation]");
  {
    // b is lowest but OUT of rotation -> must pick c (next lowest in rotation),
    // and only if gap qualifies.
    const d = decideAutoSwitch({
      accounts: [acct("a", 80), acct("b", 5, false), acct("c", 30)],
      active: "a",
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check("does not target out-of-rotation b", d.target !== "b", d.reason);
    check("targets in-rotation c", d.target === "c", d.reason);

    // If the ONLY lower account is out of rotation, no switch.
    const d2 = decideAutoSwitch({
      accounts: [acct("a", 80), acct("b", 5, false)],
      active: "a",
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check("no candidate when only lower is out-of-rotation", d2.target === null, d2.reason);
  }

  console.log("\n[ignore unknown-usage candidates]");
  {
    // b has unknown score -> ineligible as target even though it might be lower.
    const d = decideAutoSwitch({
      accounts: [acct("a", 80), acct("b", null), acct("c", 20)],
      active: "a",
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check("skips unknown-usage b, targets c", d.target === "c", d.reason);

    // unknown is the only alternative -> no switch.
    const d2 = decideAutoSwitch({
      accounts: [acct("a", 80), acct("b", null)],
      active: "a",
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check("no switch when only alternative is unknown", d2.target === null, d2.reason);
  }

  console.log("\n[active already best] no-op");
  {
    const d = decideAutoSwitch({
      accounts: [acct("a", 10), acct("b", 50), acct("c", 90)],
      active: "a",
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check("no-op when active is lowest", d.target === null, d.reason);
    check("reason says already lowest", d.reason.includes("already"));
  }

  console.log("\n[active unknown usage] cannot compare -> no-op");
  {
    const d = decideAutoSwitch({
      accounts: [acct("a", null), acct("b", 10)],
      active: "a",
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check("no switch when active score unknown", d.target === null, d.reason);
    check("reason says active unknown", d.reason.includes("unknown"));
  }

  console.log("\n[tie-break] deterministic by name on equal scores");
  {
    const d = decideAutoSwitch({
      accounts: [acct("zeta", 90), acct("yak", 10), acct("xerox", 10)],
      active: "zeta",
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check("ties broken alphabetically (xerox before yak)", d.target === "xerox", d.reason);
  }

  console.log("\n[no active] still picks but cannot compare -> no-op");
  {
    const d = decideAutoSwitch({
      accounts: [acct("a", 10), acct("b", 50)],
      active: null,
      lastAutoSwitchAt: null,
      now: NOW,
    });
    check("no switch when active is null (unknown)", d.target === null, d.reason);
  }

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  if (failed > 0) process.exit(1);
}

main();

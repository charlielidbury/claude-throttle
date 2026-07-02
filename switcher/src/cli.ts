// Non-interactive CLI front-end for claude-switcher. No React.
//
// runCli(argv) returns:
//   null            -> caller should launch the TUI (no args)
//   number (0..)    -> caller should process.exit(code) (CLI handled it)
import { paths, loadAll, fetchUsage, type Slot } from "./core";
import { performSwitchSafe } from "./credstore";
import { buildRows, computeWidths, renderTableString } from "./table";

// Read version from package.json (Bun resolves JSON imports natively; the nix
// build ships the sources so ../package.json is present at runtime). Falls back
// to a constant if the import is unavailable for any reason.
const FALLBACK_VERSION = "0.1.0";
async function getVersion(): Promise<string> {
  try {
    const pkg = (await import("../package.json", {
      with: { type: "json" },
    })) as { default?: { version?: string }; version?: string };
    return pkg.default?.version ?? pkg.version ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

const PROG = "claude-switcher";

export function printHelp(): void {
  const text = `${PROG} — view and switch between Claude credential accounts

Usage:
  ${PROG}                 Launch the interactive TUI
  ${PROG} list            Print the accounts table once (aliases: ls, status, table)
  ${PROG} switch <name>   Switch the active account to <name> (alias: use <name>)
  ${PROG} <name>          Shortcut for: switch <name>
  ${PROG} --help          Show this help (aliases: -h, help)
  ${PROG} --version       Show the version (alias: -v)

Notes:
  - list fetches usage read-only; it never refreshes a token. Accounts whose
    token has expired show "—" for usage.
  - The credentials dir can be overridden with SWITCHER_CLAUDE_DIR (or
    CLAUDE_CONFIG_DIR); defaults to ~/.claude.
  - Color is emitted only to a TTY and when NO_COLOR is unset.`;
  process.stdout.write(text + "\n");
}

export async function printVersion(): Promise<void> {
  process.stdout.write((await getVersion()) + "\n");
}

function validNamesLine(slots: Slot[]): string {
  const names = slots.map((s) => s.name).sort();
  return names.length ? `Valid accounts: ${names.join(", ")}` : "No accounts found.";
}

/** Print the accounts table once. Read-only, serialized usage fetch. */
export async function doList(): Promise<number> {
  const p = paths();
  const { slots, active } = loadAll(p);

  // Serialized, read-only usage fetch (no refresh). Expired tokens -> "—".
  for (const s of slots) {
    s.usage = await fetchUsage(s.oauth);
  }

  const rows = buildRows(slots, active);
  const widths = computeWidths(rows);
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  process.stdout.write(renderTableString(rows, widths, { color }) + "\n");
  return 0;
}

/** Switch the active account to `name`. */
export async function doSwitch(name: string): Promise<number> {
  const p = paths();
  const { slots, active } = loadAll(p);

  const target = slots.find((s) => s.name === name);
  if (!target) {
    process.stderr.write(`error: no such account "${name}"\n`);
    process.stderr.write(validNamesLine(slots) + "\n");
    return 1;
  }

  if (active === name) {
    process.stdout.write(`already on ${name}\n`);
    return 0;
  }

  // Lock-wrapped, live-read save-back switch (no token refresh).
  await performSwitchSafe(p, name, active);
  process.stdout.write(`switched to ${name}\n`);
  return 0;
}

/**
 * Dispatch argv. Returns null when the TUI should run (no args), otherwise an
 * exit code.
 */
export async function runCli(argv: string[]): Promise<number | null> {
  if (argv.length === 0) return null; // -> TUI

  const [cmd, ...rest] = argv;

  switch (cmd) {
    case "--help":
    case "-h":
    case "help":
      printHelp();
      return 0;

    case "--version":
    case "-v":
      await printVersion();
      return 0;

    case "list":
    case "ls":
    case "status":
    case "table":
      return doList();

    case "switch":
    case "use": {
      const name = rest[0];
      if (!name) {
        process.stderr.write(`error: ${cmd} requires an account name\n`);
        process.stderr.write(`usage: ${PROG} ${cmd} <name>\n`);
        return 1;
      }
      return doSwitch(name);
    }

    default: {
      // A bare, single, non-flag token is treated as a switch target so an
      // unknown bare name reuses doSwitch's "valid accounts" listing.
      if (argv.length === 1 && !cmd.startsWith("-")) {
        return doSwitch(cmd);
      }
      process.stderr.write(`error: unknown command "${cmd}"\n\n`);
      printHelp();
      return 1;
    }
  }
}

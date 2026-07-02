// Ink-free table data + a plain-string renderer.
//
// The same `buildRows`/`computeWidths`/`buildUsageFragments` feed both the Ink
// TUI (src/index.tsx) and the CLI's `renderTableString` here. The box-drawing
// in `renderTableString` MUST stay byte-identical to the TUI's literals
// (src/index.tsx GUTTER + ┌┬┐ ├┼┤ └┴┘ │ + pad/fragLen widths) so `list` and
// the TUI render the same box.
import { tierLabel, expiresLabel, accountLabel, type Slot, type Usage, type Window } from "./core";

export type Fragment = { text: string; color?: string };

export type DisplayRow = {
  name: string;
  inRotation: boolean;
  cells: {
    account: string;
    active: string;
    rotation: string;
    tier: string;
    usage: Fragment[];
    expires: string;
  };
};

export const HEADERS = {
  account: "Account",
  active: "Active",
  rotation: "Rot",
  tier: "Tier",
  usage: "Usage",
  expires: "Expires",
};

export const COL_ORDER: (keyof typeof HEADERS)[] = [
  "account",
  "active",
  "rotation",
  "tier",
  "usage",
  "expires",
];

export function fragLen(frags: Fragment[]): number {
  return frags.reduce((n, f) => n + f.text.length, 0);
}

export function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

export function buildUsageFragments(usage: Usage): Fragment[] {
  if (usage === "loading") return [{ text: "…" }];
  if (usage === "error") return [{ text: "—" }];
  const win = (w: Window): Fragment[] => [
    { text: `${w.use}%`, color: w.use > w.elapsed ? "red" : "green" },
    { text: `/${w.elapsed}%` },
  ];
  return [
    { text: "5h: " },
    ...win(usage.fiveHour),
    { text: "  7d: " },
    ...win(usage.sevenDay),
  ];
}

export function buildRows(slots: Slot[], active: string | null): DisplayRow[] {
  return slots.map((s) => {
    const inRotation = s.cache.inRotation !== false;
    return {
      name: s.name,
      inRotation,
      cells: {
        account: accountLabel(s),
        active: s.name === active ? "●" : "",
        rotation: inRotation ? "◉" : "○",
        tier: tierLabel(s.oauth),
        usage: buildUsageFragments(s.usage),
        expires: expiresLabel(s.oauth.expiresAt),
      },
    };
  });
}

export function computeWidths(rows: DisplayRow[]): Record<keyof typeof HEADERS, number> {
  const w = {} as Record<keyof typeof HEADERS, number>;
  for (const col of COL_ORDER) {
    let max = HEADERS[col].length;
    for (const r of rows) {
      const cell = r.cells[col];
      const len = col === "usage" ? fragLen(cell as Fragment[]) : (cell as string).length;
      max = Math.max(max, len);
    }
    w[col] = max;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Plain-string renderer (mirrors the TUI box-drawing exactly).
// ---------------------------------------------------------------------------
const ANSI = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  reset: "\x1b[0m",
};

// Same two-char gutter the TUI reserves for the cursor (no cursor in the CLI,
// so it is always two spaces — keeps the box columns aligned identically).
const GUTTER = "  ";

function colorize(text: string, color: string | undefined, enabled: boolean): string {
  if (!enabled || !color) return text;
  const code = color === "red" ? ANSI.red : color === "green" ? ANSI.green : "";
  if (!code) return text;
  return `${code}${text}${ANSI.reset}`;
}

/**
 * Render the accounts table to a plain string, mirroring the TUI's box-drawing
 * byte-for-byte (same glyphs, gutter, and column widths). The only styling is
 * per-fragment red/green coloring of the usage %, gated by `color`.
 */
export function renderTableString(
  rows: DisplayRow[],
  widths: Record<keyof typeof HEADERS, number>,
  opts: { color: boolean } = { color: false },
): string {
  const horizontal = (left: string, mid: string, right: string) =>
    GUTTER +
    left +
    COL_ORDER.map((c) => "─".repeat(widths[c] + 2)).join(mid) +
    right;

  const headerLine =
    GUTTER +
    "│ " +
    COL_ORDER.map((c) => pad(HEADERS[c], widths[c])).join(" │ ") +
    " │";

  const renderRow = (row: DisplayRow): string => {
    let line = GUTTER + "│ ";
    COL_ORDER.forEach((c, i) => {
      if (c === "usage") {
        const frags = row.cells.usage;
        const body = frags
          .map((f) => colorize(f.text, f.color, opts.color))
          .join("");
        const padN = widths.usage - fragLen(frags);
        line += body + (padN > 0 ? " ".repeat(padN) : "");
      } else {
        line += pad(row.cells[c] as string, widths[c]);
      }
      line += i < COL_ORDER.length - 1 ? " │ " : " │";
    });
    return line;
  };

  const lines = [
    horizontal("┌", "┬", "┐"),
    headerLine,
    horizontal("├", "┼", "┤"),
    ...rows.map(renderRow),
    horizontal("└", "┴", "┘"),
  ];
  return lines.join("\n");
}

# switcher

A terminal UI to view and switch between your Claude credential accounts
(slots in `~/.claude/.{name}.credentials.json`). Shows per-account tier, live
5h/7d usage vs. elapsed-window pace, and token expiry.

Keys: `↑/↓` move · `enter` switch · `space` toggle an account in/out of
rotation · `a` toggle auto-balance · `r` refresh an expired token · `q` quit.

Auto-balance (off by default, TUI-only — runs only while open) keeps the
active account on the least-used in-rotation account, with hysteresis and a
minimum dwell time so it doesn't churn.

## Run

From a fresh checkout (requires [Nix](https://nixos.org) with flakes enabled):

```sh
cd switcher
nix develop --command bun install          # first time only
nix develop --command bun run src/index.tsx
```

With [direnv](https://direnv.net): `cd switcher && direnv allow` puts `bun` on
your PATH, then just `bun install` / `bun run src/index.tsx`.

## Tests

```sh
nix develop --command bun run tests/test-refresh.ts
nix develop --command bun run tests/test-onboard.ts
nix develop --command bun run tests/test-balance.ts      # auto-balance decision logic
nix develop --command bun run tests/test-autoswitch.ts   # toggle + swap file mechanics
```

# switcher

A terminal UI to view and switch between your Claude credential accounts
(slots in `~/.claude/.{name}.credentials.json`). Shows per-account tier, live
5h/7d usage vs. elapsed-window pace, and token expiry.

Keys: `↑/↓` move · `enter` switch · `space` toggle an account in/out of
rotation · `a` toggle auto-balance · `u` toggle 30s usage auto-refresh ·
`r` refresh an expired token · `q` quit.

Auto-balance (off by default, TUI-only — runs only while open) keeps the
active account on the least-used in-rotation account, with hysteresis and a
minimum dwell time so it doesn't churn.

Usage auto-refresh (`u`, off by default) re-fetches usage for all accounts
every 30s to keep the table live; token refreshes happen only once per expiry
window, not every tick. Both loops share one timer, so enabling both does a
single fetch pass per cycle.

## Run

From a fresh checkout (requires [Nix](https://nixos.org) with flakes enabled):

```sh
cd switcher
nix develop --command bun install          # first time only
nix develop --command bun run src/index.tsx
```

With [direnv](https://direnv.net): `cd switcher && direnv allow` puts `bun` on
your PATH, then just `bun install` / `bun run src/index.tsx`.

## Install (Nix)

The flake builds a reproducible package with dependencies vendored offline via
[bun2nix](https://github.com/baileyluTCD/bun2nix) (no network `bun install` at
build time). The flake lives in `switcher/`, so reference it as `./switcher`
(or `<repo>?dir=switcher`). The executable is `claude-switcher`.

Build / run from a checkout:

```sh
nix build ./switcher#switcher     # -> ./result/bin/claude-switcher
nix run   ./switcher#switcher     # build + run the TUI
```

Imperative profile install:

```sh
nix profile install ./switcher#switcher
claude-switcher
```

Home Manager (`home.packages`):

```nix
# flake.nix inputs:
#   claude-throttle.url = "github:charlielidbury/claude-throttle?dir=switcher";
{ inputs, pkgs, ... }:
{
  home.packages = [
    inputs.claude-throttle.packages.${pkgs.system}.switcher
  ];
}
```

NixOS (`environment.systemPackages`):

```nix
{ inputs, pkgs, ... }:
{
  environment.systemPackages = [
    inputs.claude-throttle.packages.${pkgs.system}.switcher
  ];
}
```

### Regenerating the vendored deps

After changing dependencies (and `bun.lock`), regenerate `bun.nix`:

```sh
nix develop   # provides the `bun2nix` CLI
bun2nix -o bun.nix
```

### Pointing at a different credentials dir

By default the TUI reads/writes `~/.claude`. To run against a throwaway copy
(e.g. for testing) without touching your real credentials, set an env override:

```sh
SWITCHER_CLAUDE_DIR=/tmp/claude-copy bun run src/index.tsx
```

Precedence: `SWITCHER_CLAUDE_DIR` > `CLAUDE_CONFIG_DIR` > `~/.claude`.

> WARNING: a copied credentials file shares the SAME refresh token as the real
> account. Refreshing it (via `u` usage-refresh or auto-balance hitting an
> expired token) rotates that token server-side and invalidates your real
> login. Only run a copy with valid tokens / read-only usage, or with the
> network mocked. Never trigger a refresh against a copy of a real token.

## Tests

```sh
nix develop --command bun run tests/test-refresh.ts
nix develop --command bun run tests/test-onboard.ts
nix develop --command bun run tests/test-balance.ts      # auto-balance decision logic
nix develop --command bun run tests/test-autoswitch.ts   # toggle + swap file mechanics
nix develop --command bun run tests/test-usagepass.ts    # usage auto-refresh pass
nix develop --command bun run tests/test-passrobust.ts   # 429/no-clobber, serialization, backoff
```

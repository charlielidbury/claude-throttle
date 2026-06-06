{
  description = "claude-switcher — a Bun/Ink TUI to view and switch Claude accounts";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    bun2nix = {
      url = "github:baileyluTCD/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, bun2nix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # bun2nix's builder + dep fetcher live in the package's passthru.
        b2n = bun2nix.packages.${system}.default.passthru;

        # Vendored dependency set generated from bun.lock by `bun2nix -o bun.nix`.
        # Pure / offline — no network `bun install` at build time.
        bunDeps = b2n.fetchBunDeps {
          bunNix = ./bun.nix;
        };

        # The installable TUI. writeBunApplication builds the package with the
        # vendored deps, then wraps a startup script that runs the TUI through
        # the real `bun` (not a --compile binary), chdir'd into the package so
        # `bun run src/index.tsx` resolves node_modules + sources.
        switcher = b2n.writeBunApplication {
          pname = "claude-switcher";
          version = "0.1.0";
          src = ./.;
          inherit bunDeps;

          # This package ships the TypeScript sources and runs them through bun
          # at runtime — there is no compile/bundle step and no in-sandbox test
          # run, so skip bun2nix's default `bun build` / `bun test` phases.
          dontUseBunBuild = true;
          dontUseBunCheck = true;

          # Pin the runtime bun to match the dev-shell bun (avoid lock/runtime skew).
          runtimeInputs = [ pkgs.bun ];

          # Runnable entry: launch the Ink TUI via bun.
          startScript = ''
            exec bun run src/index.tsx "$@"
          '';

          meta = {
            description = "TUI to view/switch Claude credential accounts";
            mainProgram = "claude-switcher";
          };
        };
      in
      {
        packages = {
          default = switcher;
          switcher = switcher;
        };

        apps =
          let
            switcherApp = {
              type = "app";
              program = "${switcher}/bin/claude-switcher";
              meta.description = "Run the Claude account switcher TUI";
            };
          in
          {
            default = switcherApp;
            switcher = switcherApp;
          };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.nodejs_22
            # `bun2nix` CLI on PATH so you can regenerate bun.nix after deps change:
            #   bun2nix -o bun.nix
            bun2nix.packages.${system}.default
          ];
        };
      });
}

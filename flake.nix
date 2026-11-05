{
  description = "Development environment for the Pi extension workspace";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            name = "pi-extensions-dev";

            # Keep the Node major aligned with pi-extensions/.node-version.
            # Bun manages dependencies/scripts; Pi and build/test tools use Node.
            packages = with pkgs; [
              nodejs_26
              bun
              process-compose
              git
              bashInteractive
              ripgrep
              fd
            ];
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);
    };
}

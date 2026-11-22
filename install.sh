#!/bin/sh
# Install pi-harness from this checkout: pinned Bun, locked JS dependencies, launcher.
# Safe to re-run (it is also the update command); see docs/runtime-install.md.
#   PI_HARNESS_INSTALL_DIR  releases, staged Bun, caches   (default ~/.pi-harness/install)
#   PI_HARNESS_BIN_DIR      launcher directory             (default ~/.local/bin)
set -eu

# Bun release pin. Refresh: docs/runtime-install.md#updating
BUN_VERSION=1.4.5
BUN_PINS='
darwin-aarch64          b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10
darwin-x64              a4972e778cce4b6a194d7d289f326aa61576d71d80b7a53e9da2f3739566e5fd
darwin-x64-baseline     fb0121739a7e80e7511b6bfe4d2116422b48ba18a013acadef0c425348e95891
linux-aarch64           18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84
linux-aarch64-musl      d655765d3a0c0fdf707e27c7aa1a4f2c84f1bbc1f759db7e6e3d3c5be414396c
linux-x64               94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb
linux-x64-baseline      dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463
linux-x64-musl          9b6bdba1fa0914b6adfe48e4438212e2c106d9199b77ba642a9b8a3968a49a59
linux-x64-musl-baseline 96fb94108eed872ff623ed39007d6b5699a83a5d0086fcfba84921c18145e3e6
'

# Native octofs MCP binary pin (ships hash-verified view/batch_edit/AST search to all ACP agents)
OCTOFS_VERSION=0.26.0
OCTOFS_PINS='
darwin-aarch64 aarch64-apple-darwin       6c2703bc519c0574a05da50582a6fd63f285372e9a76ad1c02898ced587d5e3f
darwin-x64     x86_64-apple-darwin        f5cb45ca410cdeb41dd674825592b8476529399fd542045a665e461cd70a23c4
linux-aarch64  aarch64-unknown-linux-musl b5f368faa66fe4c1b800d4185300d2f1951d5e186982aec043ae7f3e92d1b951
linux-x64      x86_64-unknown-linux-musl  18b78be9c4099285832a1efeb2579a6029eb8bc4c7ac0ac7105da9207611eb03
'

die() { echo "install.sh: $*" >&2; exit 1; }
log() { echo "install.sh: $*"; }

SRC=$(cd -P "$(dirname "$0")" && pwd)
INSTALL_DIR=${PI_HARNESS_INSTALL_DIR:-$HOME/.pi-harness/install}
BIN_DIR=${PI_HARNESS_BIN_DIR:-$HOME/.local/bin}
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
INSTALL_DIR=$(cd -P "$INSTALL_DIR" && pwd)
BIN_DIR=$(cd -P "$BIN_DIR" && pwd)
case "$INSTALL_DIR$BIN_DIR" in
  *[\"\$\`\\]*) die 'paths must not contain " $ ` or \' ;;
esac

for tool in curl unzip tar grep find sort cut awk uname; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$@"; }
else die "missing required tool: sha256sum or shasum"; fi

# --- target ---------------------------------------------------------------
os=$(uname -s); arch=$(uname -m)
case "$os" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "unsupported OS: $os" ;; esac
case "$arch" in
  arm64|aarch64) arch=aarch64 ;;
  x86_64|amd64) arch=x64 ;;
  *) die "unsupported CPU: $arch" ;;
esac
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=aarch64 # shell running under Rosetta on Apple silicon
fi
target=$os-$arch
if [ "$os" = linux ] && { [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; }; then
  target=$target-musl
fi
if [ "$arch" = x64 ]; then # non-baseline Bun needs AVX2
  case "$os" in
    darwin) sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qi avx2 || target=$target-baseline ;;
    linux) grep -qi avx2 /proc/cpuinfo 2>/dev/null || target=$target-baseline ;;
  esac
fi
want=$(echo "$BUN_PINS" | awk -v t="$target" '$1 == t { print $2 }')
[ -n "$want" ] || die "no pinned Bun for $target"
[ "$os" = darwin ] || log "note: Code Mode is macOS-only; on $os the CLI works but code_exec is disabled"

# --- lock -----------------------------------------------------------------
LOCK=$INSTALL_DIR/.lock
mkdir "$LOCK" 2>/dev/null || die "another install is running (remove $LOCK if stale)"
STAGE=$INSTALL_DIR/.stage.$$
trap 'rm -rf "$STAGE" "$LOCK"' EXIT
trap 'exit 1' INT TERM
rm -rf "$STAGE"
mkdir -p "$STAGE" "$INSTALL_DIR/cache/downloads" "$INSTALL_DIR/cache/bun" "$INSTALL_DIR/releases" "$INSTALL_DIR/bun"

# --- staged Bun (pinned checksum, verified before extraction) ---------------
BUN_HOME=$INSTALL_DIR/bun/$BUN_VERSION-$target
if [ "$("$BUN_HOME/bin/bun" --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  zip=$INSTALL_DIR/cache/downloads/bun-v$BUN_VERSION-$target.zip
  if [ ! -f "$zip" ] || [ "$(sha256 "$zip" | cut -d' ' -f1)" != "$want" ]; then
    log "downloading Bun $BUN_VERSION ($target)"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$zip.part" \
      "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$target.zip"
    mv "$zip.part" "$zip"
  fi
  [ "$(sha256 "$zip" | cut -d' ' -f1)" = "$want" ] || { rm -f "$zip"; die "Bun checksum mismatch for $target"; }
  unzip -q "$zip" -d "$STAGE/bun"
  mkdir -p "$STAGE/bun-home/bin"
  mv "$STAGE/bun/bun-$target/bun" "$STAGE/bun-home/bin/bun"
  chmod +x "$STAGE/bun-home/bin/bun"
  [ "$("$STAGE/bun-home/bin/bun" --version)" = "$BUN_VERSION" ] || die "staged Bun reports an unexpected version"
  rm -rf "$BUN_HOME"
  mv "$STAGE/bun-home" "$BUN_HOME"
fi
BUN=$BUN_HOME/bin/bun

# --- staged octofs (pinned checksum, verified before extraction) ------------
octofs_key=$os-$arch
octofs_triple=$(echo "$OCTOFS_PINS" | awk -v k="$octofs_key" '$1 == k { print $2 }')
octofs_want=$(echo "$OCTOFS_PINS" | awk -v k="$octofs_key" '$1 == k { print $3 }')
if [ -n "$octofs_triple" ] && [ -n "$octofs_want" ]; then
  OCTOFS_HOME=$INSTALL_DIR/tools/octofs/$OCTOFS_VERSION-$octofs_triple
  if [ ! -x "$OCTOFS_HOME/bin/octofs" ]; then
    octofs_tgz=$INSTALL_DIR/cache/downloads/octofs-$OCTOFS_VERSION-$octofs_triple.tar.gz
    if [ ! -f "$octofs_tgz" ] || [ "$(sha256 "$octofs_tgz" | cut -d' ' -f1)" != "$octofs_want" ]; then
      log "downloading octofs $OCTOFS_VERSION ($octofs_triple)"
      curl -fsSL --proto '=https' --tlsv1.2 -o "$octofs_tgz.part" \
        "https://github.com/Muvon/octofs/releases/download/$OCTOFS_VERSION/octofs-$OCTOFS_VERSION-$octofs_triple.tar.gz"
      mv "$octofs_tgz.part" "$octofs_tgz"
    fi
    [ "$(sha256 "$octofs_tgz" | cut -d' ' -f1)" = "$octofs_want" ] || { rm -f "$octofs_tgz"; die "octofs checksum mismatch for $octofs_triple"; }
    mkdir -p "$STAGE/octofs-home/bin" "$INSTALL_DIR/tools/octofs"
    tar -xzf "$octofs_tgz" -C "$STAGE/octofs-home/bin"
    chmod +x "$STAGE/octofs-home/bin/octofs"
    rm -rf "$OCTOFS_HOME"
    mv "$STAGE/octofs-home" "$OCTOFS_HOME"
  fi
fi

# --- release: content-addressed copy of the runtime files + frozen deps ----
FILES="src proto package.json bun.lock tsconfig.json"
cd "$SRC"
# shellcheck disable=SC2086
ID=$(find $FILES -type f | LC_ALL=C sort | while IFS= read -r f; do sha256 "$f"; done | sha256 | cut -c1-12)
REL=$INSTALL_DIR/releases/$ID
if [ -f "$REL/.installed" ]; then
  log "release $ID already installed"
else
  mkdir -p "$STAGE/rel"
  # shellcheck disable=SC2086
  tar -cf - $FILES | tar -xf - -C "$STAGE/rel"
  log "installing locked dependencies"
  # Production deps only: tsc and the protoc plugin are not needed to run, and src/gen
  # is committed. A frozen lockfile fails instead of re-resolving.
  (cd "$STAGE/rel" && BUN_INSTALL_CACHE_DIR=$INSTALL_DIR/cache/bun "$BUN" install --frozen-lockfile --production --no-progress)
  touch "$STAGE/rel/.installed"
  rm -rf "$REL"
  mv "$STAGE/rel" "$REL"
fi
ln -sfn "$BUN" "$REL/.bun" # each release runs with the Bun it was installed with

# --- activate: current symlink, then launcher (each swapped atomically) -----
rm -f "$INSTALL_DIR/current.new"
ln -s "releases/$ID" "$INSTALL_DIR/current.new"
"$BUN" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$INSTALL_DIR/current.new" "$INSTALL_DIR/current"

cat > "$BIN_DIR/.pi-harness.new" <<EOF
#!/bin/sh
set -eu
RELEASE_DIR="\$(cd -P "\${PI_HARNESS_INSTALL_DIR:-$INSTALL_DIR}/current" && pwd)"
exec "\${BUN_BIN:-\$RELEASE_DIR/.bun}" "\$RELEASE_DIR/src/cli.ts" "\$@"
EOF
chmod +x "$BIN_DIR/.pi-harness.new"
mv -f "$BIN_DIR/.pi-harness.new" "$BIN_DIR/pi-harness"
ln -sf pi-harness "$BIN_DIR/harness"

log "installed release $ID with Bun $BUN_VERSION ($target)"
log "launcher: $BIN_DIR/pi-harness"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) log "add $BIN_DIR to PATH to run pi-harness by name" ;; esac

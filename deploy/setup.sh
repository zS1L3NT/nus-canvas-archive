#!/usr/bin/env bash
# Sets up nus-canvas-sync on Debian without sudo. Safe to rerun.
#   deploy/setup.sh               tools, dependencies and config.json, for any checkout
#   deploy/setup.sh --production  also the services chosen under "server" in config.json
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
bin=$HOME/.local/bin
secrets=$HOME/.config/nus-canvas-sync
units=$HOME/.config/systemd/user
export PATH=$HOME/.bun/bin:$bin:$PATH

for tool in curl unzip git flock; do
  if ! command -v "$tool" >/dev/null; then
    echo "Missing $tool. Install the prerequisites once with: sudo apt install curl unzip git util-linux" >&2
    exit 1
  fi
done
case $(uname -m) in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$bin"
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
command -v canvas >/dev/null ||
  curl -fsSL https://raw.githubusercontent.com/jjuanrivvera/canvas-cli/main/install.sh | INSTALL_DIR=$bin sh
(cd "$repo" && bun install --frozen-lockfile)
[[ -f $repo/config.json ]] || cp "$repo/config.example.json" "$repo/config.json"

if [[ ${1:-} != --production ]]; then
  echo "Tools ready. Edit config.json for your courses; production also needs: deploy/setup.sh --production"
  exit 0
fi

# "off" stands for a null or missing setting.
read -r vault schedule port tunnel < <(cd "$repo" && bun -e '
  const { loadConfig } = await import("./src/config.ts");
  const { server = {} } = await Bun.file("config.json").json();
  const { vaultDirectory } = await loadConfig(process.cwd());
  console.log(vaultDirectory, server.fetchSchedule ?? "off", server.webdavPort ?? "off", server.tunnel ? "on" : "off");
')
if [[ $repo$vault == *" "* ]]; then
  echo "The checkout and vault paths must not contain spaces: $repo, $vault" >&2
  exit 1
fi
if [[ $tunnel == on && $port == off ]]; then
  echo "server.tunnel needs server.webdavPort in config.json" >&2
  exit 1
fi

if [[ $port != off && ! -x $bin/rclone ]]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/rclone.zip" "https://downloads.rclone.org/rclone-current-linux-$arch.zip"
  unzip -q -j "$tmp/rclone.zip" '*/rclone' -d "$bin"
  rm -rf "$tmp"
fi
if [[ $tunnel == on && ! -x $bin/cloudflared ]]; then
  curl -fsSL -o "$bin/cloudflared" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch"
  chmod +x "$bin/cloudflared"
fi

# Secrets are prompted for once and never echoed; rerunning keeps them.
mkdir -p "$secrets"
chmod 700 "$secrets"
if [[ $port != off && ! -f $secrets/webdav.env ]]; then
  read -rp "WebDAV username: " user
  read -rsp "WebDAV password (letters, digits, . _ - only; 20+ characters): " pass
  echo
  if [[ ! $user =~ ^[A-Za-z0-9._-]+$ || ! $pass =~ ^[A-Za-z0-9._-]{20,}$ ]]; then
    echo "Invalid username or password; rerun to try again." >&2
    exit 1
  fi
  (umask 077 && printf 'RCLONE_USER=%s\nRCLONE_PASS=%s\n' "$user" "$pass" >"$secrets/webdav.env")
fi
if [[ $tunnel == on && ! -f $secrets/tunnel-token ]]; then
  read -rsp "Cloudflare tunnel token: " token
  echo
  (umask 077 && printf '%s\n' "$token" >"$secrets/tunnel-token")
fi

mkdir -p "$repo/raw" "$vault" "$units"
render() {
  sed -e "s|@REPO@|$repo|g" -e "s|@VAULT@|$vault|g" -e "s|@SCHEDULE@|$schedule|g" -e "s|@PORT@|$port|g" \
    "$repo/deploy/systemd/$1" >"$units/$1"
}
# The fetch service stays installed for manual runs; the rest follow their toggles.
toggles=("canvas-fetch.timer $schedule" "canvas-webdav.service $port" "canvas-tunnel.service $tunnel")
render canvas-fetch.service
for toggle in "${toggles[@]}"; do
  read -r unit value <<<"$toggle"
  if [[ $value == off ]]; then
    systemctl --user disable --now "$unit" 2>/dev/null || true
    rm -f "$units/$unit"
  else
    render "$unit"
  fi
done
systemctl --user daemon-reload
for toggle in "${toggles[@]}"; do
  read -r unit value <<<"$toggle"
  if [[ $value != off ]]; then
    systemctl --user enable "$unit"
    systemctl --user restart "$unit"
  fi
done

# User services stop at logout and do not start at boot unless the user lingers.
if [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) != yes ]] && ! loginctl enable-linger "$USER" 2>/dev/null; then
  echo "Run once so the services survive logout and reboots: sudo loginctl enable-linger $USER" >&2
fi

echo "Production ready. Vault: $vault"
systemctl --user list-units 'canvas-*' --all --no-pager

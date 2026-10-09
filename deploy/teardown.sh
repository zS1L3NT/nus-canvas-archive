#!/usr/bin/env bash
# Undoes deploy/setup.sh without touching raw/, the vault or config.json. Safe to rerun.
#   deploy/teardown.sh            stop and remove the systemd units
#   deploy/teardown.sh --secrets  also delete the stored secrets and log canvas-cli out
#   deploy/teardown.sh --tools    also delete rclone and cloudflared from ~/.local/bin
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
bin=$HOME/.local/bin
secrets=$HOME/.config/nus-canvas-sync
units=$HOME/.config/systemd/user
export PATH=$HOME/.bun/bin:$bin:$PATH

for unit in canvas-fetch.timer canvas-fetch.service canvas-webdav.service canvas-tunnel.service; do
  systemctl --user disable --now "$unit" 2>/dev/null || true
  rm -f "$units/$unit"
done
systemctl --user daemon-reload 2>/dev/null || true
echo "Removed the systemd units."

if [[ " $* " == *" --secrets "* ]]; then
  read -rp "Delete the WebDAV credentials and tunnel token, and log canvas-cli out? [y/N] " answer
  if [[ $answer == [yY] ]]; then
    rm -rf "$secrets"
    instance=$(cd "$repo" && bun -e 'console.log((await Bun.file("config.json").json()).canvasInstance)' 2>/dev/null || true)
    [[ -n $instance ]] && canvas auth logout "$instance"
    echo "Deleted the secrets. Also revoke the Canvas access token in Canvas and delete the tunnel in Cloudflare."
  fi
fi

if [[ " $* " == *" --tools "* ]]; then
  rm -f "$bin/rclone" "$bin/cloudflared"
  echo "Deleted rclone and cloudflared. bun and canvas-cli stay, since other projects may use them."
fi

echo "Kept $repo/raw, the vault and config.json; delete them yourself if you no longer need the archive."

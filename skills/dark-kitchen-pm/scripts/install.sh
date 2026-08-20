#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: sh scripts/install.sh <client-skills-directory>" >&2
  exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
skill_dir=$(dirname -- "$script_dir")
target_root=$1
target_dir=$target_root/dark-kitchen-pm

if [ -e "$target_dir" ]; then
  echo "refusing to overwrite existing skill: $target_dir" >&2
  exit 73
fi

mkdir -p -- "$target_root"
cp -R -- "$skill_dir" "$target_dir"
echo "installed dark-kitchen-pm at $target_dir"

#!/usr/bin/env bash
# gen-cheatsheet.sh — concatenate docs/cheatsheet/*.md (sorted by filename)
# into docs/CHEATSHEET.md with a generated header. Do NOT edit CHEATSHEET.md by
# hand; edit the partials in docs/cheatsheet/ and re-run this script.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$script_dir/.." && pwd)"
part_dir="$repo/docs/cheatsheet"
out_file="$repo/docs/CHEATSHEET.md"

shopt -s nullglob
parts=("$part_dir"/*.md)
shopt -u nullglob
if [ ${#parts[@]} -eq 0 ]; then
  echo "No partials found in $part_dir" >&2
  exit 1
fi
# Sort by filename for deterministic ordering.
IFS=$'\n' parts=($(sort <<<"${parts[*]}"))
unset IFS

{
  printf '%s\n' '<!-- GENERATED FILE — do not edit by hand.'
  printf '%s\n' '     Source: docs/cheatsheet/*.md — regenerate with scripts/gen-cheatsheet.sh -->'
  printf '\n'
  for p in "${parts[@]}"; do
    # Trim trailing blank lines, then add one separating blank line.
    sed -e :a -e '/^\n*$/{$d;N;ba}' "$p"
    printf '\n'
  done
} > "$out_file"

echo "Wrote $out_file from ${#parts[@]} partial(s)."

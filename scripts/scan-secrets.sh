#!/usr/bin/env bash
# Secret / PII guard for the Lark-PMdoc public repo.
# Scans files for credential & account-identifier patterns; exit 1 (block) on any hit.
# Usage:
#   scripts/scan-secrets.sh          # scan staged files (pre-commit)
#   scripts/scan-secrets.sh --all    # scan all tracked files
#
# This script intentionally embeds NO literal secrets — only generic regexes —
# so it is safe to ship in a public repo. Project-specific literal IDs/tokens go
# in .secret-blacklist.local (gitignored), one literal per line.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == "--all" ]]; then
  mapfile -t files < <(git ls-files)
else
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACM)
fi
[[ ${#files[@]} -eq 0 ]] && { echo "scan-secrets.sh: nothing to scan"; exit 0; }

# Generic credential / identifier patterns (no literal secrets here).
patterns=(
  'ou_[0-9a-f]{32}'                            # Feishu open_id
  'on_[0-9a-f]{32}'                            # Feishu union_id
  'cli_[0-9a-f]{16,}'                          # Feishu app id
  '-----BEGIN [A-Z ]*PRIVATE KEY'              # private keys
  'gh[pousr]_[A-Za-z0-9]{36,}'                 # GitHub tokens
  'github_pat_[A-Za-z0-9_]{50,}'               # GitHub fine-grained PAT
  'sk-[A-Za-z0-9]{20,}'                        # OpenAI-style keys
  'xox[baprs]-[A-Za-z0-9-]{10,}'               # Slack tokens
  'AKIA[0-9A-Z]{16}'                           # AWS access key id
  '"accessToken"'                              # OAuth credential dumps
)

local_bl=".secret-blacklist.local"
hits=0

for f in "${files[@]}"; do
  [[ -f "$f" ]] || continue
  case "$f" in scripts/scan-secrets.sh) continue ;; esac   # never flag the scanner itself
  for p in "${patterns[@]}"; do
    if grep -nEI "$p" "$f" >/dev/null 2>&1; then
      echo "BLOCKED: pattern /$p/ in $f"
      grep -nEI "$p" "$f" | head -3 | sed 's/^/    /'
      hits=1
    fi
  done
  if [[ -f "$local_bl" ]]; then
    while IFS= read -r lit; do
      [[ -z "$lit" || "$lit" == \#* ]] && continue
      if grep -nFI "$lit" "$f" >/dev/null 2>&1; then
        echo "BLOCKED: blacklisted literal in $f"
        hits=1
      fi
    done < "$local_bl"
  fi
done

if [[ $hits -ne 0 ]]; then
  echo ""
  echo "Commit blocked by scan-secrets.sh — remove the secret/PII before committing."
  exit 1
fi
echo "scan-secrets.sh: clean (${#files[@]} file(s) scanned)"
exit 0

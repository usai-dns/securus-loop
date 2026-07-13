#!/usr/bin/env bash
# Bulk-create the OPEN issues from docs/ISSUES.md on GitHub.
# Prerequisite: the Claude GitHub App must be connected for the usai-dns org
# (an org admin enables it at https://claude.ai/admin-settings), and `gh` must
# be authenticated (`gh auth status`). Idempotency: skips a title that already
# exists as an open issue.
#
# Usage:  bash scripts/file-github-issues.sh [--dry-run]
set -euo pipefail

REPO="usai-dns/securus-loop"
DRY="${1:-}"

command -v gh >/dev/null || { echo "gh CLI not found. Install: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated. Run: gh auth login"; exit 1; }

ensure_label() {
  gh label create "$1" --repo "$REPO" --color "$2" --force >/dev/null 2>&1 || true
}
ensure_label bug d73a4a
ensure_label enhancement a2eeef
ensure_label ops 0e8a16
ensure_label reliability fbca04
ensure_label needs-investigation d876e3
ensure_label priority:high b60205
ensure_label securus c5def5
ensure_label send-queue bfdadc
ensure_label voice 5319e7

create() {
  local title="$1" labels="$2" body="$3"
  if gh issue list --repo "$REPO" --state open --search "$title in:title" --json title \
       --jq '.[].title' 2>/dev/null | grep -Fxq "$title"; then
    echo "skip (exists): $title"; return
  fi
  if [ "$DRY" = "--dry-run" ]; then
    echo "would create: [$labels] $title"; return
  fi
  gh issue create --repo "$REPO" --title "$title" --label "$labels" --body "$body" \
    && echo "created: $title"
}

create "SMS notifications disabled — Twilio secrets unset" "ops,priority:high" \
"The worker has no TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / DENNIS_PHONE, so every notifyDennis() call silently no-ops: stamp alerts, send-failure alerts, and the emergency-escalation safety path. Set via: npx wrangler secret put TWILIO_ACCOUNT_SID (x4). See docs/ISSUES.md #10."

create "Send button stays disabled on some short continuation parts" "bug,securus,needs-investigation" \
"Compose Send button stays disabled for certain short follow-up messages despite a valid form (contact + subject + body set, under char limit), reproducibly across fresh sessions and distinct subjects. Likely a Securus consecutive-message throttle. Real-keystroke nudge added; may not fully resolve. Next: detect disabled-after-valid and defer the part to a later cron. See docs/ISSUES.md #12."

create "Scan browser occasionally hits detached-Frame / navigation timeout" "bug,securus,reliability" \
"Transient puppeteer errors (detached Frame, Navigation timeout 30000ms) on some cron scans; self-recovers next cron. Wrap navigation in retry-with-backoff and relaunch browser once on frame-detach. See docs/ISSUES.md #13."

create "Automated D1 backup / conversation export" "enhancement,ops" \
"All of Sam's document history lives only in D1. Add a scheduled export of messages to R2 (or a /export endpoint) so the record survives loss. See docs/ISSUES.md #14."

create "Deploy voice worker (securus-voice)" "enhancement,voice" \
"Twilio<->Gemini Live<->Deepgram Durable Object bridge exists under voice-worker/ but isn't deployed or wired to a number. Needs GEMINI_API_KEY, DEEPGRAM_API_KEY, a Twilio number, and collect-call timing tuning. See docs/ISSUES.md #15."

create "Backfill confirmed_sent on 57 historical outbound rows" "chore" \
"Pre-verification-era sends have confirmed_sent = NULL. Harmless; a one-off backfill from the sent folder would tidy reporting. See docs/ISSUES.md #16."

echo "done."

#!/bin/sh
# Tests install.sh against a throwaway config directory, a file:// download and a fake "ha" command.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
FAILED=0

check() { # description, command...
  desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "ok   $desc"; else echo "FAIL $desc"; FAILED=1; fi
}

mkdir -p "$WORK/bin"
cat > "$WORK/bin/ha" <<'FAKE'
#!/bin/sh
echo "$*" >> "$HA_LOG"
FAKE
chmod +x "$WORK/bin/ha"
export PATH="$WORK/bin:$PATH" HA_LOG="$WORK/ha.log" BASE_URL="file://$ROOT"

new_config() {
  rm -rf "$WORK/config"; mkdir -p "$WORK/config/.storage"
  : > "$WORK/config/configuration.yaml"
  printf '%s' '{"version":1,"minor_version":1,"key":"lovelace_resources","data":{"items":[{"id":"a1","url":"/hacsfiles/other/other.js","type":"module"}]}}' > "$WORK/config/.storage/lovelace_resources"
  : > "$HA_LOG"
}
card="$WORK/config/www/ha-doorbell-talk/ha-doorbell-talk-card.js"
cat > "$WORK/bin/urls" <<'URLS'
#!/bin/sh
jq -r '.data.items[].url' "$CONFIG_DIR/.storage/lovelace_resources"
URLS
chmod +x "$WORK/bin/urls"
export CONFIG_DIR="$WORK/config"

new_config
sh "$ROOT/install.sh" --config "$WORK/config" > "$WORK/out.txt" 2>&1
check "install copies the card byte for byte" cmp "$card" "$ROOT/ha-doorbell-talk-card.js"
check "install prints the resource URL with a version" grep -q '/local/ha-doorbell-talk/ha-doorbell-talk-card.js?v=' "$WORK/out.txt"
check "install says the www folder is new" grep -q 'restart Home Assistant once' "$WORK/out.txt"
check "install leaves Home Assistant and the resources alone" sh -c "[ ! -s '$HA_LOG' ] && ! grep -q doorbell '$WORK/config/.storage/lovelace_resources'"
sh "$ROOT/install.sh" --config "$WORK/config" > "$WORK/out2.txt" 2>&1
check "a second run works and the www folder is no longer new" sh -c "! grep -q 'restart Home Assistant once' '$WORK/out2.txt'"

new_config
sh "$ROOT/install.sh" --config "$WORK/config" --register > /dev/null 2>&1
check "register stops then starts Home Assistant in order" sh -c "[ \"\$(cat '$HA_LOG' | tr '\n' ' ')\" = 'core stop core start ' ]"
check "register adds one module resource and keeps the others" sh -c "[ \$(urls | grep -c ha-doorbell-talk) = 1 ] && urls | grep -q other.js && jq -e '.data.items[] | select(.url | contains(\"ha-doorbell-talk\")) | .type == \"module\"' '$WORK/config/.storage/lovelace_resources'"
check "register keeps a backup of the resources" test -f "$WORK/config/.storage/lovelace_resources.bak_ha-doorbell-talk"
sh "$ROOT/install.sh" --config "$WORK/config" --register > /dev/null 2>&1
check "registering twice does not duplicate the resource" sh -c "[ \$(urls | grep -c ha-doorbell-talk) = 1 ]"

sh "$ROOT/install.sh" --config "$WORK/config" --uninstall --register > /dev/null 2>&1
check "uninstall removes the file and the resource" sh -c "[ ! -e '$card' ] && ! urls | grep -q ha-doorbell-talk && urls | grep -q other.js"

new_config
rm -f "$WORK/config/.storage/lovelace_resources"
sh "$ROOT/install.sh" --config "$WORK/config" --register > /dev/null 2>&1
check "register creates the resources file when none exists" sh -c "urls | grep -q ha-doorbell-talk"

check "a directory without configuration.yaml is refused" sh -c "! sh '$ROOT/install.sh' --config '$WORK/empty'"

new_config
sh "$ROOT/install.sh" --config "$WORK/config" > /dev/null 2>&1
before=$(cksum < "$card")
BASE_URL="file://$WORK/missing" sh "$ROOT/install.sh" --config "$WORK/config" > /dev/null 2>&1
check "a failed download keeps the installed card" sh -c "[ \"\$(cksum < '$card')\" = '$before' ]"

exit $FAILED

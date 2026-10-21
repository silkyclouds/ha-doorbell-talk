#!/bin/sh
# Installs the doorbell talk card into the Home Assistant config directory.
#
#   curl -fsSL https://raw.githubusercontent.com/silkyclouds/ha-doorbell-talk/main/install.sh | sh
#
# Options, given after "sh -s --":
#   --config DIR   Home Assistant config directory (default /config)
#   --ref REF      branch or tag to download (default main)
#   --register     also add the dashboard resource: stops Home Assistant, edits .storage, starts it again
#   --uninstall    remove the card (with --register, also drop the resource entry)
#
# Without --register the script only copies one file into <config>/www/ha-doorbell-talk/ and prints
# the resource URL to add by hand in Settings > Dashboards > Resources.
set -eu

CONFIG=/config
REF=main
REGISTER=0
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --register) REGISTER=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

BASE_URL="${BASE_URL:-https://raw.githubusercontent.com/silkyclouds/ha-doorbell-talk/$REF}"
DIR="$CONFIG/www/ha-doorbell-talk"
FILE="ha-doorbell-talk-card.js"
RESOURCES="$CONFIG/.storage/lovelace_resources"
PREFIX="/local/ha-doorbell-talk/"

fail() { echo "Error: $1" >&2; exit 1; }

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi
}

hash8() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-8; else shasum -a 256 "$1" | cut -c1-8; fi
}

# Runs the given jq filter over the resources file while Home Assistant is stopped, keeping a backup.
edit_resources() {
  command -v jq >/dev/null 2>&1 || fail "--register needs jq"
  command -v ha >/dev/null 2>&1 || fail "--register needs the ha command (Terminal & SSH add-on)"
  mkdir -p "$CONFIG/.storage"
  SOURCE="$RESOURCES"
  if [ ! -f "$SOURCE" ]; then
    SOURCE="$RESOURCES.default"
    printf '%s' '{"version":1,"minor_version":1,"key":"lovelace_resources","data":{"items":[]}}' > "$SOURCE"
  fi
  jq "$1" "$SOURCE" > "$RESOURCES.edited" || fail "could not edit $RESOURCES"
  [ ! -f "$RESOURCES" ] || cp "$RESOURCES" "$RESOURCES.bak_ha-doorbell-talk"
  echo "Stopping Home Assistant to edit the resources..."
  ha core stop
  trap 'ha core start' EXIT
  mv "$RESOURCES.edited" "$RESOURCES"
  rm -f "$RESOURCES.default"
  trap - EXIT
  echo "Starting Home Assistant..."
  ha core start
}

drop_entries='.data.items |= map(select(.url | startswith("'"$PREFIX"'") | not))'

if [ "$UNINSTALL" = 1 ]; then
  rm -rf "$DIR"
  echo "Removed $DIR"
  if [ "$REGISTER" = 1 ]; then edit_resources "$drop_entries"; else
    echo "Delete the resource starting with $PREFIX in Settings > Dashboards > Resources."
  fi
  exit 0
fi

[ -f "$CONFIG/configuration.yaml" ] || fail "$CONFIG does not look like a Home Assistant config directory (use --config)"
NEW_WWW=0
[ -d "$CONFIG/www" ] || NEW_WWW=1
mkdir -p "$DIR"
fetch "$BASE_URL/$FILE" > "$DIR/$FILE.part" || { rm -f "$DIR/$FILE.part"; fail "download failed from $BASE_URL/$FILE"; }
grep -q 'doorbell-talk-card' "$DIR/$FILE.part" || { rm -f "$DIR/$FILE.part"; fail "the downloaded file is not the card"; }
mv "$DIR/$FILE.part" "$DIR/$FILE"
URL="${PREFIX}${FILE}?v=$(hash8 "$DIR/$FILE")"
echo "Installed $DIR/$FILE"

if [ "$REGISTER" = 1 ]; then
  ID=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  edit_resources "$drop_entries | .data.items += [{\"id\": \"$ID\", \"url\": \"$URL\", \"type\": \"module\"}]"
  echo "Resource registered: $URL"
else
  echo
  echo "Next: Settings > Dashboards > three dots > Resources > Add resource"
  echo "  URL:  $URL"
  echo "  Type: JavaScript module"
fi
[ "$NEW_WWW" = 1 ] && echo "The www folder is new: restart Home Assistant once so it serves /local/."
echo
echo "Then add the card to a dashboard:"
echo "  type: custom:doorbell-talk-card"
echo "  entity: camera.your_doorbell_fluent"

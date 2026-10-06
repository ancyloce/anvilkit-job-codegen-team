#!/bin/sh
# Smoke check of a built anvilkit-codegen-team image (no network, no
# sidecar): the trusted files are root-only (directories 0700, files 0600),
# the supervisor and the coordinator read them as UID 0 with only SETUID,
# SETGID and SETPCAP (as the Job template grants), the candidate identity
# reads none of them but executes the team package, the reviewed tools match
# this build, and the supervisor refuses to run without its launch facts.
# It proves the image's layout, not any runtime isolation.
#
#   sh tools/image-smoke.sh <image>
set -eu
image=${1:?usage: image-smoke.sh <image>}
caps="--cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add SETPCAP"
run() { docker run --rm --network none --read-only --tmpfs /tmp "$@"; }

echo "modes of the trusted files"
run --entrypoint sh "$image" -c '
  set -e
  bad=$(find /anvilkit/agent /anvilkit/fixtures /etc/anvilkit/anvilkit-codegen \( -type d ! -perm 0700 \) -o \( -type f ! -perm 0600 \) -o ! -user 0)
  [ -z "$bad" ] || { echo "not root-only 0700/0600: $bad"; exit 1; }
  test -x /usr/local/bin/anvilkit-codegen-supervisor && test -x /usr/local/bin/anvilkit-codegen-candidate
  test -f /anvilkit/team/contract/protocol.schema.json && test -f /anvilkit/validator/dist/cli.js'

echo "the coordinator's reads as UID 0 with the reviewed capability set only"
# shellcheck disable=SC2086
run $caps --entrypoint /usr/local/bin/node -w /anvilkit/team "$image" --input-type=module -e '
  import { readFileSync } from "node:fs";
  const { loadTeamConfig } = await import("/anvilkit/team/dist/config.js");
  const { loadPrompts } = await import("/anvilkit/team/dist/team/roles.js");
  const { protocolSchema } = await import("/anvilkit/team/dist/protocol.js");
  const status = readFileSync("/proc/self/status", "utf8");
  if (!/^CapEff:\s*00000000000001c0$/m.test(status)) throw new Error("not the reviewed capability set: " + status.match(/^CapEff.*$/m));
  loadTeamConfig("/etc/anvilkit/anvilkit-codegen/team.yaml");
  loadPrompts("/anvilkit/agent");
  readFileSync("/etc/anvilkit/anvilkit-codegen/config.yaml");
  readFileSync("/anvilkit/agent/resources.json");
  readFileSync("/anvilkit/fixtures/brief.json");
  if (protocolSchema().$id !== "urn:anvilkit:codegen-protocol:v1") throw new Error("protocol schema");
  console.log("ok");'
# shellcheck disable=SC2086
run $caps --entrypoint /usr/local/bin/node "$image" /anvilkit/team/dist/tools.js --check /anvilkit/agent/team/tools.json

echo "the candidate identity reads no trusted file and runs the team package"
run --user 10001:10001 --entrypoint sh "$image" -c '
  for f in /anvilkit/agent/team/prompts/coder.md /anvilkit/agent/resources.json /etc/anvilkit/anvilkit-codegen/team.yaml /anvilkit/fixtures/brief.json; do
    if cat "$f" >/dev/null 2>&1; then echo "readable by the candidate: $f"; exit 1; fi
  done
  node -e "import(\"/anvilkit/team/dist/round.js\").then(() => console.log(\"ok\"))"'

echo "the supervisor without its launch facts runs nothing"
# shellcheck disable=SC2086
if run $caps "$image" team >/dev/null 2>&1; then echo "the supervisor ran without launch facts"; exit 1; fi
echo "image smoke: PASS"

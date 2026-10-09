#!/bin/sh
# Smoke check of a built anvilkit-codegen-team image (no network, no
# sidecar): the trusted files are root-only (directories 0700, files 0600),
# the supervisor and the coordinator read them as UID 0 with only SETUID,
# SETGID and SETPCAP (as the Job template grants), the candidate identity
# reads none of them but executes the team package, the reviewed tools match
# this build, Pi's grep runs the image's pinned ripgrep from the root-owned
# agent directory with no network, better-sqlite3's addon (built from source
# in the image) loads, and the supervisor refuses to run without its launch
# facts.
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

echo "Pi's ripgrep: the image's pinned rg in the root-owned agent directory, run offline by the coder's grep tool"
run --user 10001:10001 --entrypoint sh "$image" -c '
  set -e
  [ "$(stat -c %u:%a /opt/pi-agent /opt/pi-agent/bin | tr "\n" " ")" = "0:755 0:755 " ] || { echo "the Pi agent directory is not root-owned 0755"; exit 1; }
  [ "$(readlink /opt/pi-agent/bin/rg)" = /usr/bin/rg ] && /opt/pi-agent/bin/rg --version | head -n 1 | grep -q "^ripgrep 14\.1\.1"
  if touch /opt/pi-agent/bin/probe 2>/dev/null; then echo "the candidate writes the Pi bin directory"; exit 1; fi'
# The candidate HOME holds a planted rg where the SDK would download one; the
# coder's grep (its Pi environment pinned by the module itself) never runs it.
run --user 10001:10001 -e HOME=/tmp/home --entrypoint /usr/local/bin/node -w /tmp "$image" --input-type=module -e '
  import { existsSync, mkdirSync, writeFileSync } from "node:fs";
  mkdirSync("/tmp/src", { recursive: true });
  writeFileSync("/tmp/src/a.ts", "export const needle = 1;\n");
  mkdirSync("/tmp/home/.pi/agent/bin", { recursive: true });
  writeFileSync("/tmp/home/.pi/agent/bin/rg", "#!/bin/sh\ntouch /tmp/planted-rg-ran\n", { mode: 0o755 });
  const { coderTools } = await import("/anvilkit/team/dist/pi/boundary.js");
  const [grep] = coderTools("/tmp/src", ["grep"]);
  const r = await grep.execute("smoke", { pattern: "needle" });
  const text = r.content[0].text;
  if (!text.includes("a.ts:1: export const needle")) throw new Error("grep: " + text);
  if (existsSync("/tmp/planted-rg-ran") || process.env.PI_CODING_AGENT_DIR !== "/opt/pi-agent" || process.env.PI_OFFLINE !== "1")
    throw new Error("the coder did not run the image rg offline");
  console.log("ok");'

echo "better-sqlite3: the addon built from source in the image loads"
run --user 10001:10001 --entrypoint /usr/local/bin/node -w /anvilkit/team "$image" -e 'const Database = require("better-sqlite3"); new Database(":memory:").close(); console.log("ok")'

echo "the supervisor without its launch facts runs nothing"
# shellcheck disable=SC2086
if run $caps "$image" team >/dev/null 2>&1; then echo "the supervisor ran without launch facts"; exit 1; fi
echo "image smoke: PASS"

#!/bin/sh
# Builds better-sqlite3's native addon (the SqliteSaver checkpointer needs
# it) from the locked package's own sources — the SQLite amalgamation it
# ships, integrity-checked by pnpm-lock.yaml — with the node-gyp of the npm
# bundled with the running Node, against that Node's own headers
# (--nodedir: nothing is downloaded). pnpm-workspace.yaml denies the
# package's install script, which would fetch a prebuilt binary from the
# network at install time; this script replaces it in the image's build
# stage (Dockerfile), in CI and on a development checkout, after
# `pnpm install --frozen-lockfile`. It needs python3, make and a C++
# compiler, and it checks that the addon loads.
#
#   sh tools/build-better-sqlite3.sh [package-root]
set -eu
root=${1:-.}
node=$(command -v node)
prefix=$(dirname "$(dirname "$node")")
gyp="$prefix/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
[ -f "$gyp" ] || { echo "build-better-sqlite3: no node-gyp of the bundled npm at $gyp" >&2; exit 2; }
[ -f "$prefix/include/node/node.h" ] || { echo "build-better-sqlite3: no Node headers under $prefix/include/node" >&2; exit 2; }
pkg=$(cd "$root" && node -p 'require("node:path").dirname(require.resolve("better-sqlite3/package.json"))')
cd "$pkg"
node "$gyp" rebuild --release --nodedir="$prefix" --jobs=max
node -e 'const Database = require("./lib"); new Database(":memory:").close(); console.log("better-sqlite3: built from source and loaded")'

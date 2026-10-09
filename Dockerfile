# anvilkit-codegen-team: the codegen Job image of the bounded LangGraph/Pi
# team (delivery.md P12; the profile codegen-team-dev-v1 pins it with
# "anvilkit-codegen-supervisor team" as its entrypoint). It is the
# independent validator's image (anvilkit-job-validator: Debian 13, the
# pinned Node without npm, npx, corepack, yarn or pnpm, setpriv, the
# validator's locked toolchain and Chromium headless shell, its contract
# schemas, the candidate and harness UIDs), named by digest, with the
# trusted supervisor of anvilkit-job-codegen-supervisor and this repository's
# team package (the trusted coordinator and the Pi coder with their locked
# install) added.
#
# Build contexts: this repository, plus the supervisor's sources at the
# commit this repository pins (.github/workflows/ci.yml, SUPERVISOR_REF) as
# the named context "supervisor":
#
#   docker build --build-context supervisor=<anvilkit-job-codegen-supervisor checkout> -t anvilkit-codegen-team .
#
# The validator image is a fixed input by digest; VALIDATOR_REPOSITORY names
# where it is pulled from (a registry CI reaches, or the development
# registry: --build-arg VALIDATOR_REPOSITORY=localhost:5001/anvilkit-validator).
# The digest stays the one below whatever the repository.
ARG VALIDATOR_REPOSITORY=ghcr.io/ancyloce/anvilkit-validator

FROM golang:1.27.0-alpine@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS supervisor-build
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOWORK=off GOFLAGS=-mod=readonly CGO_ENABLED=0 GOPROXY=$GOPROXY
WORKDIR /src
COPY --from=supervisor go.mod go.sum ./
RUN go mod download
COPY --from=supervisor cmd ./cmd
COPY --from=supervisor internal ./internal
RUN go build -trimpath -ldflags="-s -w" -o /out/anvilkit-codegen-supervisor ./cmd/anvilkit-codegen-supervisor \
 && go build -trimpath -ldflags="-s -w" -o /out/anvilkit-codegen-candidate ./cmd/anvilkit-codegen-candidate

# The team package: its locked install with no lifecycle script run (the
# workspace file denies them all), better-sqlite3's native addon built here
# from the locked package's own sources against this pinned Node's headers
# (tools/build-better-sqlite3.sh: npm's bundled node-gyp, --nodedir, no
# prebuilt binary fetched; the toolchain is Debian trixie's from the signed
# archive of the pinned base — the validator's runtime base, so the addon
# links against the glibc it runs on), and the compiled entrypoints; the
# reviewed tools document is checked against this build and the addon is
# loaded once more after the production prune. npm (the base image's) and
# pnpm exist in this stage only.
FROM node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de AS team-build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN npm install -g pnpm@12.3.4
# Network resilience only: a longer per-request timeout and more retries so a
# slow registry download completes instead of timing out mid-stream. The
# frozen lockfile and the exact resolved versions are unchanged.
ENV npm_config_fetch_timeout=600000 npm_config_fetch_retries=6 npm_config_fetch_retry_maxtimeout=600000
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY tools/build-better-sqlite3.sh ./tools/build-better-sqlite3.sh
RUN pnpm install --frozen-lockfile \
 && sh tools/build-better-sqlite3.sh
COPY src ./src
COPY agent /agent
RUN pnpm run build \
 && node dist/tools.js --check /agent/team/tools.json \
 && pnpm install --frozen-lockfile --prod \
 && node -e 'const Database = require("better-sqlite3"); new Database(":memory:").close()'

FROM ${VALIDATOR_REPOSITORY}@sha256:274076d0354f6ef691936578914bc748cd71a4ad1ccb1365ef3fc26ce5d51178
# Pi's grep tool runs ripgrep. It is Debian trixie's package at an exact
# version (from the signed archive), and the root-owned Pi agent directory's
# bin/rg names it: the SDK's tools manager looks in <agent dir>/bin first,
# then on PATH, and downloads the latest release into that bin directory
# when neither has one and PI_OFFLINE is unset. The coder pins
# PI_OFFLINE=1 and PI_CODING_AGENT_DIR=/opt/pi-agent itself before Pi loads
# (src/pi/environment.ts), because the supervisor hands the candidate a
# fixed environment; the same values are set here for every other process.
# Nothing in /opt/pi-agent is writable by the candidate, and its HOME's
# .pi/agent/bin is never consulted.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep=14.1.1-1+b4 \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o 0 -g 0 -m 0755 /opt/pi-agent /opt/pi-agent/bin \
 && ln -s /usr/bin/rg /opt/pi-agent/bin/rg
ENV PI_OFFLINE=1 PI_CODING_AGENT_DIR=/opt/pi-agent
COPY --from=supervisor-build /out/anvilkit-codegen-supervisor /out/anvilkit-codegen-candidate /usr/local/bin/
COPY --from=team-build /src/node_modules /anvilkit/team/node_modules
COPY --from=team-build /src/dist /anvilkit/team/dist
COPY --from=team-build /src/package.json /anvilkit/team/package.json
COPY contract/protocol.schema.json /anvilkit/team/contract/protocol.schema.json
COPY --from=supervisor config.yaml /etc/anvilkit/anvilkit-codegen/config.yaml
COPY team.yaml /etc/anvilkit/anvilkit-codegen/team.yaml
COPY --from=supervisor agent/resources.json /anvilkit/agent/resources.json
COPY agent/team/tools.json /anvilkit/agent/team/tools.json
COPY agent/team/prompts /anvilkit/agent/team/prompts
COPY --from=supervisor fixtures/fixed-input.txt /anvilkit/fixtures/fixed-input.txt
COPY fixtures/brief.json /anvilkit/fixtures/brief.json
# The candidate identity executes the team package (the Pi coder runs as
# UID 10001 from it) and nothing else of what was added: the agent
# directory, the fixtures and the configuration are root-only — directories
# 0700 and files 0600, so the supervisor and the coordinator (UID 0 without
# CAP_DAC_OVERRIDE) traverse and read them and no other identity can.
RUN chmod -R a+rX,go-w /anvilkit/team \
 && chown -R 0:0 /anvilkit/agent /anvilkit/fixtures /etc/anvilkit/anvilkit-codegen \
 && find /anvilkit/agent /anvilkit/fixtures /etc/anvilkit/anvilkit-codegen -type d -exec chmod 0700 {} + \
 && find /anvilkit/agent /anvilkit/fixtures /etc/anvilkit/anvilkit-codegen -type f -exec chmod 0600 {} +
ENV ANVILKIT_CODEGEN_CONFIG=/etc/anvilkit/anvilkit-codegen/config.yaml
# The supervisor starts as UID 0 in its container; the Job template grants
# it SETUID, SETGID and SETPCAP only, and it drops to 10001 for the candidate.
USER 0:0
ENTRYPOINT ["/usr/local/bin/anvilkit-codegen-supervisor"]

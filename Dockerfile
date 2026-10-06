# anvilkit-codegen-team: the codegen Job image of the bounded LangGraph/Pi
# team (delivery.md P12; the profile codegen-team-dev-v1 pins it with
# "anvilkit-codegen-supervisor team" as its entrypoint). It is the
# independent validator's image (anvilkit-job-validator: Debian, the pinned
# Node, pnpm, setpriv, the validator's locked toolchain and Chromium headless
# shell, its contract schemas, the candidate UID), named by digest, with the
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

# The team package: its locked install (better-sqlite3's prebuilt binary is
# the one lifecycle script the workspace file allows) and the compiled
# entrypoints; the reviewed tools document is checked against this build.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS team-build
WORKDIR /src
RUN npm install -g pnpm@12.3.4
# Network resilience only: a longer per-request timeout and more retries so a
# slow registry download completes instead of timing out mid-stream. The
# frozen lockfile and the exact resolved versions are unchanged.
ENV npm_config_fetch_timeout=600000 npm_config_fetch_retries=6 npm_config_fetch_retry_maxtimeout=600000
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY agent /agent
RUN pnpm run build \
 && node dist/tools.js --check /agent/team/tools.json \
 && pnpm install --frozen-lockfile --prod

FROM ${VALIDATOR_REPOSITORY}@sha256:2e21d74764e312c6b69598e2f7ca236c8ae8509486edff8eb1a165cecaca80d2
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

# anvilkit-job-codegen-team (`@anvilkit/codegen-team`)

The bounded LangGraph/Pi coding team of the AnvilKit codegen Job (architecture DD-03 §1–§3 and §6 in `anvilkit-services`, delivery.md P12) and the final Codegen Job image. Two entrypoints of one locked package, both started inside the Job by the trusted supervisor of [`anvilkit-job-codegen-supervisor`](https://github.com/ancyloce/anvilkit-job-codegen-supervisor):

| Entrypoint | Identity | What it is |
|---|---|---|
| `dist/coordinator.js` | trusted (UID 0, a child of the supervisor) | The team in one attempt: inputs and scope, Control's accepted stage first, the LangGraph `StateGraph` of the fixed roles, the joint stage over `SqliteSaver`, the independent validation step, the scoped transfers and the one result submission |
| `dist/coder.js` | candidate (UID 10001, launched by the supervisor through its privilege-drop trampoline on the coordinator's request, stopped and confirmed by it) | The one Pi source writer: a `@earendil-works/pi-coding-agent` session with a fixed resource loader, the file tools bound to the source directory, and the controlled model port over `candidate.sock` as its only transport |

Nothing here holds a credential or reaches a provider or a network: every model send is one request on the access sidecar's controlled model relay, which binds the scope Control confirms now and forwards to the Model Proxy, where the single-use admission and the one physical send happen (P11).

## Modules

| Module | Responsibility |
|---|---|
| `src/coordinator.ts` | Entrypoint: assembly and top-level errors only |
| `src/coordinator/inputs.ts` | The coordinator's inputs: reviewed configuration, prompts and tools, launch envelope, the scope Control confirms (it must name the envelope's operation, attempt, profile and launch key), the absolute deadline (never reset), the stage identity, the team profile digest (graph revision, stage format, configuration, prompts, tools) |
| `src/coordinator/recovery.ts` | The recovery decision: Control's accepted stage of this attempt proven against the local objects (nothing runs again), or a repair launch's prior accepted stage proven against Control's record before its sealed source is the tree to repair — unpacked into the trusted, read-only prior tree (`<workspace>/prior/source`), which the repair round's coder copies into its own source directory; counters and budget continue, nothing is replayed — or a fresh run from the frozen brief, its identity and source revision bound to the launch envelope's `component` when the launcher states one |
| `src/coordinator/run.ts` | Team execution: the port, executor, validator and retrieval assembled; trusted directories created before any candidate runs; the graph invoked under the launch's cancellation; how a run that ended by an error is classified; a final refusal, a protocol violation or the cancellation end the attempt without a stage |
| `src/coordinator/completion.ts` | The team result (`team/result.json`, the protocol's `teamResult`): verdict consistent with the outcome whatever ended the run, checked against the contract before it is written |
| `src/team/graph.ts` | The graph's wiring only (and its revision, part of the team profile digest) |
| `src/identity.ts` | The allocated component identity (P0.8, SEC-12): a sealed source whose `component.json` or `package.json` declares another `componentId`, `puckType` or package than the brief is invalid (`IDENTITY_MISMATCH`) before any validation; a launch whose envelope `component` (the revision always, the identity all three members or none) and brief disagree runs nothing |
| `src/team/nodes/{specialists,coding,validation}.ts`, `src/team/routing.ts`, `src/team/state.ts`, `src/team/context.ts` | The nodes (Planner, Retrieval, the reviewer fan-out and reviewers; the coder round; validation), the bounded decisions (review or validate; repair only after a repairable independent result within the repair bound, the allowance and the deadline; classification), the state with its reducers, the node context (ports, budget, ordinals, deadline guard) |
| `src/team/roles.ts`, `src/team/tools.ts`, `src/team/retrieval.ts` | The specialists' structured outputs through reviewed tools, the reviewed tools document, the Knowledge route (insufficient evidence in this build, never invented citations) |
| `src/budget.ts` | The budget: every call at the per-send exposure Control reserves, integer money, role and aggregate allowances, non-overlapping reservations for concurrent roles |
| `src/port/model.ts`, `src/port/pi.ts` | The ControlledModelPort (one relay request per call under a deterministic identity, no retry, no fallback, an unknown outcome fences every other identity until reconciled) and its Pi `StreamFn` |
| `src/pi/session.ts`, `src/pi/resources.ts`, `src/pi/boundary.ts`, `src/pi/environment.ts` | The Pi session's assembly (in-memory settings, retries off, the controlled provider, the default stream function refused), its fixed resources (one trusted prompt; nothing discovered), its file-operation boundary (every path, glob and link proven under the source root), and its tool environment pinned before the SDK loads (`PI_OFFLINE=1`, the image's root-owned agent directory `/opt/pi-agent`: grep runs the image's ripgrep, never a download, never the candidate's `$HOME/.pi/agent/bin`) |
| `src/stage/{manifest,archive,seal,proof,store}.ts` | The joint stage: manifest rules (format, identity, epochs, team profile), archive operations (reproducible; a member twice refuses the archive), sealing (nothing submitted after a cancellation), recovery proofs (Control first; every object against the accepted stage) and the StageStore port |
| `src/adapters/{supervisor,sidecar,validator}.ts` | The supervisor over the process protocol, the access sidecar's sockets, the independent validator's chain as a bounded child process — given the launch's source revision and the allocated identity, a certification must bind exactly them; once the chain has ended, every process of its step identities (the candidate's and its SSR harness's, `uid`/`harnessUid` in `team.yaml`) left in the launch's tree — an orphan reparented to the supervisor, VAL-05 — is stopped as that identity and confirmed gone before the run is read; a run that left one is not read (`OBSERVER_FAILED`), an unconfirmed stop ends the attempt without a stage |
| `src/protocol.ts` | The process protocol codec over the contract copy |
| `src/executor.ts`, `src/source.ts`, `src/coder.ts`, `src/round.ts` | One coding round at a time (a second writer is refused), the sealed source and session, the round input the coder is bound to and the outcome it leaves as data (how its last call failed included) |
| `src/config.ts`, `src/contracts.ts`, `src/digest.ts`, `src/tools.ts` | `team.yaml`; the job and component schemas and strict JSON; digests; the tools document CLI |

## Process protocol

The supervisor and this coordinator speak the codegen process protocol: its single source is `anvilkit-agent-contracts` `jobs/codegen/protocol.schema.json` (`urn:anvilkit:codegen-protocol:v1`); `contract/` holds the verbatim copy and its digests (`SOURCE`), refreshed and verified with `sh tools/sync-protocol.sh [--check] <contracts-checkout>`. Requests are written only after they validate; answers are parsed strictly (one object, no duplicate member, at most 65536 bytes) and validated; an answer for another request or round, or one never asked for, breaks the channel and ends the run without a stage. A refusal `STOP_NOT_ESTABLISHED` or `CANDIDATE_NOT_RUN` is final: nothing is sealed or submitted, because nothing proves that no candidate still writes.

## Budgets

The Model Proxy reserves the route's reviewed full bound (`max_exposure`) at Control for **every** send, whatever a caller declares. `team.yaml`'s `route.exposurePerSend` must equal that bound: every call declares it as its `maxExposure` and is accounted at it, per role (`roles.*.maxCalls`) and in aggregate (`aggregate.maxCalls`, `aggregate.exposure`). Because a call costs at most what Control reserved for it, an operation allocation that covers `aggregate.exposure` is never exceeded by the team's own sends; concurrent reviewers draw on non-overlapping reservations of whole sends, so one remaining send never funds two. Control stays the authority: a smaller allocation is Control's to deny, and a denial inside a coder round ends the run `model_denied` (verdict `infrastructure_failed`), never as a candidate defect; the local allowance running out ends it `budget_exhausted` before a send. (Before this repository's split the team declared a per-role `exposurePerCall` of a fraction of the route's reservation, so its accounting funded concurrent sends Control denied, and a denied coder round was sealed as a repairable source defect.)

## Recovery and compatibility

The team profile digest binds the graph revision (`teamGraphRevision`), the stage manifest format (`stageFormat`, 2), `team.yaml`, the prompts and the reviewed tools; a stage sealed under any other of them — an earlier format or wiring included — is refused (`STALE_STAGE`) and never resumed. A checkpoint database left by an earlier coordinator of the same launch is set aside, never resumed: Control's accepted stage is the only boundary.

## Image

`Dockerfile` builds the final Codegen Job image: the supervisor's sources (the named build context `supervisor`, at `SUPERVISOR_REF`), this package (locked install with no lifecycle script run, better-sqlite3's addon built from its locked sources against the pinned Node's headers by `tools/build-better-sqlite3.sh`, build, tools check), Debian trixie's `ripgrep` at an exact version as `/opt/pi-agent/bin/rg` (root-owned; `PI_OFFLINE=1`) and the trusted files on the independent validator's image named by digest (`VALIDATOR_REPOSITORY` only names where it is pulled from). Trusted directories are `0700` and files `0600`, root-owned, so the supervisor and the coordinator — UID 0 without `CAP_DAC_OVERRIDE` — read them and the candidate identity reads none. `tools/image-smoke.sh <image>` checks that layout with the reviewed capability set.

```sh
docker build --build-context supervisor=<anvilkit-job-codegen-supervisor checkout> -t anvilkit-codegen-team .
sh tools/image-smoke.sh anvilkit-codegen-team
```

## Verification

```sh
pnpm install --frozen-lockfile && sh tools/build-better-sqlite3.sh
pnpm run check-types && pnpm run lint && pnpm run build && pnpm run tools:check
ANVILKIT_CODEGEN_TEAM_CONTRACTS_DIR=<contracts> ANVILKIT_VALIDATOR_PACKAGE=<built anvilkit-job-validator> pnpm test
sudo env "PATH=$PATH" ANVILKIT_REQUIRE_ROOT_TESTS=1 pnpm exec vitest run test/prior.test.ts test/validation.test.ts -t root
sh tools/sync-protocol.sh --check <contracts>
```

No lifecycle script runs at install (`pnpm-workspace.yaml`): `tools/build-better-sqlite3.sh` builds the checkpointer's native addon from the locked package's sources with the node-gyp bundled with npm and the running Node's headers (python3, make and a C++ compiler needed; nothing downloaded). The root tests (a root caller with util-linux `unshare`, `mount` and `setpriv`, and the built package) run the repair round's coder as UID 10001 — the package and Node are bind-mounted at a world-traversable stage in the coder's own mount namespace — and the validator's stop of a detached step process in a private PID namespace; as root they run with `pnpm test` too, and `ANVILKIT_REQUIRE_ROOT_TESTS` turns their skip into a failure.

Build first: the tests spawn `dist/coder.js` and `dist/coordinator.js` as child processes. They use a countable double of the sidecar (`test/doubles.ts`: one send per call identity, replay of the record, conflicts, cut streams, refusals, unknown outcomes), a double of the supervisor over the real protocol, the validator's fixed Hero component as the coder's output, and the real validator chain (`test/validation.test.ts`, skipped without a built validator unless `ANVILKIT_REQUIRE_VALIDATOR` is set, as CI does). In the parent checkout the contracts and the validator are found beside this repository. The parent's `tests/integration/team_integration_test.go` runs the whole chain with real processes against the development foundation. No sandbox, gVisor or runtime qualification follows from these tests; `codegen-team-dev-v1` stays DISABLED.

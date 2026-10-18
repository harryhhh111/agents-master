# Route A: offline synthetic isolation prototype

This is an experiment, not an application backend or a production security boundary.
It invokes **only `codex --version`, `codex sandbox --help`, and `codex sandbox`**;
there are no model, provider, start, resume, MCP, or plugin calls.

From `/home/vinci/projects/agents-master`:

```sh
python3 -B scripts/prechecks/cli-isolation/runner.py --test
timeout --signal=TERM --kill-after=5s 100s python3 -B scripts/prechecks/cli-isolation/runner.py
```

Exit 0 for the experiment means only its scoped executable probes passed. Exit 2
means BLOCKED or a failed/unverified check. Unexpected setup/execution exceptions
also exit 2 and emit `reason: HARNESS_ERROR`, `status: BLOCKED`, and
`isolation_verdict: UNVERIFIED`, with the failing stage and exception type. A unique
`harness-failure-UUID.json` is appended and `summary.json` is created only if absent;
existing files, including incomplete JSON, are preserved. If storage itself fails,
structured stdout reports `evidence_write_error`. Nothing automatically retries
with weaker permissions. Each subprocess
has a 15-second timeout and its process group is killed on timeout. The outer timeout
bounds the whole experiment. Use the second exact command for a coordinator-approved
rerun in an appropriate execution context; **do not add sudo, bypass flags, change
host socket ownership/modes, or disable the sandbox**. This implementation does not
request or obtain that approval.

Evidence is appended to a unique `run-UTC-UUID` directory under
`.agent-artifacts/prechecks-2026-10-16/cli-isolation/` (already git-ignored).
No run is erased, reused, or overwritten. JSON is serialized before exclusive file
creation; serialization failure cannot leave a new partial JSON file. Disk errors
may still leave partial writes, which are preserved. Abstract Unix socket addresses
returned as bytes are recorded as `{ "encoding": "hex", "value": "..." }`, retaining
the leading NUL and any non-UTF-8 bytes without lossy decoding.
`private/` is mode 0700, its files are
created under umask 077, and all state/output is outside `snapshot/`. No real HOME,
auth/config, histories, `.env`, SSH material, chat database, or other project is
copied or probed. The local CLI binary alone is reused. A preliminary `unshare`
diagnostic creates only an ephemeral user/mount namespace and executes `true`.

## Native policy first

The runner generates a fresh unauthenticated `CODEX_HOME/config.toml` with:

```toml
default_permissions = "route_a"
approval_policy = "never"
web_search = "disabled"
[mcp_servers]
[plugins]
[features]
use_legacy_landlock = false
[permissions.route_a.filesystem]
":minimal" = "read"
"/absolute/path/to/this/run/snapshot" = "read"
"/absolute/resolved/path/to/codex" = "read"
[permissions.route_a.network]
enabled = false
```

It selects `-P route_a`; there is no legacy `-s` or `sandbox_mode`. Local 0.161.0 help
also exposes `--sandbox-state-json`; the prototype does not invent a state schema or
claim that option has been exercised. See the official
[permission documentation](https://learn.chatgpt.com/docs/permissions) for profile
syntax. Documentation describes intended behavior; only probe results establish
observed behavior.

The additional exact-file rule is a **runtime dependency**, separate from the
project input snapshot. The coordinator's externally approved run
`run-20261016T023409Z-96c705329db940ee917325431edd3a36` passed all four listener
positive controls, then failed at bubblewrap `execvp` because the standalone Codex
executable was absent from the restricted view. That is the current observed
failure; the earlier socket-directory failure belongs to an earlier run.

The runner resolves the launcher symlink strictly, opens the resolved file with
`O_NOFOLLOW`, requires a regular executable ELF file, and records its SHA-256,
resolved path, file identity, and version in `runtime-executable.json`. It invokes
that canonical path and requires `codex-cli 0.161.0`. Hash/identity are checked after
version inspection and immediately before/after the native probe; drift blocks the
run. The final observation is saved separately in `runtime-executable-after.json`.
These checks detect observed drift; they are not a race-free executable mount or
an independently authenticated release digest. Concurrent replacement between
inspection and execution remains a production-hardening limitation.

Only the executable file is granted read access, never its `bin`, release,
`.codex`, or HOME directory. Auth, configuration, and sessions are not granted or
read. No automatic dependency discovery/widening is implemented. A missing
additional runtime dependency must remain blocked for explicit path/rationale
review; a script wrapper or unverified CLI version is also rejected.

The CLI resolves policy with fixed `-C /usr/bin`, a minimal runtime directory,
then the sandboxed Python payload changes to the synthetic snapshot. Hostile
`snapshot/.codex/config.toml` and `AGENTS.md` are fixtures, never intentionally used
as parent policy inputs. No caller-supplied cwd/config/argv or general workload is
accepted. This avoids project-layer policy resolution by construction; enforcement
against the hostile fixture still requires a completed native probe. It does not
prove that native profile merging is safe when launched directly in a hostile repo.

## Probe and evidence interpretation

`native-probe.json` records argv, environment **names**, timeout, status, and raw
synthetic stdout/stderr. `summary.json` requires a completed payload, every check,
unchanged content/modes, and successful network positive controls before reporting
`PASS_SCOPED_PROBES`. Sandbox initialization failure is BLOCKED, never a successful
denial. Snapshot hashes unchanged without payload execution are not immutability
evidence. `evidence-sha256.json` hashes the run files except itself.

Probes cover allowed input; four outside fake secrets; file/directory symlink
escapes; a fake parent auth file; parent `/proc/PID/fd/N` and `/proc/PID/root` paths
to **only a held synthetic file**; inherited-fd closure; mutation/create/chmod/
rename/delete; private-state writes; environment filtering; direct IPv4 loopback
TCP; filesystem Unix sockets inside/outside the snapshot; and an abstract Unix
socket. Listeners are synthetic and local, with same-process connection positive
controls. Failed positive controls yield UNVERIFIED, even if a sandbox connect fails.
No Internet requests are needed. Other protocols, real SSH agents, namespace races,
hardlink ingestion, device access, and all `/proc` variants are not comprehensively
tested. The generated snapshot is not a general secure importer for arbitrary repos.

Twelve offline tests exercise exact binding equality, individual binding drift,
missing/extra fields, missing/unknown/failed capabilities, hostile-config digest
drift, env construction, and an actual child process with fake credentials injected
into its parent, lossless socket-address serialization, exclusive JSON writes,
injected setup failures with partial evidence, exact-file runtime grants, and
symlink resolution/hash drift/rejection of invalid runtime targets. Regression fixtures are retained
in fresh artifact directories; injected failure records are test evidence, not native
sandbox denials. These are host-gate/harness mechanics, not actual model lifecycle evidence.

## Parent versus tool boundary and proposed lifecycle

`codex sandbox` restricts its command child; it does **not** prove the entire Codex
parent is isolated. The synthetic parent receives fresh empty state and an explicit
environment allowlist; `close_fds=True` excludes inherited descriptors. A production
CLI parent may need provider credentials and authenticated service traffic while
its tool child must not see those credentials, config, broker sockets, or histories.
That requires a separately constrained parent/provider broker and audited tool,
MCP, plugin, hook, skill, browser, and service paths. These remain UNVERIFIED here.
Empty MCP/plugin config and disabled web intent are not runtime integration proof.
Never expose an unrestricted credential-bearing Unix socket to the child.

Proposed host-owned record: session ID, backend, project key, input digest, policy
version/digest, effective-config digest, CLI version, platform identity, and provider.
Start must require all capabilities verified for that exact combination, freeze the
snapshot and trusted record, and launch only the bound policy. Resume must reload
the record from private host storage, reverify capabilities and digests, and reject
every changed/missing field before launch. Never accept a model-supplied capability
claim. `admit()` implements only the equality/fail-closed portion for offline tests;
it trusts its caller to supply genuine evidence and does not implement a broker,
durable authenticated binding store, concurrency protection, or actual start/resume.
As integration and lifecycle capabilities remain unverified, a real workload must
remain blocked even if every synthetic shell probe eventually passes.

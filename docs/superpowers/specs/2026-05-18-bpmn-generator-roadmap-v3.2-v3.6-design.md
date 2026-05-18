# BPMN Generator Roadmap — v3.2 → v3.6

**Date**: 2026-05-18
**Status**: Approved design, ready for implementation planning per phase
**Horizon**: ~8-10 weeks
**Primary goals**: Open-Source visibility + productive third-party use

## Why this roadmap exists

The repo is in a strong technical state after PR #8 (Visual Refinement) and PR #12 (Robustness Stack), but documentation has drifted from code: rule count, test count, module inventory, and several "Known Limitations" no longer reflect reality. At the same time, the project competes in a well-occupied space (ProMoAI, BPMN Assistant, BPMN-Chatbot) without yet making its differentiators verifiable to outsiders, and the public-facing HTTP API has SSRF gaps and an opt-in auth model that is not safe to expose.

This roadmap targets a phased, public rollout (v3.2 → v3.6) that — in order — restores documentation honesty, hardens the public API, produces reproducible differentiation evidence, exposes a live demo, and finally distributes via npm with a soft community launch.

## Shape and constraints

- Phased rollout, every version is a public release with its own tag.
- Risk-first ordering: honesty before public claims; security before public API; verified data before marketing matrix.
- Each phase opens as a draft PR on day one, ready-for-review at a visual checkpoint, then merged + tagged.
- Single-track default. v3.2 and preliminary v3.4 data collection are the only realistic candidates for parallelization via worktrees.
- No POWL path, no mutation testing, no academic paper deliverable. These were ruled out as off-goal.

## Phase dependencies

```
v3.2 ──► v3.3 ──► v3.5 ──► v3.6
            │       ▲
            ▼       │
          v3.4 ─────┘
```

- v3.3 depends on v3.2: security documentation references the corrected module inventory and conventions.
- v3.4 depends on v3.3: differentiation benchmarks run against the strict-mode pipeline.
- v3.5 depends on v3.3 (auth + SSRF) and v3.4 (matrix data).
- v3.6 depends on v3.5: launch material assumes a working demo.

---

## v3.2 — Honesty Pass

**Estimated effort**: ~1 week

**Goal**: Every claim in CLAUDE.md, README, and ROADMAP is verifiable against the code at merge time. Single source of truth for changing numbers (rule count, test count, module inventory).

**Concrete deliverables**:
- Correct rule count to **27** (S01-S11 = 11, M01-M10 = 10, P01-P03 = 3, WF01-WF03 = 3) in all three docs. M10 was added with PR #8 but docs were not updated.
- Test count: use a script-derived value, not a hard-coded string. Current count ~272.
- CLAUDE.md module inventory completion: add `visual-refinement.js`, `moddle-import.js`, `workflow-net.js`, `delivery.js`, `audit.js`, `evaluate-slm.js`, `orchestrator.js`, `prepare-training-data.js`, the `agents/` subsystem (5 modules), and the `robustness/` subsystem (11 modules). Update architecture diagram.
- Dependencies convention corrected: `elkjs`, `bpmn-moddle`, `@modelcontextprotocol/sdk` are all runtime dependencies. Current "only elkjs" wording is wrong.
- Remove the false Known Limitation about empty `<timerEventDefinition/>` — the feature is implemented in `bpmn-xml.js:79-83`, `import.js:443-449`, and the schema. Replace with whatever genuine limitations remain after audit.
- Add a **Glossary** section to CLAUDE.md (~12 lines): Logic-Core, WF-Net, Bruce Silver Method & Style, Sugiyama, MaD, BPMNDI, MCP, ElkJS Layered, Pools, Lanes, Soundness.
- Add a **Common Tasks** section to CLAUDE.md: 5-7 typical workflows with file paths and verification commands (debug a wrong layout, react to a golden-file failure, extend a rule, choose a fixture, change a prompt template, test a visual refinement pass, run a robustness benchmark).
- Add a **Do-NOT** section to CLAUDE.md: no CommonJS, no new runtime dependencies without explicit discussion, no blind golden regeneration, no LLM output downstream without schema validation, no hard-coded constants where `config.json` applies.
- Single source of truth: README and ROADMAP link to `rules.js` and `references/fachliches-regelwerk.md` for counts and severity tables instead of duplicating them.
- Minimal Logic-Core example referenced by **link** to `tests/fixtures/simple-approval.json`, not inlined (inlined content rots).
- Remove `bpmn-generator-v3.skill` (ZIP) from git. Add an `npm run build:skill` script that produces it on demand. Document the build step in CLAUDE.md.

**Validation**: `grep -c "id:" scripts/rules.js` matches every number in README, CLAUDE.md, ROADMAP. `npm test` output count matches the docs' claim. New sections (Glossary, Common Tasks, Do-NOT) are present.

**Risks**: Low. Pure documentation and repo hygiene. The only code surface is `package.json` (build:skill script) and `.gitignore` (skill output).

---

## v3.3 — Public-API-Bar

**Estimated effort**: ~2 weeks

**Goal**: The HTTP API can be safely exposed to third parties. LLM output cannot reach the pipeline without passing a strict schema gate. Audit and dead-letter paths are deployable.

**Concrete deliverables**:
- **Complete SSRF coverage** in `http-server.js`. Current denylist covers `localhost`, `127.0.0.1`, `::1`, `10.x`, `192.168.x`. Add: `172.16.0.0/12`, `169.254.0.0/16` (link-local + AWS metadata endpoint at 169.254.169.254), `fc00::/7` (IPv6 ULA), `fe80::/10` (IPv6 link-local). Add DNS resolution and re-check resolved IPs against the same denylist so that `evil.example.com` resolving to `127.0.0.1` is blocked.
- **Auth default-on in production**: when `NODE_ENV === "production"` and `BPMN_API_KEY` is unset, server startup fails with a clear actionable error. Dev mode (default) still allows no-auth but prints a prominent startup warning.
- **Schema-Strict gate**: validate every Logic-Core input against `references/input-schema.json` before pipeline entry. Reject invalid input with a structured 400 response. The rule engine in `validate.js` is not a substitute for JSON Schema validation.
- **SECURITY.md** at repo root: threat model (LLM-output-as-input, public HTTP API, MCP), supported deployment modes (dev, production), vulnerability reporting (private contact).
- `AUDIT_LOG_PATH` and `DEAD_LETTER_PATH` configurable via env vars, default to `os.tmpdir()/bpmn-generator/` for portability on Docker / read-only filesystems. Current `__dirname/..` path is module-relative and fails in many production deployments.
- `$schemaVersion: "1.0"` field added to `input-schema.json` and to Logic-Core JSON, optional with default `"1.0"` for backwards compatibility. Documented migration policy: new major schema versions require a migration script in a documented location.
- Tests: SSRF unit tests for each blocked range (10 tests); auth-required-in-prod integration test; schema-strict-gate unit tests for valid/invalid/empty input.
- CLAUDE.md update: security defaults section + env vars table.

**Validation**: `curl` against a demo instance with a 172.x callback returns 400. Production start without API key exits 1 with a fix message. Invalid JSON returns a structured 400 instead of crashing the pipeline.

**Risks**: Medium. Auth-default-on can break local development workflows if not introduced with a clear migration message. Schema-strict gate may surface existing fixtures or tests that are loosely compliant; budget time for fixture cleanup.

---

## v3.4 — Differentiation Proof

**Estimated effort**: ~2 weeks

**Goal**: Replace marketing claims with reproducible benchmark numbers. Every cell in the eventual comparison matrix has a verified evidence path.

**Concrete deliverables**:
- **EVALUATION.md** with one section per benchmark: dataset, method, results, date, reproducer command.
- Benchmark dataset selection: try ProMoAI's PMo set (Zenodo 15857589) or Kourani's evaluation repository first; if not practical to integrate, define `Stieges-Bench v1` from 30-50 existing fixtures in `tests/fixtures/` plus the robustness set, document its rationale.
- Run `evaluate-slm.js` against the chosen benchmark, capture: parse rate, soundness-pass rate, structural fidelity, layout crossing count. Commit dated results.
- **Pools/Lanes verification vs. current `bpmn-auto-layout`**: pick three fixtures (3-pool-collaboration, sparse-lanes, nested-pools), run them through the current `bpmn-auto-layout` version, compare output. Document concretely what works in this generator and what breaks in the alternative. **If the advantage is smaller than expected, retract the claim** rather than re-spinning it.
- **Comparison matrix data table** in EVALUATION.md (not yet in README): rows = Stieges, ProMoAI, BPMN Assistant, BPMN-Chatbot; columns = Pools/Lanes (verified), soundness-check mechanism, stack, license, MCP support, live demo, paper reference, last commit date.
- **README hero rewrite**: lead with differentiation, not rule count. Three core claims, each linking to an EVALUATION.md evidence section.
- Visual proof: 3-4 SVG screenshots of complex multi-pool fixtures in `docs/screenshots/`, embedded in README.

**Validation**: every cell in the comparison matrix is backed by a path in the repo. `node scripts/evaluate-slm.js --bench v1` reproduces the EVALUATION.md numbers.

**Risks**: Medium. **Verification may invalidate favored claims**. Willingness to retract is essential. If, for example, `bpmn-auto-layout` has gained pools support since the analyst's report, the hero claim must be re-framed.

---

## v3.5 — Showcase + Demo

**Estimated effort**: ~2 weeks

**Goal**: One-click public demo. Visitors can verify the differentiation claims for themselves without setup.

**Concrete deliverables**:
- **Live demo deployment**. Recommendation: Vercel — serverless Function for `/api/v1/generate` (using an owner-provided LLM key with hard caps) plus a static HTML frontend. Alternative: HuggingFace Space if LLM cost is the constraint.
- **LLM key strategy**: no visitor key required. Hybrid approach — pre-loaded examples run without an LLM call (inline mode + cached Logic-Core), custom text uses the owner key with daily and per-IP caps.
- **Demo frontend**: textarea → Generate → SVG preview + BPMN download button. Reuse the inline template as the basis.
- **Four pre-loaded examples**: simple-approval, multi-pool-collaboration, expanded-subprocess, sparse-lanes (showcases visual refinement). Plus a "Custom" text input.
- **Comparison matrix in README**, populated from the v3.4 data.
- **GIF in README hero**: 8-second loop showing text → BPMN diagram.
- **MCP demo recording**: 30-second asciinema or screen recording of a Claude Code session using the skill, posted as an inline GIF in the README.

**Validation**: demo URL reachable; all four examples render in under 3 seconds; custom text with valid Logic-Core succeeds; invalid input shows a structured error rather than crashing.

**Risks**: Medium. Demo hosting becomes ongoing maintenance (quotas, LLM cost, bot abuse). Mitigation: hard daily cap on LLM calls; static examples are the primary path; rate limit per IP at the edge.

---

## v3.6 — Distribution + Launch

**Estimated effort**: ~1-2 weeks

**Goal**: Distribute via npm and soft-launch to relevant communities.

**Concrete deliverables**:
- **npm publish**. Check availability of `bpmn-generator` first; fall back to `@stieges/bpmn-generator` if taken. Finalize `package.json` scripts, exports, files fields. Add a `prepublishOnly` test gate.
- **GitHub Actions CI**: test workflow on push and pull request; coverage gate ≥ 80% lines and branches; Node 20 + 22 matrix.
- **SemVer policy** explicitly written in CONTRIBUTING.md: breaking changes only in major versions, new features in minor, fixes in patch. The 2.x → 3.x → 3.1 → 3.2 history will not repeat.
- **CHANGELOG.md cleanup**: move all completed items out of ROADMAP into CHANGELOG; ROADMAP keeps only open items going forward.
- **Blog post** (~1500 words): "BPMN 2.0 Generator with Pools, Lanes, and a Claude Code Skill". Published on dev.to or the owner's blog. Links to demo, EVALUATION, GitHub.
- **Soft launch posts**: r/bpmn, r/programming (Sunday evening for visibility), Hacker News "Show HN" on a Tuesday. Optional: LinkedIn for professional reach.
- **Docker image** (stretch / optional in v3.6, can defer to v3.7): multi-stage build, Alpine base, published to GHCR.

**Validation**: `npm install bpmn-generator` (or the namespaced fallback) succeeds on a clean machine. CI is green. Blog URL is reachable. Demo survives the launch traffic (verify with a load test capped at expected peak).

**Risks**: Low. Reddit and HN are unpredictable; the "soft" framing means a non-event is acceptable. Prerequisite for posting: the npm package must be live so that curious clicks have somewhere to go.

---

## Cross-cutting concerns

**Visual checkpoints** (per the owner's preferred workflow):
- After v3.2: documentation diff review.
- After v3.3: SECURITY.md walkthrough with attempted attack scenarios.
- After v3.4: EVALUATION.md numbers sanity check.
- After v3.5: live demo walkthrough.
- After v3.6: launch material proofreading.

**Draft-PR strategy**: each version opens as a draft PR on day one; the draft is the working surface for visual checkpoints; marking ready-for-review is the final step before merge and tag.

**Out of scope for this roadmap**:
- POWL pathway exploration (would split the project into two paradigms).
- Mutation testing (high cost, marginal value at current code size).
- Camunda extensions (separate concern, no current demand signal).
- Detailed LLM snapshot testing (handled instead by schema-strict gate from v3.3).

**What this roadmap deliberately does not promise**:
- An academic paper.
- A specific star count or community-size target.
- Compatibility with closed-source modelers beyond what bpmn.io / Camunda Modeler already accept.
- Schema migration tooling beyond the version field (deferred until needed).

**Reproducibility note**: ratings, counts, and competitor capability claims (especially in v3.4) reflect the state at the time of this design. They must be re-verified during v3.4 execution rather than treated as given.

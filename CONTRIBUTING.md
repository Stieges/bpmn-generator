# Contributing to BPMN Generator

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
cd scripts/
npm install          # installs elkjs, bpmn-moddle, jest
npm test             # run all tests (136 tests, Jest + ES Modules)
```

### Smoke Test

```bash
node pipeline.js tests/fixtures/simple-approval.json /tmp/test
# outputs: /tmp/test.bpmn + /tmp/test.svg
```

## Project Structure

```
scripts/           Pipeline modules (ES Modules, no CommonJS)
references/        Schema docs, prompt templates, OMG compliance mapping
rules/             Rule engine profiles (default, strict)
tests/fixtures/    Test inputs (JSON Logic-Core) + golden files
docs/              Generated pipeline self-diagram
```

See [README.md](README.md) for the full module architecture and dependency graph.

## Code Style

- **ES Modules** — `import`/`export`, no `require()`
- **Pure functions** — no global state except `CFG` (loaded from config.json)
- **Minimal dependencies** — only `elkjs` and `bpmn-moddle` at runtime
- **Config over code** — visual constants live in `scripts/config.json`
- **XML escaping** — always use `esc()` from `utils.js`
- **IDs** — must match `^[a-zA-Z_][a-zA-Z0-9_-]*$`

## Making Changes

1. **Fork** the repository and create a feature branch
2. **Read** the relevant module before modifying it
3. **Run tests** after every change: `npm test`
4. **Golden files** — if your change affects layout or XML output, regenerate:
   ```bash
   node pipeline.js ../tests/fixtures/simple-approval.json ../tests/fixtures/simple-approval.expected
   node pipeline.js ../tests/fixtures/multi-pool-collaboration.json ../tests/fixtures/multi-pool-collaboration.expected
   node pipeline.js ../tests/fixtures/expanded-subprocess.json ../tests/fixtures/expanded-subprocess.expected
   ```
5. **Submit a PR** with a clear description of what changed and why

## Adding a New Rule

1. Add a rule object to `scripts/rules.js` → `RULES` array
2. Fields: `id`, `layer`, `defaultSeverity`, `description`, `ref`, `check(proc)`
3. `check` returns `{ pass: true }` or `{ pass: false, message: '...' }`
4. Document in `references/fachliches-regelwerk.md`
5. Add test in `pipeline.test.js`

## Adding a New BPMN Element

1. `types.js` — extend `bpmnXmlTag` map, add type predicate if needed
2. `layout.js` — `buildElkNode` for layout dimensions
3. `bpmn-xml.js` — XML serialization
4. `svg.js` — SVG rendering
5. `icons.js` — if icon/marker needed
6. `import.js` — BPMN XML → Logic-Core parsing
7. `references/omg-compliance.md` — update OMG mapping
8. `references/input-schema.json` — extend schema

## Testing

- All tests use **Jest** with ES Modules (`--experimental-vm-modules`)
- **Golden file tests** compare generated SVG/BPMN against `.expected.*` files
- **Round-trip tests** verify XML → parse → re-serialize produces valid output
- Test fixtures live in `tests/fixtures/`

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include the Logic-Core JSON input that triggers the bug
- Include the generated SVG/BPMN if it's a visual issue

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

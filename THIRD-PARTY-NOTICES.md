# Third-Party Notices

This project uses the following third-party libraries:

## Runtime Dependencies

### ElkJS — Eclipse Layout Kernel for JavaScript

- **Version:** 0.9.3
- **License:** Eclipse Public License 2.0 (EPL-2.0)
- **Copyright:** Copyright (c) Eclipse Foundation and contributors
- **Repository:** https://github.com/kieler/elkjs
- **Usage:** Sugiyama layered auto-layout algorithm for BPMN diagram positioning
- **Full license:** https://www.eclipse.org/legal/epl-2.0/

ElkJS is used as an unmodified library. No modifications have been made to its source code.

### bpmn-moddle — BPMN 2.0 Meta-Model for JavaScript

- **Version:** 9.0.4
- **License:** MIT
- **Copyright:** Copyright (c) 2014 camunda Services GmbH
- **Repository:** https://github.com/bpmn-io/bpmn-moddle
- **Usage:** CMOF-based BPMN 2.0 XML serialization and parsing

### @modelcontextprotocol/sdk — Model Context Protocol SDK

- **Version:** 1.27.1
- **License:** MIT
- **Copyright:** Copyright (c) 2024 Anthropic, PBC
- **Repository:** https://github.com/modelcontextprotocol/typescript-sdk
- **Usage:** MCP server implementation for tool integration

## Dev Dependencies

### Jest — JavaScript Testing Framework

- **Version:** 30.2.0
- **License:** MIT
- **Copyright:** Copyright (c) Meta Platforms, Inc. and affiliates
- **Repository:** https://github.com/jestjs/jest

---

## License Compatibility

| Dependency | License | Compatible with MIT? | Notes |
|---|---|---|---|
| elkjs | EPL-2.0 | Yes | EPL-2.0 §4 allows combining with differently-licensed code |
| bpmn-moddle | MIT | Yes | Permissive |
| @modelcontextprotocol/sdk | MIT | Yes | Permissive |
| jest | MIT | Yes | Dev-only, not distributed |

The EPL-2.0 (ElkJS) permits use alongside MIT-licensed code. ElkJS is consumed as
an unmodified npm dependency — no EPL-2.0 code has been modified or redistributed
in source form.

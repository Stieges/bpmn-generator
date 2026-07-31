# Third-Party Notices

This project uses the following third-party libraries:

## Runtime Dependencies

### ElkJS — Eclipse Layout Kernel for JavaScript

- **Version:** 0.12.0
- **License:** Eclipse Public License 2.0 (EPL-2.0)
- **Copyright:** Copyright (c) Eclipse Foundation and contributors
- **Repository:** https://github.com/kieler/elkjs
- **Usage:** Sugiyama layered auto-layout algorithm for BPMN diagram positioning
- **Full license:** https://www.eclipse.org/legal/epl-2.0/

ElkJS is used as an unmodified library. No modifications have been made to its source code.

### bpmn-moddle — BPMN 2.0 Meta-Model for JavaScript

- **Version:** 10.0.0
- **License:** MIT
- **Copyright:** Copyright (c) 2014 camunda Services GmbH
- **Repository:** https://github.com/bpmn-io/bpmn-moddle
- **Usage:** CMOF-based BPMN 2.0 XML serialization and parsing

### dmn-moddle — DMN 1.3 Meta-Model for JavaScript

- **Version:** 12.0.1
- **License:** MIT
- **Copyright:** Copyright (c) 2015-present camunda Services GmbH
- **Repository:** https://github.com/bpmn-io/dmn-moddle
- **Usage:** CMOF-based DMN 1.3 XML serialization and parsing, symmetric to bpmn-moddle on the DMN side

### @modelcontextprotocol/sdk — Model Context Protocol SDK

- **Version:** 1.29.0
- **License:** MIT
- **Copyright:** Copyright (c) 2024 Anthropic, PBC
- **Repository:** https://github.com/modelcontextprotocol/typescript-sdk
- **Usage:** MCP server implementation for tool integration

### ajv — JSON Schema Validator

- **Version:** 8.20.0
- **License:** MIT
- **Copyright:** Copyright (c) 2015-2021 Evgeny Poberezkin
- **Repository:** https://github.com/ajv-validator/ajv
- **Usage:** draft-2020-12 strict gate for untrusted Logic-Core input (`scripts/bpmn/schema-gate.js`)

### ajv-formats — Format Validators for ajv

- **Version:** 3.0.1
- **License:** MIT
- **Copyright:** Copyright (c) 2020 Evgeny Poberezkin
- **Repository:** https://github.com/ajv-validator/ajv-formats
- **Usage:** Format keyword support for the schema gate

## Dev Dependencies

Dev dependencies are not distributed — they are listed for completeness and license review.

### Jest — JavaScript Testing Framework

- **Version:** 30.4.2
- **License:** MIT
- **Copyright:** Copyright (c) Meta Platforms, Inc. and affiliates
- **Repository:** https://github.com/jestjs/jest

### @jest/globals — Jest Global APIs

- **Version:** 30.4.1
- **License:** MIT
- **Copyright:** Copyright (c) Meta Platforms, Inc. and affiliates
- **Repository:** https://github.com/jestjs/jest

### bpmn-auto-layout — Reference Layout Implementation

- **Version:** 1.3.0
- **License:** MIT
- **Copyright:** Copyright (c) camunda Services GmbH
- **Repository:** https://github.com/bpmn-io/bpmn-auto-layout
- **Usage:** Comparison reference during layout development

---

## License Compatibility

| Dependency | License | Compatible with MIT? | Notes |
|---|---|---|---|
| elkjs | EPL-2.0 | Yes | EPL-2.0 §4 allows combining with differently-licensed code |
| bpmn-moddle | MIT | Yes | Permissive |
| dmn-moddle | MIT | Yes | Permissive |
| @modelcontextprotocol/sdk | MIT | Yes | Permissive |
| ajv | MIT | Yes | Permissive |
| ajv-formats | MIT | Yes | Permissive |
| jest | MIT | Yes | Dev-only, not distributed |
| @jest/globals | MIT | Yes | Dev-only, not distributed |
| bpmn-auto-layout | MIT | Yes | Dev-only, not distributed |

The EPL-2.0 (ElkJS) permits use alongside MIT-licensed code. ElkJS is consumed as
an unmodified npm dependency — no EPL-2.0 code has been modified or redistributed
in source form.

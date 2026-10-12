# Third-party notices

This package contains data and algorithms derived from the following third-party works.

## bpmn-js 18.6.2

Source: https://github.com/bpmn-io/bpmn-js (`lib/draw/PathMap.js`, `lib/draw/BpmnRenderer.js`).

Derived material in this package:

- `bpmn/pathmap.js` — the glyph path templates of `PathMap.js` (verbatim data) and `scaledPath`, a port
  of its `getScaledPath` (code, rewritten from it).
- `bpmn/icons.js` — the scale, position, fill and stroke parameters each `BpmnRenderer.js` handler
  passes for event icons, task icons, task markers (`renderTaskMarkers` offsets), gateway symbols
  and data shapes.

Apart from that port of `getScaledPath`, this package contains no bpmn-js code and not its
watermark; it draws its own SVG.

```
Copyright (c) 2014-present Camunda Services GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

The source code responsible for displaying the bpmn.io project watermark that
links back to https://bpmn.io as part of rendered diagrams MUST NOT be
removed or changed. When this software is being used in a website or application,
the watermark must stay fully visible and not visually overlapped by other elements.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
OR OTHER DEALINGS IN THE SOFTWARE.
```

## dmn-js-drd 17.12.3

Source: https://github.com/bpmn-io/dmn-js (`packages/dmn-js-drd/src/draw/PathMap.js`,
`packages/dmn-js-drd/src/draw/DrdRenderer.js`), read from the published package
`dmn-js-drd@17.12.3` (`lib/draw/`).

Derived material in this package:

- `dmn/pathmap.js` — the `KNOWLEDGE_SOURCE` and `BUSINESS_KNOWLEDGE_MODEL` path templates of
  `PathMap.js` and the scale and start position `DrdRenderer.js` passes for each (verbatim data),
  and `drdScaledPath`, a port of `PathMap.js`'s `getScaledPath` (code, rewritten from it).
- `dmn/svg.js` — the marker shapes, reference points and scales of `DrdRenderer.js`'s
  `createMarker` (information, knowledge and authority requirement ends; also recorded in
  `config.json → dmn.edge`) and the 22 px corner radius of an input data shape.

Apart from that port of `getScaledPath`, this package contains no dmn-js code and not its
watermark; it draws its own SVG.
dmn-js-drd is distributed under the same bpmn.io license as bpmn-js, quoted in full above
(Copyright (c) 2014-present Camunda Services GmbH).

## diagram-js 15.3.0

Source: https://github.com/bpmn-io/diagram-js (`lib/util/RenderUtil.js`, `lib/util/Text.js`).

Derived material in this package:

- `bpmn/svg.js` — `connectionPath`, the rounded-corner path of `RenderUtil.js` `drawPath` / `createLine`.
- `shared/text-layout.js` — `layoutText`, the line breaking of `Text.js` (`layoutNext`, `semanticShorten`), used by `bpmn/coordinates.js` (`edgeLabelLayout`) and the DMN renderers.

```
The MIT License (MIT)

Copyright (c) 2014-present Camunda Services GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

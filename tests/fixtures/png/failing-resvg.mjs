// Test hook: replaces `@resvg/resvg-wasm` with resvg-stub.mjs, a renderer that passes the
// start-up text check and then fails on every real diagram, as a wasm trap would.
// Use as `node --import <this file> bpmn/pipeline.js …`.
//
// module.register exists from Node 20.6. That is newer than the package's `engines` (>=20), but
// this file is test-only and never shipped; CI runs the tests on the latest 20.x and on 22.
import { register } from 'node:module';

register('./failing-resvg-loader.mjs', import.meta.url);

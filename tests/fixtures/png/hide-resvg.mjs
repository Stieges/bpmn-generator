// Test hook: makes `@resvg/resvg-wasm` look uninstalled, as after `npm install --omit=optional`.
// Use as `node --import <this file> bpmn/pipeline.js …`.
//
// module.register exists from Node 20.6. That is newer than the package's `engines` (>=20), but
// this file is test-only and never shipped; CI runs the tests on the latest 20.x and on 22.
import { register } from 'node:module';

register('./hide-resvg-loader.mjs', import.meta.url);

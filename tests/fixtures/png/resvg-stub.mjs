// Stand-in for the part of the @resvg/resvg-wasm 2.6.2 API that scripts/shared/png.js uses:
// initWasm(bytes), new Resvg(svg, options), resvg.render() → RenderedImage { width, height,
// pixels, free() }, and resvg.free().
//
// render() succeeds for an SVG under 500 bytes, which is the renderer's start-up text check, and
// returns an all-black image so that check sees text. Every larger SVG (any real diagram) throws
// the error a wasm trap raises, so a test can drive a render failure after the model files are
// written.
const SMALL_SVG_BYTES = 500;

export async function initWasm() {}

class RenderedImage {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4).fill(0);
    for (let i = 3; i < this.pixels.length; i += 4) this.pixels[i] = 255;
  }

  free() {}
}

export class Resvg {
  constructor(svg, options = {}) {
    this.svg = String(svg);
    this.scale = options.fitTo?.mode === 'zoom' ? options.fitTo.value : 1;
  }

  render() {
    if (Buffer.byteLength(this.svg) >= SMALL_SVG_BYTES) throw new WebAssembly.RuntimeError('unreachable');
    const width = Number(/\swidth="(\d+)"/.exec(this.svg)?.[1] ?? 100);
    const height = Number(/\sheight="(\d+)"/.exec(this.svg)?.[1] ?? 100);
    return new RenderedImage(Math.round(width * this.scale), Math.round(height * this.scale));
  }

  free() {}
}

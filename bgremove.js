// Local background removal (alpha matting). Runs in Electron's main process; frames never leave the machine.
// Model weights download once from Hugging Face on first use, then are cached on disk.
const MODELS = {
  portrait: { id: 'Xenova/modnet' },                                           // people, ~25 MB, ~0.25 s per frame
  general:  { id: 'onnx-community/BiRefNet_lite-ONNX', dtype: 'fp16' }          // any subject, ~134 MB, several seconds per frame
};

let tf = null;
const pipes = {};

async function getPipe(key, cacheDir, onProgress) {
  const cfg = MODELS[key];
  if (!cfg) throw new Error('Unknown model: ' + key);
  tf = tf || (await import('@huggingface/transformers'));
  tf.env.cacheDir = cacheDir;
  tf.env.allowLocalModels = false;
  if (!pipes[key]) {
    pipes[key] = await tf.pipeline('background-removal', cfg.id, {
      ...(cfg.dtype ? { dtype: cfg.dtype } : {}),
      progress_callback: (p) => onProgress && onProgress(p)
    });
  }
  return pipes[key];
}

// rgba: w*h*4 bytes. Returns a w*h Uint8Array: 255 = subject, 0 = background.
async function matte(rgba, w, h, { model = 'portrait', cacheDir, onProgress } = {}) {
  const pipe = await getPipe(model, cacheDir, onProgress);
  // hand the model a plain 3-channel RGB image (a 4-channel RGBA buffer gets mis-read by the preprocessor)
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) { rgb[j] = rgba[i * 4]; rgb[j + 1] = rgba[i * 4 + 1]; rgb[j + 2] = rgba[i * 4 + 2]; }
  const out = await pipe(new tf.RawImage(rgb, w, h, 3));
  let r = Array.isArray(out) ? out[0] : out;
  if (r.width !== w || r.height !== h) r = await r.resize(w, h);
  const alpha = new Uint8Array(w * h);
  const ch = r.channels || 4;
  for (let i = 0; i < alpha.length; i++) alpha[i] = r.data[i * ch + (ch - 1)];
  return alpha;
}

module.exports = { matte, MODELS };

// Local speech-to-text (Whisper via ONNX). Runs in Electron's main process; audio never leaves the machine.
// The model weights download once from Hugging Face on first use, then are cached on disk.
const MODELS = {
  fast:   { id: 'Xenova/whisper-tiny.en', multilingual: false },
  better: { id: 'Xenova/whisper-base',    multilingual: true }
};

let tf = null;
const pipes = {};

async function getPipe(key, cacheDir, onProgress) {
  if (!MODELS[key]) throw new Error('Unknown model: ' + key);
  tf = tf || (await import('@huggingface/transformers'));
  tf.env.cacheDir = cacheDir;
  tf.env.allowLocalModels = false;
  if (!pipes[key]) {
    pipes[key] = await tf.pipeline('automatic-speech-recognition', MODELS[key].id, {
      dtype: 'q8',
      progress_callback: (p) => onProgress && onProgress(p)
    });
  }
  return pipes[key];
}

// audio: Float32Array, mono, 16 kHz
async function transcribe(audio, { model = 'fast', language = 'english', cacheDir, onProgress } = {}) {
  const pipe = await getPipe(model, cacheDir, onProgress);
  const opts = { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 };
  if (MODELS[model].multilingual) {
    opts.task = 'transcribe';
    if (language && language !== 'auto') opts.language = language;
  }
  const out = await pipe(audio, opts);
  const segs = (out.chunks || [])
    .map((c) => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 2, text: c.text.trim() }))
    // whisper hallucinates tags on silence/music: "[BLANK_AUDIO]", "(music)", "♪"
    .filter((s) => s.text && !/^[\[(].*[\])]$/.test(s.text) && !/^[♪\s.]+$/.test(s.text));
  return segs;
}

module.exports = { transcribe, MODELS };

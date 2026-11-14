# FreeCut

A free desktop video editor for Windows. No paywalls, no watermark, no account.

CapCut-style layout: multi-track timeline, keyframes, transitions, speed curves, colour grading (curves/HSL/wheels), chroma key, masks, AI background removal, auto captions (Whisper), text-to-speech, reverse, stabilise, a permanent media library, presets, and project autosave. Drag, scale and rotate clips directly in the preview.

## Install
Download `FreeCut Setup 0.1.0.exe` from the Releases page and run it. The installer is unsigned, so Windows SmartScreen will warn you: click **More info -> Run anyway**. AI models (captions, background removal) download on first use.

## Build from source
```
npm install
npm start        # run in dev
npm run dist     # build the Windows installer into dist/
```

## Notes
- Export runs in real time.
- AI background removal "Best" mode is slow on CPU (several seconds per frame).
- Licence: MIT.

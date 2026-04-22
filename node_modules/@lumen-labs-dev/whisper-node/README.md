# Whisper-Node

[![npm downloads](https://img.shields.io/npm/dm/@lumen-labs-dev/whisper-node)](https://npmjs.org/package/@lumen-labs-dev/whisper-node)
[![npm downloads](https://img.shields.io/npm/l/@lumen-labs-dev/whisper-node)](https://npmjs.org/package/@lumen-labs-dev/whisper-node)  

Node.js bindings for OpenAI's Whisper. Transcription done local with VAD and Speaker Diarization.

## Features

- Output transcripts to **JSON** (also .txt .srt .vtt)
- **Optimized for CPU** (Including Apple Silicon ARM)
- Timestamp precision to single word

## Installation

1. Add dependency to project

```text
npm install @lumen-labs-dev/whisper-node
```

2. Download a Whisper model [OPTIONAL]

```text
npx whisper-node
```

Alternatively, the same downloader can be invoked as:

```text
npx whisper-node download
```

### Windows (precompiled binaries)

On Windows, whisper-node downloads precompiled Whisper binaries during install (or first use) and runs them directly — no local build tools are required.

- To choose a binary flavor before installing:

```bash
setx WHISPER_WIN_FLAVOR cpu
# or: blas | cublas-11.8 | cublas-12.4
```

- Ensure the Microsoft Visual C++ 2015–2022 Redistributable (x64) is installed.
  If you see error code 0xC0000135 when starting the binary, install the redistributable and retry.

- Optional: point to a custom Windows binary subfolder inside `lib/whisper.cpp`:

```bash
setx WHISPER_WIN_BIN_DIR Win64
# examples: Win64 | BlasWin64 | CublasWin64-11.8 | CublasWin64-12.4
```

Non-Windows platforms still build from source when needed.

If the package was installed without bundling `lib/whisper.cpp`, the downloader will automatically set up the upstream `whisper.cpp` assets inside `node_modules/@lumen-labs-dev/whisper-node/lib/whisper.cpp`. On Windows, this uses precompiled release archives; on non-Windows it may clone and build from source.

## Usage

```javascript
import { whisper } from '@lumen-labs-dev/whisper-node';

const transcript = await whisper("example/sample.wav");

console.log(transcript); // output: [ {start,end,speech} ]
```

### Output (JSON)

```javascript
[
  {
    "start":  "00:00:14.310", // time stamp begin
    "end":    "00:00:16.480", // time stamp end
    "speech": "howdy"         // transcription
  }
]
```

### Full Options List

```javascript
import { whisper } from '@lumen-labs-dev/whisper-node';

const filePath = "example/sample.wav"; // required

const options = {
  modelName: "base.en",       // default
  // modelPath: "/custom/path/to/model.bin", // use model in a custom directory (cannot use along with 'modelName')
  whisperOptions: {
    language: 'auto',          // default (use 'auto' for auto detect)
    gen_file_txt: false,      // outputs .txt file
    gen_file_subtitle: false, // outputs .srt file
    gen_file_vtt: false,      // outputs .vtt file
    // Enable per-word timestamps only if you really need them.
    // For typical sentence/segment output, leave this off.
    // When per-word is detected, whisper-node will automatically merge words into sentences.
    word_timestamps: false,
    no_timestamps: false,      // when true, Whisper prints only text (no [..] lines)
    // timestamp_size: 0      // cannot use along with word_timestamps:true
  },
  // Forwarded to shelljs.exec (defaults shown)
  shellOptions: {
    silent: true,
    async: false,
  }
}

const transcript = await whisper(filePath, options);
```

### API

- **Function**: `whisper(filePath: string, options?: { modelName?, modelPath?, whisperOptions?, shellOptions? }) => Promise<ITranscriptLine[]>`
- **Models**: pass either `modelName` (one of the official names) or a `modelPath` pointing to a `.bin` file. Do not pass both.
- **Return**: array of `{ start, end, speech }` objects parsed from Whisper's console output.

Notes:
- Setting `no_timestamps: true` changes Whisper's console output format. Since the JSON parser expects `[start --> end] text` lines, using `no_timestamps: true` will typically yield an empty array. Prefer `timestamp_size` (segment-level) or `word_timestamps` (word-level) when you need structured JSON.
- If you enable `word_timestamps`, whisper-node will auto-merge single-word lines into sentence-level segments using pause and punctuation heuristics. You can still access raw lines before merge by calling the underlying CLI yourself.
- You can still generate `.txt/.srt/.vtt` files via `gen_file_*` flags even if you don't use the JSON array.

### Automatic audio conversion (fluent-ffmpeg)

`whisper-node` will automatically convert common audio/video inputs (e.g., mp3, m4a, wav, mp4) into 16 kHz mono WAV when needed using `fluent-ffmpeg` and the bundled `ffmpeg-static`/`ffprobe-static` binaries. The converted file is written next to your input as `<name>.wav16k.wav` and used for transcription.

If your input is already a 16kHz mono WAV, it is used as-is without conversion.

### Optional: Speaker diarization (Node, naive)

You can enrich the transcript with speaker labels without Python using a lightweight, naive diarization:
- VAD by energy threshold
- K-means clustering over simple features

Usage:

```ts
import whisper, { DiarizationOptions } from '@lumen-labs-dev/whisper-node';

const transcript = await whisper('audio.mp3', {
  diarization: {
    enabled: true,
    numSpeakers: 2, // or omit to auto-guess a small K
  }
});

// Each transcript line may include speaker: 'S0', 'S1', ...
```

Notes:
- This is a basic approach and won’t handle overlapping speakers or noisy audio robustly. It is intended as a simple, CPU-only baseline.
- For production-grade results, consider integrating an advanced pipeline (e.g., WhisperX/pyannote) externally and mapping their segments back to `ITranscriptLine`.

### Input File Format

Files must be .wav and 16 kHz

Example .mp3 file converted with an [FFmpeg](https://ffmpeg.org) command: ```ffmpeg -i input.mp3 -ar 16000 output.wav```

### CLI (Model Downloader)

Run the interactive downloader (downloads into `node_modules/@lumen-labs-dev/whisper-node/lib/whisper.cpp/models`; non-Windows will build on first use if needed):

```text
npx @lumen-labs-dev/whisper-node
```

You will be prompted to choose one of:

| Model     | Disk   | RAM     |
|-----------|--------|---------|
| tiny      |  75 MB | ~273 MB |
| tiny.en   |  75 MB | ~273 MB |
| base      | 142 MB | ~388 MB |
| base.en   | 142 MB | ~388 MB |
| small     | 466 MB | ~852 MB |
| small.en  | 466 MB | ~852 MB |
| medium    | 1.5 GB | ~2.1 GB |
| medium.en | 1.5 GB | ~2.1 GB |
| large-v1  | 2.9 GB | ~3.9 GB |
| large     | 2.9 GB | ~3.9 GB |

If you already have a model elsewhere, pass `modelPath` in the API and skip the downloader.

### Configuration file

You can configure defaults without passing options in code by creating one of the following files in your project root:

- `whisper-node.config.json`
- `whisper.config.json`

Or set an explicit path via environment variable `WHISPER_NODE_CONFIG=/abs/path/to/config.json`.

Example config:

```json
{
  "modelName": "base.en",
  "modelPath": "/custom/models/ggml-base.en.bin",
  "whisperOptions": {
    "language": "auto",
    "word_timestamps": true
  },
  "shellOptions": {
    "silent": true
  }
}
```

Notes:
- Options provided directly to the `whisper()` function always override values from the config file.
- The downloader CLI will use `modelName` from config to skip the prompt when valid.

### Logging

Control verbosity via environment variable (defaults to INFO):

```bash
# ERROR | WARN | INFO | DEBUG
setx WHISPER_NODE_LOG_LEVEL DEBUG
```

### Troubleshooting

- **"'make' failed"**: Ensure build tools are installed.
  - Windows: install `make` (see link above) or use MSYS2/Chocolatey alternatives.
  - macOS: `xcode-select --install`.
  - Linux: `sudo apt-get install build-essential` (Debian/Ubuntu) or the equivalent for your distro.
- **"'<model>' not downloaded! Run 'npx whisper-node download'"**: Either run the downloader or provide a valid `modelPath`.
- **Empty transcript array**: Remove `no_timestamps: true`. The JSON parser expects timestamped lines like `[00:00:01.000 --> 00:00:02.000] text`.
- **Paths with spaces**: Supported. Paths are automatically quoted.
- **Windows binary won't start (0xC0000135)**: Install the Microsoft Visual C++ 2015–2022 Redistributable (x64) and retry.
- **Large inputs**: Very long audio can use significant memory for conversion/diarization. Consider splitting into smaller chunks.

## Project structure

```
src/
  cli/          # CLI entrypoints (e.g., download)
  config/       # constants and configuration
  core/         # domain logic (whisper command builder)
  infra/        # process/shell integration with whisper.cpp
  utils/        # helper utilities (e.g., transcript parsing)
  scripts/      # development/test scripts
```

## Made with

- [Whisper OpenAI](https://github.com/ggml-org/whisper.cpp)
- [ShellJS](https://www.npmjs.com/package/shelljs)

## Roadmap

- [x] Support projects not using Typescript
- [x] Allow custom directory for storing models
- [x] Config files as alternative to model download cli
- [ ] Remove *path*, *shelljs* and *prompt-sync* package for browser, react-native expo, and webassembly compatibility
- [x] [fluent-ffmpeg](https://www.npmjs.com/package/fluent-ffmpeg) to automatically convert to 16Hz .wav files as well as support separating audio from video
- [x] Speaker diarization (basic Node baseline)
- [ ] [Implement WhisperX as optional alternative model](https://github.com/m-bain/whisperX) for diarization and higher precision timestamps (as alternative to C++ version)
- [ ] Add option for viewing detected language as described in [Issue 16](https://github.com/LumenLabsDev/whisper-node/issues/16)
- [x] Include TypeScript types in ```d.ts``` file
- [x] Add support for language option
- [ ] Add support for transcribing audio streams as already implemented in whisper.cpp

## Modifying whisper-node

```npm run build``` - runs tsc, outputs to `/dist` and gives sh permission to `dist/cli/download.js`

```npm run test``` - runs the compiled example in `dist/scripts/test.js`

## Acknowledgements

- [Georgi Gerganov](https://ggerganov.com/)
- [Ari](https://aricv.com)
- [Maximiliano Veiga](https://lumenlabs.dev/)
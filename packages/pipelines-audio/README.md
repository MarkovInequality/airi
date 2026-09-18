# @proj-airi/pipelines-audio

Shared audio-pipeline orchestration for AIRI. The package owns reusable streaming, playback, text-chunking, and transcript-buffering policies without depending on an application UI.

## Use it for

- Building and scheduling speech playback pipelines.
- Parsing streaming-control events.
- Grouping nearby ASR fragments with `createTranscriptBuffer` before a product sends one spoken turn downstream.

## Do not use it for

- Vue or Electron lifecycle state.
- Provider credentials and product-specific error UI.
- Raw audio encoding utilities, which belong in `@proj-airi/audio`.

## Transcript buffering

```ts
import { createTranscriptBuffer } from '@proj-airi/pipelines-audio'

const buffer = createTranscriptBuffer({
  flushDelayMs: 1200,
  flush: async text => sendToChat(text),
})

buffer.push('hello')
buffer.push('world')
await buffer.dispose()
```

## Unspoken-character stripping

Emoji and decoration reach a TTS engine as either silence, a spelled-out CLDR
name ("grinning face"), or a stall. `stripUnspokenText` removes them and keeps
everything a listener expects to hear.

```ts
import { createUnspokenTextFilter, stripUnspokenText } from '@proj-airi/pipelines-audio'

stripUnspokenText('Hi 😀! The ʃ sound costs $5 ♪')
// => 'Hi ! The ʃ sound costs $5 '
```

Stripped: pictographs and their sequence glue, `Other_Symbol` (♪ ✓ ★ © ®),
arrows, and bullets. Kept: currency, math, the degree sign, phonetic/IPA
characters, and all letters, digits, and punctuation.

`createTtsSegmentStream` applies this per grapheme cluster already. Use
`createUnspokenTextFilter` only when stripping a raw chunk stream that does not
go through the segmenter — it withholds a trailing high surrogate so an emoji
split across two chunks is still recognized.

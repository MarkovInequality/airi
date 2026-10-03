import type { ReaderLike } from 'clustr'

import type { TextSegment, TextToken } from '../types'

import { readGraphemeClusters } from 'clustr'

import { createPushStream } from '../stream'
import { stripUnspokenText } from './unspoken-text'

export const TTS_FLUSH_INSTRUCTION = '\u200B'
export const TTS_SPECIAL_TOKEN = '\u2063'

const regexpAnySingleDigit = /\d/

const keptPunctuations = new Set('?？!！')
const hardPunctuations = new Set('.。?？!！…⋯～~\n\t\r')
const softPunctuations = new Set(',，、–—:：;；《》「」')

export interface TtsInputChunk {
  text: string
  words: number
  reason: 'boost' | 'limit' | 'hard' | 'flush' | 'special'
}

export interface TtsInputChunkOptions {
  /**
   * How many opening chunks may end at soft punctuation instead of waiting for a sentence end.
   *
   * This lowers the time to the first audio. A boost chunk still has to reach `minimumWords`:
   * every TTS request carries a fixed cost that does not shrink with the text, so a two-word
   * fragment delays the audio it was meant to bring forward.
   *
   * @default 2
   */
  boost?: number
  /**
   * Word count a chunk must reach before a boost or a length limit may end it.
   *
   * @default 4
   */
  minimumWords?: number
  /** @default 12 */
  maximumWords?: number
  stripNarrative?: boolean
  keepNarrativeText?: boolean
  /**
   * Removes `$$...$$` spans and everything inside them before TTS. The chat
   * renders these spans as math, but a voice would read the raw LaTeX aloud.
   * The whole span goes even when `keepNarrativeText` is on, because LaTeX
   * source is never speech. A single `$` is currency and stays.
   *
   * @default false
   */
  stripMath?: boolean
  /**
   * Removes the `%%` delimiters of a pronunciation hint and keeps its text, so
   * `$$v_0$$ %%v naught%%` speaks "v naught" when `stripMath` is also on. The
   * chat Markdown in `packages/stage-ui` hides the whole hint. `%%` inside
   * math is a LaTeX comment and stays part of the formula. A single `%`
   * stays.
   *
   * @default false
   */
  unwrapPronunciation?: boolean
}

export interface TtsChunkItem {
  chunk: string
  special: string | null
  reason: 'boost' | 'limit' | 'hard' | 'flush' | 'special'
}

export async function* chunkTtsInput(
  input: string | ReaderLike,
  options?: TtsInputChunkOptions,
): AsyncGenerator<TtsInputChunk, void, unknown> {
  const {
    boost = 2,
    minimumWords = 4,
    maximumWords = 12,
  } = options ?? {}

  const iterator = readGraphemeClusters(
    typeof input === 'string'
      ? new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(input))
            controller.close()
          },
        }).getReader()
      : input,
  )

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' }) // I love Intl.Segmenter

  let yieldCount = 0
  let buffer = ''
  let chunk = ''
  let chunkWordsCount = 0

  let previousValue: string | undefined
  let current = await iterator.next()

  while (!current.done) {
    let value = current.value

    // A cluster wider than one UTF-16 unit is never punctuation, so it skips
    // the classification below and goes straight to the buffer. It used to be
    // discarded outright, which silently ate decomposed accents (a "cafe" whose
    // accent is a combining mark spoke as "caf"), Indic and other
    // complex-script clusters, and every astral letter, while removing emoji
    // only as a side effect.
    if (value.length > 1) {
      buffer += stripUnspokenText(value) || ' '
      previousValue = value
      current = await iterator.next()
      continue
    }

    // Single-unit decoration (✓ ♪ → •) leaves a space so the words it separated
    // do not run together once it is gone.
    if (stripUnspokenText(value) === '') {
      buffer += ' '
      previousValue = value
      current = await iterator.next()
      continue
    }

    const flush = value === TTS_FLUSH_INSTRUCTION
    const special = value === TTS_SPECIAL_TOKEN
    const hard = hardPunctuations.has(value)
    const soft = softPunctuations.has(value)
    const kept = keptPunctuations.has(value)
    let next: IteratorResult<string, void> | undefined
    let afterNext: IteratorResult<string, void> | undefined

    if (flush || special || hard || soft) {
      switch (value) {
        case '.':
        case ',': {
          if (previousValue !== undefined && regexpAnySingleDigit.test(previousValue)) {
            next = await iterator.next()
            if (!next.done && next.value && regexpAnySingleDigit.test(next.value)) {
              buffer += value
              current = next
              next = undefined
              continue
            }
          }
          else if (value === '.') {
            next = await iterator.next()
            if (!next.done && next.value && next.value === '.') {
              afterNext = await iterator.next()
              if (!afterNext.done && afterNext.value && afterNext.value === '.') {
                value = '…'
                next = undefined
                afterNext = undefined
              }
            }
          }
        }
      }

      if (buffer.length === 0) {
        if (special) {
          yield {
            text: '',
            words: 0,
            reason: 'special',
          }
          yieldCount++
          chunkWordsCount = 0
        }

        previousValue = value
        current = await iterator.next()
        continue
      }

      const words = [...segmenter.segment(buffer)].filter(w => w.isWordLike)

      if (chunkWordsCount > minimumWords && chunkWordsCount + words.length > maximumWords) {
        const text = kept ? chunk.trim() + value : chunk.trim()
        yield {
          text,
          words: chunkWordsCount,
          reason: 'limit',
        }
        yieldCount++
        chunk = ''
        chunkWordsCount = 0
      }

      chunk += buffer + value
      chunkWordsCount += words.length
      buffer = ''

      if (special) {
        const text = chunk.slice(0, -1).trim()
        yield {
          text,
          words: chunkWordsCount,
          reason: 'special',
        }
        yieldCount++
        chunk = ''
        chunkWordsCount = 0
      }
      // A boost chunk ends early at soft punctuation only once it is long enough to be worth its
      // own TTS request. A shorter opening clause stays in the chunk and joins the next one.
      else if (flush || hard || chunkWordsCount > maximumWords || (yieldCount < boost && chunkWordsCount >= minimumWords)) {
        const text = chunk.trim()
        yield {
          text,
          words: chunkWordsCount,
          reason: flush ? 'flush' : hard ? 'hard' : chunkWordsCount > maximumWords ? 'limit' : 'boost',
        }
        yieldCount++
        chunk = ''
        chunkWordsCount = 0
      }

      previousValue = value
      if (next !== undefined) {
        if (afterNext !== undefined) {
          current = afterNext
          next = undefined
          afterNext = undefined
        }
        else {
          current = next
          next = undefined
        }
      }
      else {
        current = await iterator.next()
      }
      continue
    }

    buffer += value
    previousValue = value
    next = await iterator.next()
    current = next
  }

  if (chunk.length > 0 || buffer.length > 0) {
    const text = (chunk + buffer).trim()
    yield {
      text,
      words: chunkWordsCount + [...segmenter.segment(buffer)].filter(w => w.isWordLike).length,
      reason: 'flush',
    }
  }
}

export async function chunkEmitter(
  reader: ReaderLike,
  pendingSpecials: string[],
  options: TtsInputChunkOptions | undefined,
  handler: (ttsSegment: TtsChunkItem) => Promise<void> | void,
) {
  function sanitizeChunk(text: string) {
    return text
      .replaceAll(TTS_SPECIAL_TOKEN, '')
      .replaceAll(TTS_FLUSH_INSTRUCTION, '')
      // Stripped decoration leaves the blanks that surrounded it behind.
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  }

  try {
    for await (const chunk of chunkTtsInput(reader, options)) {
      const cleanedText = sanitizeChunk(chunk.text)
      if (!cleanedText && chunk.reason !== 'special') {
        continue
      }

      if (chunk.reason === 'special') {
        const specialToken = pendingSpecials.shift()
        await handler({ chunk: cleanedText, special: specialToken ?? null, reason: chunk.reason })
      }
      else {
        await handler({ chunk: cleanedText, special: null, reason: chunk.reason })
      }
    }
  }
  catch (e) {
    console.error('Error chunking stream to TTS queue:', e)
  }
}

const BRACKET_MAP: Record<string, string> = {
  '[': ']',
  '(': ')',
  '（': '）',
  '【': '】',
  '<': '>',
}

const OPENERS = Object.keys(BRACKET_MAP)
const CLOSERS = Object.values(BRACKET_MAP)
const isUnicodeLetter = (char: string) => /\p{L}/u.test(char)

const NARRATIVE_KEYWORDS = [
  'laugh',
  'sigh',
  'action',
  'note',
  'breath',
  'giggle',
  'whisper',
  'cry',
  'smile',
  'thought',
]

export function isProbablyAngleTag(index: number, text: string): boolean {
  if (text[index] !== '<')
    return false

  if (text[index + 1] === '/')
    return true

  const remainder = text.slice(index + 1).toLowerCase()
  const nextChar = remainder[0]
  const prevChar = index > 0 ? text[index - 1] : ''

  // 1. 闭合标签 </... 永远判定为标签
  if (nextChar === '/')
    return true

  // Lookahead: if followed by num, space or equals, not a label
  if (nextChar && /[0-9\s=]/.test(nextChar))
    return false

  if (prevChar && (isUnicodeLetter(prevChar) || /\d/.test(prevChar))) {
    // fix: check whether remainder is piefix with any keywords, or contains the whole keyword
    const isLikelyNarrative = NARRATIVE_KEYWORDS.some(kw =>
      (remainder.length > 1 && kw.startsWith(remainder)) || remainder.startsWith(kw),
    )
    return isLikelyNarrative
  }

  // Lookbehind: if before is non-empty/non-bracket character, then determine as code or any instead of a label
  if (prevChar && /[^\s([{（【<\])}>）】.,!?;:，。！？；：'"\-_]/.test(prevChar))
    return false

  return true
}

/**
 * Openers whose closer often arrives far later in a stream, because the span
 * holds a whole stage direction rather than a word or two. A span opened by one
 * of these is held longer before the caller gives up waiting.
 */
const LONG_FORM_OPENERS = ['[', '【', '<', '（']

/** Characters held for an unclosed {@link LONG_FORM_OPENERS} span. */
const LONG_FORM_HOLD_LIMIT = 800
/** Characters held for any other unclosed marker, such as a lone `*`. */
const DEFAULT_HOLD_LIMIT = 200

interface NarrativeScan {
  /**
   * `text` with every completed narration and math span removed, and with the
   * delimiters of every completed pronunciation hint removed.
   */
  text: string
  /**
   * True when the scan ended inside a span whose closer never arrived. On a
   * partial stream that usually means the closer is still in flight.
   */
  hasUnclosed: boolean
  /**
   * How many characters a streaming caller should accumulate before it stops
   * waiting for the closer. Only meaningful while `hasUnclosed` is true.
   */
  holdLimit: number
}

/**
 * Single pass over `text` that both removes completed narration and math
 * spans and reports the marker state at the end of the string.
 *
 * Both results come from one walk on purpose. A streaming caller has to decide
 * "is a span still open?" using exactly the rule that decides "is this span
 * strippable?". Deciding them separately is what let `* *` slip through: an
 * asterisk-parity check called the span closed and released the text, while
 * this walk had an opener pending, so the closing `*` arrived orphaned and the
 * narration was spoken.
 */
function scanNarrative(text: string, options?: TtsInputChunkOptions): NarrativeScan {
  const rangesToRemove: [number, number][] = []
  const charsToRemove = new Set<number>()

  const stack: { char: string, index: number }[] = []
  let starOpenIndex = -1
  let mathOpenIndex = -1
  let pronunciationOpenIndex = -1
  // A `$` or `%` at the very end may be the first half of a `$$` or `%%` whose
  // second half is in the next token, so it counts as an open marker.
  let endsWithHalfDelimiter = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (options?.stripMath && char === '$') {
      if (text[i + 1] === '$') {
        if (mathOpenIndex !== -1) {
          rangesToRemove.push([mathOpenIndex, i + 1])
          mathOpenIndex = -1
        }
        else {
          mathOpenIndex = i
        }
        i += 1
        continue
      }

      endsWithHalfDelimiter = i === text.length - 1
    }

    // LaTeX uses `*`, brackets, and `<` as math, and `%` starts a LaTeX
    // comment. No other marker can open inside math.
    if (mathOpenIndex !== -1)
      continue

    if (options?.unwrapPronunciation && char === '%') {
      if (text[i + 1] === '%') {
        if (pronunciationOpenIndex !== -1) {
          charsToRemove.add(pronunciationOpenIndex)
          charsToRemove.add(pronunciationOpenIndex + 1)
          charsToRemove.add(i)
          charsToRemove.add(i + 1)
          pronunciationOpenIndex = -1
        }
        else {
          pronunciationOpenIndex = i
        }
        i += 1
        continue
      }

      endsWithHalfDelimiter = i === text.length - 1
    }

    if (!options?.stripNarrative)
      continue

    if (char === '*') {
      if (starOpenIndex !== -1) {
        if (options?.keepNarrativeText) {
          charsToRemove.add(starOpenIndex)
          charsToRemove.add(i)
        }
        else {
          rangesToRemove.push([starOpenIndex, i])
        }
        starOpenIndex = -1
      }
      else {
        if (!/\s/.test(text[i + 1] || '')) {
          starOpenIndex = i
        }
      }
      continue
    }

    if (OPENERS.includes(char)) {
      if (char === '<' && !isProbablyAngleTag(i, text))
        continue
      stack.push({ char, index: i })
      continue
    }

    if (CLOSERS.includes(char)) {
      const last = stack[stack.length - 1]
      if (last && BRACKET_MAP[last.char] === char) {
        stack.pop()
        if (options?.keepNarrativeText) {
          charsToRemove.add(last.index)
          charsToRemove.add(i)
        }
        else {
          rangesToRemove.push([last.index, i])
        }
      }
    }
  }

  // Spans whose text goes are ranges. Spans whose text stays, which are
  // pronunciation hints and narration under `keepNarrativeText`, put only their
  // delimiters in `charsToRemove`.
  let result = ''
  rangesToRemove.sort((a, b) => a[0] - b[0])
  let rangeIndex = 0

  for (let i = 0; i < text.length; i++) {
    while (
      rangeIndex < rangesToRemove.length
      && i > rangesToRemove[rangeIndex]![1]
    ) {
      rangeIndex += 1
    }

    const activeRange = rangesToRemove[rangeIndex]
    if (activeRange && i >= activeRange[0] && i <= activeRange[1])
      continue
    if (charsToRemove.has(i))
      continue

    result += text[i]
  }

  // Math is held as long as a long-form span: a display equation can run for
  // hundreds of characters before its closing `$$` arrives.
  const holdsLongForm = mathOpenIndex !== -1 || stack.some(entry => LONG_FORM_OPENERS.includes(entry.char))

  return {
    text: result,
    hasUnclosed: stack.length > 0
      || starOpenIndex !== -1
      || mathOpenIndex !== -1
      || pronunciationOpenIndex !== -1
      || endsWithHalfDelimiter,
    holdLimit: holdsLongForm ? LONG_FORM_HOLD_LIMIT : DEFAULT_HOLD_LIMIT,
  }
}

/** True when any option asks {@link scanNarrative} to rewrite spans. */
function rewritesSpans(options?: TtsInputChunkOptions): boolean {
  return Boolean(options?.stripNarrative || options?.stripMath || options?.unwrapPronunciation)
}

export function processNarrative(text: string, options?: TtsInputChunkOptions): string {
  if (!rewritesSpans(options))
    return text

  return scanNarrative(text, options).text
}

// ------------------------------------------------------------------
// Data flow processor
// ------------------------------------------------------------------

export function createTtsSegmentStream(
  tokens: ReadableStream<TextToken>,
  meta: { streamId: string, intentId: string, turnId?: string },
  options?: TtsInputChunkOptions,
) {
  const { stream, write, close, error } = createPushStream<TextSegment>()
  const pendingSpecials: string[] = []
  const encoder = new TextEncoder()

  const { stream: byteStream, write: writeBytes, close: closeBytes, error: errorBytes } = createPushStream<Uint8Array>()

  void (async () => {
    const reader = tokens.getReader()
    let pendingText = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done)
          break
        if (!value)
          continue

        if (value.type === 'literal') {
          if (value.value) {
            if (!rewritesSpans(options)) {
              writeBytes(encoder.encode(value.value))
              continue
            }

            // LLM tokens split at arbitrary points, so a span can straddle
            // several of them. Withhold text while a marker is open and release
            // it once the closer lands — or once the held text passes the hold
            // limit, which covers a model that never closes what it opened.
            pendingText += value.value

            const scan = scanNarrative(pendingText, options)
            if (scan.hasUnclosed && pendingText.length <= scan.holdLimit)
              continue

            writeBytes(encoder.encode(scan.text))
            pendingText = ''
          }
        }
        else if (value.type === 'special' || value.type === 'flush') {
          if (pendingText) {
            const textToEmit = processNarrative(pendingText, options)
            writeBytes(encoder.encode(textToEmit))
            pendingText = ''
          }

          if (value.type === 'special') {
            pendingSpecials.push(value.value ?? '')
            writeBytes(encoder.encode(TTS_SPECIAL_TOKEN))
          }
          else if (value.type === 'flush') {
            writeBytes(encoder.encode(TTS_FLUSH_INSTRUCTION))
          }
        }
      }
      if (pendingText)
        writeBytes(encoder.encode(processNarrative(pendingText, options)))
      closeBytes()
    }
    catch (err) {
      errorBytes(err)
    }
    finally {
      reader.releaseLock()
    }
  })()

  void (async () => {
    const reader = byteStream.getReader()
    try {
      await chunkEmitter(reader, pendingSpecials, options, async (chunk) => {
        write({
          turnId: meta.turnId,
          streamId: meta.streamId,
          intentId: meta.intentId,
          segmentId: `${meta.streamId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          text: chunk.chunk,
          special: chunk.special,
          reason: chunk.reason,
          createdAt: Date.now(),
        })
      })
      close()
    }
    catch (err) {
      error(err)
    }
    finally {
      reader.releaseLock()
    }
  })()

  return stream
}

// packages/pipelines-audio/src/processors/tts-chunker.test.ts

import type { TextToken } from '../types'
import type { TtsInputChunk } from './tts-chunker'

import { describe, expect, it } from 'vitest'

import { chunkTtsInput, createTtsSegmentStream, isProbablyAngleTag, processNarrative } from './tts-chunker'

async function collectChunks(text: string): Promise<TtsInputChunk[]> {
  const chunks: TtsInputChunk[] = []
  for await (const chunk of chunkTtsInput(text))
    chunks.push(chunk)
  return chunks
}

describe('chunkTtsInput boost', () => {
  // ROOT CAUSE:
  //
  // Boost chunks ended at any soft punctuation regardless of length, so "嗯，那就好，" became
  // "嗯，" plus "那就好，". A TTS request costs the same however short its text, so those
  // fragments delayed the audio boost exists to bring forward.
  it('does not yield boost fragments shorter than the minimum word count', async () => {
    const chunks = await collectChunks('嗯，那就好，听你说没事我心里就踏实了。倒是你，现在都两点了，')

    expect(chunks[0]?.text).not.toBe('嗯，')
    expect(chunks[0]?.text.startsWith('嗯，那就好，')).toBe(true)
    for (const chunk of chunks.filter(chunk => chunk.reason === 'boost'))
      expect(chunk.words).toBeGreaterThanOrEqual(4)
  })

  it('still yields a long opening clause early at soft punctuation', async () => {
    const chunks = await collectChunks('I really want to tell you something, and then I will say more.')

    expect(chunks[0]).toMatchObject({ text: 'I really want to tell you something,', reason: 'boost' })
  })
})

describe('tTS Chunker Logic Cleanup', () => {
  describe('isProbablyAngleTag Heuristics', () => {
    it('should identify narrative tags', () => {
      expect(isProbablyAngleTag(0, '<sigh>')).toBe(true)
    })

    it('should skip code patterns like generics', () => {
      expect(isProbablyAngleTag(4, 'List<String>')).toBe(false)
      expect(isProbablyAngleTag(1, 'x<y')).toBe(false)
    })
  })

  describe('processNarrative Function', () => {
    const options = { stripNarrative: true }

    it('should strip standard bracketed narrative', () => {
      expect(processNarrative('Hello [sighs] world', options)).toBe('Hello  world')
      expect(processNarrative('<<tag>>', options)).toBe('')
    })

    it('should restore stripping for CJK brackets', () => {
      expect(processNarrative('你好（叹气）世界', options)).toBe('你好世界')
      expect(processNarrative('【动作】你好', options)).toBe('你好')
    })

    it('should fix asterisk bullet leakage', () => {
      expect(processNarrative('* item 1', options)).toBe('* item 1')
      expect(processNarrative('*bold text*', options)).toBe('')
      expect(processNarrative('a*b', options)).toBe('a*b')
    })

    it('should handle complex nesting correctly', () => {
      expect(processNarrative('Normal (nested [action]) text', options)).toBe('Normal  text')
    })

    it('should handle open bracket correctly', () => {
      expect(processNarrative('Version (beta', options)).toBe('Version (beta')
    })

    it('should handle valid narrative tag', () => {
      expect(processNarrative('Hello,<laugh>', options)).toBe('Hello,')
      expect(processNarrative('Hello<laugh>', options)).toBe('Hello')
      expect(processNarrative('<laughs>Hello', options)).toBe('Hello')
      expect(processNarrative('Hello<laughs>', options)).toBe('Hello')
      expect(processNarrative('你好<laughs>', options)).toBe('你好')
      expect(processNarrative('List<T>', options)).toBe('List<T>')
    })

    it('should preserve code literals in keepNarrativeText mode', () => {
      const keepOptions = { stripNarrative: true, keepNarrativeText: true }
      expect(processNarrative('Value is List<String> [action]', keepOptions)).toContain('List<String>')
      expect(processNarrative('x < y (sigh)', keepOptions)).toContain('x < y')
      expect(processNarrative('price<limit', keepOptions)).toContain('price<limit')
    })

    it('should be case-insensitive for narrative tags', () => {
      const options = { stripNarrative: true }
      expect(processNarrative('Hello<LAUGHs>', options)).toBe('Hello')
      expect(processNarrative('abc<Action>', options)).toBe('abc')
      expect(processNarrative('List<String>', options)).toBe('List<String>')
    })
  })

  describe('createTtsSegmentStream narration stripping', () => {
    function streamOf(texts: string[]): ReadableStream<TextToken> {
      return new ReadableStream({
        start(controller) {
          texts.forEach((value, sequence) => controller.enqueue({
            type: 'literal',
            value,
            streamId: 's',
            intentId: 'i',
            sequence,
            createdAt: 0,
          }))
          controller.close()
        },
      })
    }

    async function collect(stream: ReadableStream<{ text: string }>): Promise<string> {
      const segments: string[] = []
      for await (const segment of stream)
        segments.push(segment.text)

      return segments.join(' ')
    }

    // Token boundaries deliberately fall inside `*smiles softly*`, which is how
    // an LLM actually streams it. Stripping each token on its own would speak
    // the narration and remove only the asterisks.
    const tokens = [
      'Hey',
      ' there',
      '!',
      ' *smi',
      'les soft',
      'ly*',
      ' How are you',
      ' today',
      '?',
      ' (quietly)',
      ' I missed you',
      '.',
    ]

    it('keeps narration audible when stripping is off', async () => {
      const stream = createTtsSegmentStream(streamOf(tokens), { streamId: 's', intentId: 'i' })

      expect(await collect(stream)).toBe('Hey there! *smiles softly* How are you today? (quietly) I missed you.')
    })

    // Guards the wiring as much as the stripping: `stripNarrative` reached this
    // code but nothing passed it, so the whole feature sat unreachable.
    it('drops narration spanning several tokens when stripping is on', async () => {
      const stream = createTtsSegmentStream(streamOf(tokens), { streamId: 's', intentId: 'i' }, { stripNarrative: true })

      expect(await collect(stream)).toBe('Hey there! How are you today? I missed you.')
    })

    // ROOT CAUSE:
    //
    // The hold/release decision counted asterisks for parity, while
    // processNarrative decided openers by looking at the next character. A
    // token carrying both a bullet and an emphasis opener made them disagree:
    // parity saw two asterisks in '* *' and called the span closed, so the
    // text was released even though processNarrative still had an opener
    // pending on the second one. The closer then arrived in a fresh buffer
    // with nothing to pair against, and the narration was voiced:
    //
    //   '* *'    -> released '* *'          // opener escapes
    //   'bold*'  -> released 'bold*'        // spoken aloud
    //   => '* *bold* rest'
    //
    // We fixed this by deriving both answers from one scanNarrative pass, so
    // "is a span open?" is by construction the same question as "is this span
    // strippable?". The split matters: '* ' and '*bo' as separate tokens
    // happen to survive the old logic, because releasing '* ' leaves the
    // opener at the head of the next buffer.
    it('holds a bullet-plus-opener token until its span completes', async () => {
      const stream = createTtsSegmentStream(
        streamOf(['* *', 'bold*', ' rest']),
        { streamId: 's', intentId: 'i' },
        { stripNarrative: true },
      )

      // The gap left by the stripped span is one blank, not two: `sanitizeChunk`
      // collapses blank runs so removed spans and removed emoji do not leave
      // ragged spacing in the spoken text.
      expect(await collect(stream)).toBe('* rest')
    })

    describe('math spans', () => {
      const mathOptions = { stripNarrative: true, stripMath: true }

      it('removes everything between double dollar signs', () => {
        expect(processNarrative('The speed $$v_0$$ is constant.', mathOptions)).toBe('The speed  is constant.')
        expect(processNarrative('$$E = mc^2$$', mathOptions)).toBe('')
      })

      it('keeps single dollar signs, which are currency', () => {
        expect(processNarrative('It costs $5, not $10.', mathOptions)).toBe('It costs $5, not $10.')
      })

      // LaTeX uses `(`, `[`, `<`, and `*` as math. If the narrative scan saw
      // them, `$$f(x)$$` would lose only `(x)` and `$$a*b + c*d$$` would open an
      // emphasis span that eats the rest of the reply.
      it('does not read markers inside math as narration', () => {
        expect(processNarrative('So $$f(x) = a*b + c*d$$ holds *nods*.', mathOptions)).toBe('So  holds .')
        expect(processNarrative('Then $$a < b$$ and $$[0, 1]$$ follow.', mathOptions)).toBe('Then  and  follow.')
      })

      it('removes math even when narration keeps its text', () => {
        const keepOptions = { ...mathOptions, keepNarrativeText: true }

        expect(processNarrative('Say $$x^2$$ *smiles*', keepOptions)).toBe('Say  smiles')
      })

      it('keeps math when math stripping is off', () => {
        expect(processNarrative('The speed $$v_0$$ is constant.', { stripNarrative: true })).toBe('The speed $$v_0$$ is constant.')
      })

      // An LLM can split `$$` itself across tokens. If a token that ends in one
      // `$` were released, the next token would start with an unpaired `$` and
      // the math would be spoken.
      it('drops math whose delimiters straddle tokens', async () => {
        const stream = createTtsSegmentStream(
          streamOf(['The speed $', '$v_0', ' = 3$', '$ stays', ' constant.']),
          { streamId: 's', intentId: 'i' },
          mathOptions,
        )

        expect(await collect(stream)).toBe('The speed stays constant.')
      })

      it('strips math with only math stripping on', async () => {
        const stream = createTtsSegmentStream(
          streamOf(['Area is $$\\pi r^2$$', ' *smiles*.']),
          { streamId: 's', intentId: 'i' },
          { stripMath: true },
        )

        expect(await collect(stream)).toBe('Area is *smiles*.')
      })
    })

    // The chat hides `%%...%%` and shows the formula. The voice skips the
    // formula and reads the hint, so only the delimiters go.
    describe('pronunciation hints', () => {
      const hintOptions = { stripNarrative: true, stripMath: true, unwrapPronunciation: true }

      it('keeps the hint text and removes its delimiters', () => {
        expect(processNarrative('The speed $$v_0$$ %%v naught%% is constant.', hintOptions)).toBe('The speed  v naught is constant.')
      })

      it('keeps single percent signs', () => {
        expect(processNarrative('It is 90% off.', hintOptions)).toBe('It is 90% off.')
      })

      // `%` starts a LaTeX comment, so `%%` inside math is part of the formula.
      it('ignores percent signs inside math', () => {
        expect(processNarrative('So $$a %% b$$ holds.', hintOptions)).toBe('So  holds.')
      })

      it('keeps the delimiters when unwrapping is off', () => {
        expect(processNarrative('Say %%v naught%% now.', { stripMath: true })).toBe('Say %%v naught%% now.')
      })

      // A released `%%` would be spoken, and its closer would then open a new
      // hint in the next buffer.
      it('unwraps a hint whose delimiters straddle tokens', async () => {
        const stream = createTtsSegmentStream(
          streamOf(['The speed $$v_0$$ %', '%v nau', 'ght%', '% is constant.']),
          { streamId: 's', intentId: 'i' },
          hintOptions,
        )

        expect(await collect(stream)).toBe('The speed v naught is constant.')
      })
    })

    // The chat renders a code block, but a voice reads its source character by character.
    describe('code blocks', () => {
      const codeTokens = [
        'Here is the hook.\n\n``',
        '`ts\nexport function useLocal',
        'StorageManualReset<T>(key) {\n  return state *2\n}\n``',
        '`\n\nIt syncs both ways.',
      ]

      it('speaks the replacement text instead of the code', async () => {
        const stream = createTtsSegmentStream(
          streamOf(codeTokens),
          { streamId: 's', intentId: 'i' },
          { stripNarrative: true, stripMath: true, unwrapPronunciation: true, codeBlockReplacement: 'this code block' },
        )

        expect(await collect(stream)).toBe('Here is the hook. this code block It syncs both ways.')
      })

      it('reads the code when no replacement is set', async () => {
        const stream = createTtsSegmentStream(streamOf(codeTokens), { streamId: 's', intentId: 'i' })

        expect(await collect(stream)).toContain('useLocalStorageManualReset')
      })
    })
  })

  describe('createTtsSegmentStream unspoken-character stripping', () => {
    function streamOf(texts: string[]): ReadableStream<TextToken> {
      return new ReadableStream({
        start(controller) {
          texts.forEach((value, sequence) => controller.enqueue({
            type: 'literal',
            value,
            streamId: 's',
            intentId: 'i',
            sequence,
            createdAt: 0,
          }))
          controller.close()
        },
      })
    }

    async function spoken(texts: string[]): Promise<string> {
      const segments: string[] = []
      const stream = createTtsSegmentStream(streamOf(texts), { streamId: 's', intentId: 'i' })
      for await (const segment of stream)
        segments.push(segment.text)

      return segments.join(' ')
    }

    it('keeps emoji and decoration out of the spoken text', async () => {
      expect(await spoken(['Hello \u{1F600} there, how are you \u2192 today?'])).toBe('Hello there, how are you today?')
      expect(await spoken(['Nice \u{1F468}\u200D\u{1F469}\u200D\u{1F467} family. Done \u2713 now.'])).toBe('Nice family. Done now.')
    })

    // ROOT CAUSE:
    //
    // The chunker discarded every grapheme cluster wider than one UTF-16 unit:
    //
    //   if (value.length > 1) { previousValue = value; continue }
    //
    // That removed emoji only as a side effect, and took decomposed accents,
    // complex-script clusters, and astral letters with them, so a decomposed
    // "cafe" spoke as "caf" and Devanagari vanished entirely.
    //
    // We fixed this by buffering the cluster and stripping only what is
    // genuinely unpronounceable.
    it('no longer eats multi-unit clusters that are real speech', async () => {
      // Asserted in the decomposed form that was fed in: the chunker preserves
      // the cluster, it does not normalize it.
      expect(await spoken(['cafe\u0301 au lait, bonjour.'])).toBe('cafe\u0301 au lait, bonjour.')
      expect(await spoken(['\u0928\u093F \u0939\u0948 \u0905\u091A\u094D\u091B\u093E.'])).toBe('\u0928\u093F \u0939\u0948 \u0905\u091A\u094D\u091B\u093E.')
      expect(await spoken(['say \u{20BB7} now.'])).toBe('say \u{20BB7} now.')
    })

    it('keeps phonetic notation, currency, and math spoken', async () => {
      expect(await spoken(['The \u0283 and \u0259 sounds.'])).toBe('The \u0283 and \u0259 sounds.')
      expect(await spoken(['It costs $5 + 3, about 90% off.'])).toBe('It costs $5 + 3, about 90% off.')
      expect(await spoken(['It is 25\u00B0C outside.'])).toBe('It is 25\u00B0C outside.')
    })

    it('does not glue words together when decoration sat between them', async () => {
      expect(await spoken(['hi\u{1F600}there, friend.'])).toBe('hi there, friend.')
    })

    it('emits no segment for a message that is only emoji', async () => {
      // A whitespace-only chunk must not reach `options.tts` as an empty
      // synthesis request.
      expect(await spoken(['\u{1F600}\u{1F600}\u{1F600}'])).toBe('')
    })

    it('strips an emoji whose surrogate pair straddles two literals', async () => {
      const emoji = '\u{1F600}'
      expect(await spoken(['hi ', emoji[0], emoji[1], ' there.'])).toBe('hi there.')
    })
  })

  describe('isProbablyAngleTag Stream Prefix Handling', () => {
    it('should identify partial prefixes of narrative keywords', () => {
      expect(isProbablyAngleTag(5, 'hello<sm')).toBe(true)
      expect(isProbablyAngleTag(5, 'hello<la')).toBe(true) // laugh 的前缀
    })

    it('should not identify non-narrative prefixes as tags', () => {
      expect(isProbablyAngleTag(4, 'List<Str')).toBe(false)
    })
  })

  describe('edge Cases test', () => {
    it('should not treat single-letter operands as narrative prefixes', () => {
      expect(isProbablyAngleTag(1, 'a<b')).toBe(false)
      expect(isProbablyAngleTag(1, 'x<s')).toBe(false)
    })

    it('should support non-CJK Unicode letters as tag context', () => {
      expect(isProbablyAngleTag(4, 'café<laugh>')).toBe(true)
      expect(isProbablyAngleTag(6, 'привет<sigh>')).toBe(true)
    })
  })
})

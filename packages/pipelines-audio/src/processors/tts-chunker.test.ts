// packages/pipelines-audio/src/processors/tts-chunker.test.ts

import type { TextToken } from '../types'

import { describe, expect, it } from 'vitest'

import { createTtsSegmentStream, isProbablyAngleTag, processNarrative } from './tts-chunker'

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

      expect(await collect(stream)).toBe('*  rest')
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

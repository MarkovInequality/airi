import { describe, expect, it } from 'vitest'

import { useLlmmarkerParser } from './llm-marker-parser'

/**
 * @example
 * const parser = useLlmmarkerParser({ onLiteral, onSpecial })
 */
describe('useLlmmarkerParser', () => {
  /**
   * @example
   * Plain model text is emitted as literal output.
   */
  it('parses pure literals', async () => {
    const collectedLiterals: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
    })

    await parser.consume('Hello, world!')
    await parser.end()

    expect(collectedLiterals.join('')).toBe('Hello, world!')
  })

  /**
   * @example
   * `<|...|>` markers are emitted as special output.
   */
  it('parses special markers separately from literals', async () => {
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
      onSpecial: (special) => {
        collectedSpecials.push(special)
      },
    })

    await parser.consume('Hello <|ACT|> world')
    await parser.end()

    expect(collectedLiterals.join('')).toBe('Hello  world')
    expect(collectedSpecials).toEqual(['<|ACT|>'])
  })

  /**
   * @example
   * Unfinished markers are withheld instead of leaking into literal text.
   */
  it('does not include unfinished special markers', async () => {
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
      onSpecial: (special) => {
        collectedSpecials.push(special)
      },
    })

    await parser.consume('<|unfinished')
    await parser.end()

    expect(collectedLiterals).toEqual([])
    expect(collectedSpecials).toEqual([])
  })

  it('flushes the held tail and waits until its callbacks finish', async () => {
    const collectedLiterals: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: async (literal) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        collectedLiterals.push(literal)
      },
    })

    await parser.consume('Let me look ')
    await parser.consume('at the repository.')
    await parser.flush()

    expect(collectedLiterals.join('')).toBe('Let me look at the repository.')
  })

  it('keeps an unfinished marker in the buffer on flush, so the next chunk can complete it', async () => {
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
      onSpecial: (special) => {
        collectedSpecials.push(special)
      },
    })

    await parser.consume('Hello <|EMO')
    await parser.flush()

    expect(collectedLiterals.join('')).toBe('Hello ')
    expect(collectedSpecials).toEqual([])

    await parser.consume('TE|> there')
    await parser.end()

    expect(collectedLiterals.join('')).toBe('Hello  there')
    expect(collectedSpecials).toEqual(['<|EMOTE|>'])
  })
})

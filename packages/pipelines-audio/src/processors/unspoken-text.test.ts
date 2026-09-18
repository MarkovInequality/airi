import { describe, expect, it } from 'vitest'

import { createUnspokenTextFilter, stripUnspokenText } from './unspoken-text'

describe('stripUnspokenText', () => {
  it('strips pictographs and their sequence glue', () => {
    expect(stripUnspokenText('Hello 😀 world')).toBe('Hello world')
    expect(stripUnspokenText('a 👨‍👩‍👧 b')).toBe('a b')
    expect(stripUnspokenText('wave 👋🏽 now')).toBe('wave now')
    expect(stripUnspokenText('flag 🇯🇵 here')).toBe('flag here')
    expect(stripUnspokenText('heart ❤️ shape')).toBe('heart shape')
  })

  it('strips decoration that sits in otherwise-kept categories', () => {
    // Arrows are Math_Symbol next to `+`, bullets are Other_Punctuation next
    // to `.`, so a plain category match would have kept both.
    expect(stripUnspokenText('left → right')).toBe('left right')
    // Edge blanks survive on purpose; `sanitizeChunk` trims at the emit boundary.
    expect(stripUnspokenText('• item')).toBe(' item')
    expect(stripUnspokenText('done ✓ ♪ ★ ▓')).toBe('done ')
  })

  it('keeps everything a listener expects to hear', () => {
    // The chosen scope: phonetic notation is pronunciation, and engines
    // verbalize currency, math, and the degree sign.
    expect(stripUnspokenText('the ʃ ə ˈ ː sounds')).toBe('the ʃ ə ˈ ː sounds')
    expect(stripUnspokenText('costs $5 + €3 = 90% < 100')).toBe('costs $5 + €3 = 90% < 100')
    expect(stripUnspokenText('it is 25°C today')).toBe('it is 25°C today')
    expect(stripUnspokenText('café Müller 日本語 नि 안녕')).toBe('café Müller 日本語 नि 안녕')
    expect(stripUnspokenText('wait... really?! yes; no, #tag & 42')).toBe('wait... really?! yes; no, #tag & 42')
  })

  it('bridges words that decoration was holding apart', () => {
    expect(stripUnspokenText('hi😀there')).toBe('hi there')
    expect(stripUnspokenText('a→b')).toBe('a b')
  })

  it('leaves a lone blank chunk intact', () => {
    // The chunk carrying only the space between two streamed words must stay a
    // space, or the words downstream run together.
    expect(stripUnspokenText(' ')).toBe(' ')
    expect(stripUnspokenText('\n')).toBe('\n')
    expect(stripUnspokenText('')).toBe('')
  })

  it('reduces an all-emoji message to nothing speakable', () => {
    expect(stripUnspokenText('😀😀😀').trim()).toBe('')
  })
})

describe('createUnspokenTextFilter', () => {
  // ROOT CAUSE:
  //
  // The marker parser emits `buffer.slice(0, -5)`, so a chunk boundary can land
  // between the two UTF-16 units of one astral code point. Neither half matches
  // any Unicode property alone, so a stateless per-chunk strip would forward
  // both halves and the upstream model would receive replacement characters.
  //
  // We fixed this by withholding a trailing high surrogate until its low half
  // arrives in the next chunk.
  it('strips an emoji split across two chunks', () => {
    const filter = createUnspokenTextFilter()
    const emoji = '😀'

    const first = filter.push(`hi ${emoji[0]}`)
    const second = filter.push(`${emoji[1]} there`)

    expect(first).toBe('hi ')
    expect(`${first}${second}`).not.toContain('�')
    expect(`${first}${second}`.replace(/\s+/g, ' ')).toBe('hi there')
  })

  it('reassembles an astral letter split across two chunks', () => {
    // The same split must not destroy a non-BMP letter, which is spoken.
    const filter = createUnspokenTextFilter()
    const letter = '𠮷'

    const first = filter.push(`say ${letter[0]}`)
    const second = filter.push(`${letter[1]} now`)

    expect(`${first}${second}`).toBe(`say ${letter} now`)
  })

  it('drops a withheld half code point on reset', () => {
    const filter = createUnspokenTextFilter()

    expect(filter.push('hi \uD83D')).toBe('hi ')
    filter.reset()
    expect(filter.push('there')).toBe('there')
  })

  it('passes ordinary chunks through untouched', () => {
    const filter = createUnspokenTextFilter()

    expect(filter.push('Hello')).toBe('Hello')
    expect(filter.push(' ')).toBe(' ')
    expect(filter.push('world.')).toBe('world.')
  })
})

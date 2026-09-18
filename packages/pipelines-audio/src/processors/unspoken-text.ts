/**
 * Removes characters a TTS engine cannot pronounce.
 *
 * Both speech paths feed this: the segmenter path strips per grapheme cluster
 * inside {@link chunkTtsInput}, and the bidirectional streaming path strips
 * whole chunks before they reach the upstream model. An engine handed an emoji
 * either skips it, spells out its CLDR name ("grinning face"), or stalls, and
 * the streaming upstream is billed for it either way.
 *
 * Scope is deliberately narrow — anything a listener would expect to hear stays:
 *
 * - Stripped: pictographs and their sequence glue (ZWJ, variation selectors,
 *   skin-tone modifiers, keycaps), `Other_Symbol` (♪ ✓ ★ ▓ © ®, which also
 *   covers flag regional indicators), arrows, and bullets.
 * - Kept: currency (`$ € ¥`) and math (`+ = % < >`), which engines verbalize;
 *   the degree sign, which they read as "degrees"; phonetic/IPA characters
 *   (ʃ ə ˈ ː), which are pronunciation, not decoration; and every letter, mark,
 *   digit, and punctuation mark, since punctuation drives sentence chunking.
 */

/**
 * `Other_Symbol` covers most decoration, but two groups sit in categories we
 * otherwise keep wholesale: arrows are `Math_Symbol` alongside `+` and `=`, and
 * bullets are `Other_Punctuation` alongside `.` and `?`. They are named here by
 * range instead of by category so the kept members of those categories survive.
 */
const DECORATION_RANGES = '\\u2190-\\u21FF\\u27F0-\\u27FF\\u2900-\\u297F\\u2022\\u2023\\u2043'

/**
 * Emoji glue that carries no meaning alone. `\p{Extended_Pictographic}` matches
 * the visible bases; these join them into one cluster, and a stream can split a
 * sequence so that only the glue lands in a chunk.
 */
const EMOJI_JOINERS = '\\u200D\\uFE0E\\uFE0F\\u20E3'

/**
 * `°` is `Other_Symbol` but is read aloud ("25 degrees"), so a lookahead
 * excludes it. The `v` flag's set subtraction would express this directly, but
 * `u` keeps the pattern usable on the older runtimes this package targets.
 */
const UNSPOKEN_SET = `(?!\\u00B0)[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{So}${EMOJI_JOINERS}${DECORATION_RANGES}]`

const unspokenProbe = new RegExp(UNSPOKEN_SET, 'u')
const unspokenBetweenWords = new RegExp(`(?<=\\S)(?:${UNSPOKEN_SET})+(?=\\S)`, 'gu')
const unspokenRun = new RegExp(`(?:${UNSPOKEN_SET})+`, 'gu')
const repeatedBlanks = /[ \t]{2,}/g

/**
 * Strips unpronounceable characters, replacing a run with a space only when it
 * joins two visible characters so `hi😀there` does not become `hithere`.
 * Blank runs collapse, but leading and trailing blanks survive: a chunk that is
 * only the space between two streamed words must stay a space.
 *
 * @example
 * stripUnspokenText('Hi 😀! The ʃ sound costs $5 ♪')
 * // => 'Hi ! The ʃ sound costs $5 '
 *
 * @example
 * stripUnspokenText('hi😀there')
 * // => 'hi there'
 */
export function stripUnspokenText(text: string): string {
  if (!unspokenProbe.test(text))
    return text

  return text
    .replace(unspokenBetweenWords, ' ')
    .replace(unspokenRun, '')
    .replace(repeatedBlanks, ' ')
}

/**
 * Stateful wrapper for callers that strip a chunk at a time.
 *
 * A UTF-16 surrogate pair can straddle two chunks, and neither half matches any
 * Unicode property on its own, so a per-chunk strip would pass both halves
 * through as replacement characters. `push` withholds a trailing high surrogate
 * until its low half arrives. Emoji ZWJ sequences need no such care: every part
 * is stripped on its own.
 *
 * @example
 * const filter = createUnspokenTextFilter()
 * filter.push('hi \uD83D') // => 'hi ' — the pair is incomplete, so it waits
 * filter.push('\uDE00 there') // => ' there'
 */
export function createUnspokenTextFilter(): {
  push: (text: string) => string
  reset: () => void
} {
  let pendingHighSurrogate = ''

  return {
    push(text: string) {
      const combined = pendingHighSurrogate + text
      pendingHighSurrogate = ''

      const lastUnit = combined.charCodeAt(combined.length - 1)
      if (lastUnit >= 0xD800 && lastUnit <= 0xDBFF) {
        pendingHighSurrogate = combined.slice(-1)
        return stripUnspokenText(combined.slice(0, -1))
      }

      return stripUnspokenText(combined)
    },
    /**
     * Drops a withheld surrogate. Its low half is never arriving, and half a
     * code point is not pronounceable.
     */
    reset() {
      pendingHighSurrogate = ''
    },
  }
}

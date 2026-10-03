/** A line start that can still grow into an opening fence. */
const OPEN_FENCE_PREFIX = /^[ \t]*`*$/
/** A line start that can still be a closing fence, which can end with blanks. */
const CLOSE_FENCE_PREFIX = /^[ \t]*(?:`+[ \t]*)?$/

/**
 * Stateful filter that replaces each fenced Markdown code block with spoken text.
 *
 * Use when:
 * - Streamed LLM text goes to TTS. The chat renders a code block, but a voice reads its
 *   source aloud character by character.
 *
 * Expects:
 * - Chunks arrive in stream order. Call `flush` once when the stream ends.
 * - An opening fence is a line that starts with three or more backticks after optional blanks.
 *   A closing fence is a line of only blanks and at least as many backticks.
 *
 * Returns:
 * - `push` returns the text that is safe to speak now. It holds a line start of only blanks
 *   and backticks, because the next chunk can turn it into a fence.
 * - `flush` returns the held text and resets the filter.
 *
 * @example
 * const filter = createCodeBlockTextFilter('this code block')
 * filter.push('Here:\n``') // => 'Here:\n'
 * filter.push('`ts\nconst a = 1\n```\nDone.') // => 'this code block\nDone.'
 */
export function createCodeBlockTextFilter(replacement: string): {
  push: (text: string) => string
  flush: () => string
} {
  /** Backtick count of the open fence. 0 when no code block is open. */
  let fenceLength = 0
  /** True while the current line can still be a fence. */
  let inLinePrefix = true
  /** The held start of the current line. It holds only blanks and backticks. */
  let prefix = ''

  /**
   * Decides what the held line start is. Returns the text to speak.
   *
   * @param lineEnded True when a line break or the stream end follows the held text.
   */
  function resolvePrefix(lineEnded: boolean): string {
    const held = prefix
    const backticks = held.trim().length
    prefix = ''
    inLinePrefix = false

    if (fenceLength > 0) {
      if (lineEnded && backticks >= fenceLength)
        fenceLength = 0

      return ''
    }

    if (backticks >= 3) {
      fenceLength = backticks
      return replacement
    }

    return held
  }

  return {
    push(text: string) {
      let output = ''

      for (const char of text) {
        if (inLinePrefix) {
          const candidate = prefix + char
          const fencePrefix = fenceLength > 0 ? CLOSE_FENCE_PREFIX : OPEN_FENCE_PREFIX
          if (char !== '\n' && fencePrefix.test(candidate)) {
            prefix = candidate
            continue
          }

          output += resolvePrefix(char === '\n')
        }

        if (char === '\n')
          inLinePrefix = true

        // The line break after a closing fence is outside the block, so it is spoken.
        if (fenceLength === 0)
          output += char
      }

      return output
    },
    flush() {
      const output = inLinePrefix ? resolvePrefix(true) : ''
      fenceLength = 0
      inLinePrefix = true

      return output
    },
  }
}

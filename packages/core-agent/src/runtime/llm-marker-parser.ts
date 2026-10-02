const TAG_OPEN = '<|'
const TAG_CLOSE = '|>'
const ESCAPED_TAG_OPEN = '<{\'|\'}'
const ESCAPED_TAG_CLOSE = '{\'|\'}>'

interface MarkerParserOptions {
  minLiteralEmitLength?: number
}

function createLlmMarkerParser(options?: MarkerParserOptions) {
  const minLiteralEmitLength = Math.max(1, options?.minLiteralEmitLength ?? 1)
  const tailLength = Math.max(TAG_OPEN.length - 1, ESCAPED_TAG_OPEN.length - 1)
  let buffer = ''
  let inTag = false

  return {
    async consume(textPart: string, onLiteral: (value: string) => Promise<void> | void, onSpecial: (value: string) => Promise<void> | void) {
      buffer += textPart
      buffer = buffer
        .replaceAll(ESCAPED_TAG_OPEN, TAG_OPEN)
        .replaceAll(ESCAPED_TAG_CLOSE, TAG_CLOSE)

      while (buffer.length > 0) {
        if (!inTag) {
          const openTagIndex = buffer.indexOf(TAG_OPEN)
          if (openTagIndex < 0) {
            if (buffer.length - tailLength >= minLiteralEmitLength) {
              const emit = buffer.slice(0, -tailLength)
              buffer = buffer.slice(-tailLength)
              await onLiteral(emit)
            }
            break
          }

          if (openTagIndex > 0) {
            const emit = buffer.slice(0, openTagIndex)
            buffer = buffer.slice(openTagIndex)
            await onLiteral(emit)
          }
          inTag = true
        }
        else {
          const closeTagIndex = buffer.indexOf(TAG_CLOSE)
          if (closeTagIndex < 0)
            break

          const emit = buffer.slice(0, closeTagIndex + TAG_CLOSE.length)
          buffer = buffer.slice(closeTagIndex + TAG_CLOSE.length)
          await onSpecial(emit)
          inTag = false
        }
      }
    },

    /**
     * Emits the held tail. A tail inside an unfinished marker stays in the buffer, because
     * the rest of the marker can still arrive.
     */
    async flush(onLiteral: (value: string) => Promise<void> | void) {
      if (!inTag && buffer.length > 0) {
        await onLiteral(buffer)
        buffer = ''
      }
    },
  }
}

/**
 * Creates a streaming parser for LLM responses with AIRI special markers.
 *
 * Use when:
 * - Handling streamed model output that may contain `<|...|>` markers.
 * - Literal text and special marker tokens need to be emitted separately.
 *
 * Expects:
 * - Callers feed chunks in order and call `end()` once the model stream ends.
 *
 * Returns:
 * - A parser with `consume()`, `flush()`, and `end()` methods.
 */
export function useLlmmarkerParser(options: {
  onLiteral?: (literal: string) => void | Promise<void>
  onSpecial?: (special: string) => void | Promise<void>
  /**
   * Called when parsing ends with the full accumulated text.
   * Useful for final processing like categorization or filtering.
   */
  onEnd?: (fullText: string) => void | Promise<void>
  /**
   * The minimum length of text required to emit a literal part.
   * Useful for avoiding emitting literal parts too fast.
   */
  minLiteralEmitLength?: number
}) {
  let fullText = ''
  const parser = createLlmMarkerParser({ minLiteralEmitLength: options.minLiteralEmitLength })

  const emitLiteral = async (literal: string) => {
    if (literal)
      await options.onLiteral?.(literal)
  }
  const emitSpecial = async (special: string) => {
    await options.onSpecial?.(special)
  }

  // Each call adds one step to this chain, so chunks are parsed and their callbacks run one
  // at a time, in the order of the calls. `consume` does not wait for its step, so a slow
  // callback does not hold back the caller. `flush` and `end` wait for every earlier step.
  // After a callback throws, the chain stays rejected and `flush` and `end` throw that error.
  let processing: Promise<void> = Promise.resolve()
  function schedule(step: () => Promise<void>) {
    processing = processing.then(step)
    // Marks the rejection as handled while no caller waits. `flush` and `end` still receive it.
    processing.catch(() => {})
    return processing
  }

  return {
    /**
     * Consumes a chunk of text from the stream.
     *
     * @param textPart The chunk of text to consume.
     */
    async consume(textPart: string) {
      fullText += textPart
      void schedule(() => parser.consume(textPart, emitLiteral, emitSpecial))
    },

    /**
     * Emits all text consumed so far, including the tail that the parser holds back to find
     * markers, and resolves when the callbacks for that text are done.
     *
     * Call it at a boundary in the stream, such as a tool call, so that the text before the
     * boundary is delivered before the caller handles the boundary.
     */
    async flush() {
      await schedule(() => parser.flush(emitLiteral))
    },

    /**
     * Finalizes the parsing process.
     * Any remaining content in the buffer is flushed as a final literal part.
     */
    async end() {
      await schedule(() => parser.flush(emitLiteral))
      await options.onEnd?.(fullText)
    },
  }
}

import { describe, expect, it } from 'vitest'

import { createCodeBlockTextFilter } from './code-block-text'

function filterChunks(chunks: string[]): string {
  const filter = createCodeBlockTextFilter('this code block')
  return chunks.map(chunk => filter.push(chunk)).join('') + filter.flush()
}

function chunksOf(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size)
    chunks.push(text.slice(index, index + size))

  return chunks
}

describe('createCodeBlockTextFilter', () => {
  const reply = [
    'Here is the hook:',
    '',
    '```ts',
    'export function useLocalStorageManualReset<T>(key, initialValue, options?) {',
    '  return refManualReset<T>(useLocalStorage<T>(key, value, options))',
    '}',
    '```',
    '',
    'It syncs both ways.',
  ].join('\n')

  it('replaces a fenced code block with the replacement text', () => {
    expect(filterChunks([reply])).toBe('Here is the hook:\n\nthis code block\n\nIt syncs both ways.')
  })

  // A model streams a fence in pieces, so `` ` `` and `` `` `` must wait for the rest of the line.
  it('gives the same result for any chunk size', () => {
    for (const size of [1, 2, 3, 5, 17])
      expect(filterChunks(chunksOf(reply, size))).toBe('Here is the hook:\n\nthis code block\n\nIt syncs both ways.')
  })

  it('replaces each code block on its own', () => {
    const text = 'First:\n```\na()\n```\nSecond:\n```py\nb()\n```\nEnd.'

    expect(filterChunks([text])).toBe('First:\nthis code block\nSecond:\nthis code block\nEnd.')
  })

  it('keeps inline code and backticks that do not start a line', () => {
    const text = 'Call `useLocalStorage<T>()` and type ``` to start a block.'

    expect(filterChunks(chunksOf(text, 2))).toBe(text)
  })

  it('accepts an indented fence, such as one inside a list', () => {
    const text = '1. Run this:\n   ```sh\n   pnpm i\n   ```\n2. Done.'

    expect(filterChunks([text])).toBe('1. Run this:\nthis code block\n2. Done.')
  })

  it('closes only on a line of at least as many backticks', () => {
    const text = '````md\n```ts\nx\n```\n````\nAfter.'

    expect(filterChunks(chunksOf(text, 3))).toBe('this code block\nAfter.')
  })

  it('drops the rest of a code block that never closes', () => {
    expect(filterChunks(['Look:\n```ts\nconst a = 1\n', 'const b = 2'])).toBe('Look:\nthis code block')
  })

  it('returns held blanks and backticks at the stream end', () => {
    expect(filterChunks(['Done.\n  ', '``'])).toBe('Done.\n  ``')
  })
})

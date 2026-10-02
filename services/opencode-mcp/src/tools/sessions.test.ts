import { describe, expect, it, vi } from 'vitest'

import { createCommandTracker } from './sessions'

describe('createCommandTracker', () => {
  it('records no failure when a long command ends its request with a headers timeout', async () => {
    const tracker = createCommandTracker()
    // Node 24 `fetch` rejects with this shape when a response sends no headers in 300 seconds.
    const headersTimeout = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Headers Timeout Error'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' }),
    })

    tracker.start('ses_1', Promise.reject(headersTimeout))
    await vi.waitFor(() => expect(tracker.isRunning('ses_1')).toBe(false))

    expect(tracker.takeFailure('ses_1')).toBeUndefined()
  })
})

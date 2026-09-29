import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $parkedQueueSessions,
  $queuedPromptsBySession,
  enqueueQueuedPrompt,
  getQueuedPrompts,
  isQueueParked,
  MAX_AUTO_DRAIN_ATTEMPTS,
  parkQueuedPrompts,
  removeQueuedPrompt
} from '@/store/composer-queue'
import { $salvagedEditNotice, undoSalvagedEdit } from '@/store/composer'
import { setSessionsLoading } from '@/store/session'

import type { QueueEditState } from '../composer-utils'
import type { ChatBarProps } from '../types'

import { useComposerQueue } from './use-composer-queue'

// The park ↔ drain contract at the hook level. The store tests pin the pure
// pieces (shouldAutoDrain, park bookkeeping); these pin the wiring — the
// auto-drain effect honoring the park, and send-now-while-busy lifting it so
// the settle drain still flows (the regression that sank the old blanket
// interrupt latch).

const SESSION_KEY = 'stored-session-queue-hook'

function renderQueueHook(overrides: { busy?: boolean; onCancel?: () => void; onSteer?: ChatBarProps['onSteer'] } = {}) {
  const onSubmit = vi.fn<ChatBarProps['onSubmit']>(async () => true)
  const onCancel = overrides.onCancel ?? vi.fn()
  const onSteer = overrides.onSteer
  const queueEditRef: { current: QueueEditState | null } = { current: null }

  const hook = renderHook(
    ({ busy }: { busy: boolean }) =>
      useComposerQueue({
        activeQueueSessionKey: SESSION_KEY,
        attachments: [],
        busy,
        clearDraft: () => undefined,
        draftRef: { current: '' },
        focusInput: () => undefined,
        loadIntoComposer: () => undefined,
        onCancel,
        onSteer,
        onSubmit,
        queueEditRef,
        queueSessionKey: SESSION_KEY,
        sessionId: 'rt-session-queue-hook'
      }),
    { initialProps: { busy: overrides.busy ?? false } }
  )

  return { hook, onCancel, onSubmit }
}

describe('useComposerQueue park integration', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $queuedPromptsBySession.set({})
    $parkedQueueSessions.set({})
    setSessionsLoading(false)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    $queuedPromptsBySession.set({})
    $parkedQueueSessions.set({})
    setSessionsLoading(true)
  })

  it('reschedules rejected foreground drains to a bounded stop and keeps manual recovery', async () => {
    vi.useFakeTimers()

    try {
      const entry = enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'recoverable' })!
      const { hook, onSubmit } = renderQueueHook({ busy: true })
      onSubmit.mockResolvedValue(false)
      hook.rerender({ busy: false })
      await act(async () => {
        await Promise.resolve()
      })

      for (let attempt = 1; attempt < MAX_AUTO_DRAIN_ATTEMPTS; attempt++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000)
        })
      }

      expect(onSubmit).toHaveBeenCalledTimes(MAX_AUTO_DRAIN_ATTEMPTS)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000)
      })
      expect(onSubmit).toHaveBeenCalledTimes(MAX_AUTO_DRAIN_ATTEMPTS)
      expect(getQueuedPrompts(SESSION_KEY).map(item => item.text)).toEqual(['recoverable'])
      onSubmit.mockResolvedValue(true)
      await act(async () => {
        await hook.result.current.sendQueuedNow(entry.id)
      })
      expect(getQueuedPrompts(SESSION_KEY)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending retry on unmount without losing the queued entry', async () => {
    vi.useFakeTimers()

    try {
      enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'keep on disconnect' })
      const { hook, onSubmit } = renderQueueHook({ busy: true })
      onSubmit.mockRejectedValue(new Error('unavailable'))
      hook.rerender({ busy: false })
      await act(async () => {
        await Promise.resolve()
      })
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      hook.unmount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000)
      })
      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(getQueuedPrompts(SESSION_KEY)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-drains an unparked queue once idle', async () => {
    enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'flows' })

    const { onSubmit } = renderQueueHook()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(getQueuedPrompts(SESSION_KEY)).toHaveLength(0)
  })

  it('holds a parked queue at the idle settle (the Stop edge)', async () => {
    enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'halted' })
    parkQueuedPrompts(SESSION_KEY)

    const { hook, onSubmit } = renderQueueHook({ busy: true })

    // The Stop settle: busy flips false with the park in place.
    hook.rerender({ busy: false })

    await act(async () => {
      await Promise.resolve()
    })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(getQueuedPrompts(SESSION_KEY)).toHaveLength(1)
  })

  it('drainNextQueued sends a parked entry and lifts the park (manual resume)', async () => {
    enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'resumed' })
    parkQueuedPrompts(SESSION_KEY)

    const { hook, onSubmit } = renderQueueHook()

    await act(async () => {
      await hook.result.current.drainNextQueued()
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(isQueueParked(SESSION_KEY)).toBe(false)
  })

  it('sendQueuedNow while busy unparks so the settle drain flows (no stale latch)', async () => {
    const first = enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'first' })
    enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'send me now' })
    parkQueuedPrompts(SESSION_KEY)

    const { hook, onCancel, onSubmit } = renderQueueHook({ busy: true })
    const target = getQueuedPrompts(SESSION_KEY).find(e => e.id !== first!.id)!

    act(() => {
      hook.result.current.sendQueuedNow(target.id)
    })

    // The interrupt fired and the park lifted — this interrupt exists to reach
    // the queue, not to halt it.
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(isQueueParked(SESSION_KEY)).toBe(false)

    // Turn settles → the promoted entry drains.
    hook.rerender({ busy: false })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]?.[0]).toBe('send me now')
  })

  it('steerQueuedNow delivers via onSteer without cancelling and removes the entry', async () => {
    const entry = enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'steer me' })
    const onSteer = vi.fn(async () => true)
    const { hook, onCancel, onSubmit } = renderQueueHook({ busy: true, onSteer })

    await act(async () => {
      expect(await hook.result.current.steerQueuedNow(entry!.id)).toBe(true)
    })

    expect(onSteer).toHaveBeenCalledWith('steer me')
    // A redirect rides the live turn: no interrupt, no submit.
    expect(onCancel).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(getQueuedPrompts(SESSION_KEY)).toHaveLength(0)
  })

  it('a rejected steer leaves the entry queued so the settle drain still sends it', async () => {
    const entry = enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'kept on reject' })
    const onSteer = vi.fn(async () => false)
    const { hook, onSubmit } = renderQueueHook({ busy: true, onSteer })

    await act(async () => {
      expect(await hook.result.current.steerQueuedNow(entry!.id)).toBe(false)
    })

    expect(getQueuedPrompts(SESSION_KEY)).toHaveLength(1)

    // Turn settles → the surviving entry drains normally.
    hook.rerender({ busy: false })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]?.[0]).toBe('kept on reject')
  })

  it('steerQueuedNow refuses unsteerable entries (slash commands execute, never steer)', async () => {
    const slash = enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: '/compress' })
    const onSteer = vi.fn(async () => true)

    // Busy, but a slash command never steers. (Idle needs no case of its own:
    // an idle session auto-drains its queue, so there is never an entry left
    // to steer — asserting that here would just re-test auto-drain.)
    const busy = renderQueueHook({ busy: true, onSteer })

    await act(async () => {
      expect(await busy.hook.result.current.steerQueuedNow(slash!.id)).toBe(false)
    })

    expect(onSteer).not.toHaveBeenCalled()
    expect(getQueuedPrompts(SESSION_KEY)).toHaveLength(1)
  })

  it('a delivered steer lifts the park so the rest of the queue flows', async () => {
    const steerable = enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'redirect' })
    enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'follows after' })
    parkQueuedPrompts(SESSION_KEY)

    const onSteer = vi.fn(async () => true)
    const { hook } = renderQueueHook({ busy: true, onSteer })

    await act(async () => {
      expect(await hook.result.current.steerQueuedNow(steerable!.id)).toBe(true)
    })

    expect(isQueueParked(SESSION_KEY)).toBe(false)
    expect(getQueuedPrompts(SESSION_KEY)).toHaveLength(1)
  })

  it('does not auto-drain restored queues while the session list is still loading', async () => {
    setSessionsLoading(true)
    enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'wait for session list' })

    const { onSubmit } = renderQueueHook()

    await act(async () => {
      await Promise.resolve()
    })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(getQueuedPrompts(SESSION_KEY)).toHaveLength(1)
  })

  it('auto-drains a restored queue once the session list finishes loading', async () => {
    setSessionsLoading(true)
    enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'send after load' })

    const { hook, onSubmit } = renderQueueHook()

    await act(async () => {
      await Promise.resolve()
    })
    expect(onSubmit).not.toHaveBeenCalled()

    setSessionsLoading(false)
    hook.rerender({ busy: false })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(getQueuedPrompts(SESSION_KEY)).toHaveLength(0)
  })

  it('keeps a dirty in-progress queued edit when the turn settles in the background (#88621)', async () => {
    // The reporter's scenario: the user opens a queued prompt for in-place
    // editing and types for ~a minute; a background turn unwinds ("Operation
    // interrupted" / timeout / settle) and the queue starts flowing again.
    // The drain must not send the stale pre-edit text out from under the user,
    // and the edit must not be cancelled back to the pre-edit draft — either
    // way the typed minute is lost.
    const entry = enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'original words' })!

    const loadIntoComposer = vi.fn()
    const onSubmit = vi.fn(async () => true)
    const queueEditRef: { current: QueueEditState | null } = { current: null }
    const draftRef = { current: '' }

    const hook = renderHook(
      ({ busy }: { busy: boolean }) =>
        useComposerQueue({
          activeQueueSessionKey: SESSION_KEY,
          attachments: [],
          busy,
          clearDraft: () => undefined,
          draftRef,
          focusInput: () => undefined,
          loadIntoComposer,
          onCancel: vi.fn(),
          onSteer: undefined,
          onSubmit,
          queueEditRef,
          queueSessionKey: SESSION_KEY,
          sessionId: 'rt-session-queue-hook'
        }),
      { initialProps: { busy: true } }
    )

    // Begin the in-place edit: the composer paints the entry text and records
    // the pre-edit draft snapshot.
    act(() => {
      hook.result.current.beginQueuedEdit(entry)
    })
    expect(loadIntoComposer).toHaveBeenCalledWith('original words', [])

    // The user types their replacement text for a minute. It lives in the
    // editor/draftRef — NOT in the queue entry (the edit is unsaved).
    draftRef.current = 'replacement text typed over a minute'

    // The background turn unwinds and settles: busy flips false with a dirty
    // edit buffer in the composer.
    hook.rerender({ busy: false })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // The dirty edit buffer must survive the settle: the drain held off the
    // entry under active edit (no submit of either text), the entry stays
    // queued, and the edit is not torn down.
    expect(onSubmit).not.toHaveBeenCalled()
    expect(getQueuedPrompts(SESSION_KEY).map(item => item.text)).toEqual(['original words'])
    expect(queueEditRef.current?.entryId).toBe(entry.id)
  })

  it('keeps the dirty edit buffer when the edited entry is drained out from under it (#88621)', async () => {
    // The reporter's loss: mid-edit on a queued prompt, a background or
    // cross-window drain removes the entry (the background drainer never
    // skips the id another surface is editing). The queue-edit cleanup then
    // tore the edit down and repainted the PRE-EDIT snapshot over the dirty
    // buffer, permanently destroying the typed minute. The teardown must
    // leave the composer untouched — no repaint, no focus call — and keep
    // the typed text recoverable through the salvage notice.
    const entry = enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'original words' })!

    const loadIntoComposer = vi.fn()
    const focusInput = vi.fn()
    const onSubmit = vi.fn(async () => true)
    const queueEditRef: { current: QueueEditState | null } = { current: null }
    const draftRef = { current: '' }

    const hook = renderHook(
      ({ busy }: { busy: boolean }) =>
        useComposerQueue({
          activeQueueSessionKey: SESSION_KEY,
          attachments: [],
          busy,
          clearDraft: () => undefined,
          draftRef,
          focusInput,
          loadIntoComposer,
          onCancel: vi.fn(),
          onSteer: undefined,
          onSubmit,
          queueEditRef,
          queueSessionKey: SESSION_KEY,
          sessionId: 'rt-session-queue-hook'
        }),
      { initialProps: { busy: true } }
    )

    act(() => {
      hook.result.current.beginQueuedEdit(entry)
    })
    loadIntoComposer.mockClear()
    focusInput.mockClear()

    // The user's minute of typing: unsaved, lives only in the edit buffer.
    draftRef.current = 'replacement text typed over a minute'

    // The background event: the entry is drained/removed elsewhere.
    removeQueuedPrompt(SESSION_KEY, entry.id)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // The composer is untouched: the dirty buffer is still the draft, no
    // pre-edit repaint, no focus steal.
    expect(draftRef.current).toBe('replacement text typed over a minute')
    expect(loadIntoComposer).not.toHaveBeenCalled()
    expect(focusInput).not.toHaveBeenCalled()

    // The edit exited (its entry is gone) but the typed text is recoverable:
    // it stays in the editor AND the notice names it for an explicit put-back.
    expect(queueEditRef.current).toBeNull()
    const notice = $salvagedEditNotice.get()
    expect(notice?.sessionKey).toBe(SESSION_KEY)
    expect(notice?.currentText).toBe('replacement text typed over a minute')
    expect(notice?.undoText).toBe('replacement text typed over a minute')
  })

  it('offers the cancel of a dirty queued edit for undo instead of discarding it (#88621)', () => {
    // Esc / panel-delete on a dirty edit still restores the prior draft by
    // design — but the typed replacement must be recoverable, not destroyed.
    const entry = enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'original words' })!

    const loadIntoComposer = vi.fn()
    const queueEditRef: { current: QueueEditState | null } = { current: null }
    const draftRef = { current: '' }

    const hook = renderHook(
      () =>
        useComposerQueue({
          activeQueueSessionKey: SESSION_KEY,
          attachments: [],
          busy: false,
          clearDraft: () => undefined,
          draftRef,
          focusInput: () => undefined,
          loadIntoComposer,
          onCancel: vi.fn(),
          onSteer: undefined,
          onSubmit: vi.fn(async () => true),
          queueEditRef,
          queueSessionKey: SESSION_KEY,
          sessionId: 'rt-session-queue-hook'
        })
    )

    act(() => {
      hook.result.current.beginQueuedEdit(entry)
    })
    draftRef.current = 'replacement text typed over a minute'

    act(() => {
      hook.result.current.exitQueuedEdit('cancel')
    })

    // Designed cancel semantics: the pre-edit draft is repainted…
    expect(loadIntoComposer).toHaveBeenLastCalledWith('', [])
    // …and the dirty buffer is kept recoverable behind the salvage notice.
    const notice = $salvagedEditNotice.get()
    expect(notice?.sessionKey).toBe(SESSION_KEY)
    expect(notice?.currentText).toBe('')
    expect(notice?.undoText).toBe('replacement text typed over a minute')

    // Undo while the composer still shows the repainted draft puts the typed
    // text back; after the user typed something new it only dismisses.
    expect(undoSalvagedEdit('')).toBe('replacement text typed over a minute')
    expect($salvagedEditNotice.get()).toBeNull()
  })
})

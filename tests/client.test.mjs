/**
 * dsh-redo client-half tests (node:test + jsdom).
 *
 * The bundle is a plain classic script that registers a closure factory on
 * `window.__ModuleLoader__`; these tests materialize it the same way the Web
 * client does, then drive a fake Cordis context and a fake Chat transcript.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const checkout = process.env.DSH_CHECKOUT ?? '/root/deepseek-harness'

/** Resolve jsdom from the DSH checkout without installing dependencies here. */
function loadJsdom() {
  try {
    const requireFromCheckout = createRequire(join(checkout, 'package.json'))
    return requireFromCheckout('jsdom')
  } catch {
    return undefined
  }
}

const jsdom = loadJsdom()

/**
 * Materialize the client bundle against one window.
 * @param window - DOM window (or a bare object for pure-helper tests).
 * @returns the module exports.
 */
function materialize(window) {
  let registration
  window.__ModuleLoader__ = {
    load(candidate) { registration = candidate },
  }
  const source = readFileSync(join(packageRoot, 'lib', 'client.js'), 'utf8')
  // eslint-disable-next-line no-new-func -- the bundle is a classic script by design.
  new Function('window', source)(window)
  assert.equal(registration.id, 'dsh-redo')
  return registration.factory(specifier => {
    throw new Error(`dsh-redo client bundle requested external module "${specifier}"`)
  })
}

/** Minimal wheel for the `turn-tail` boundary helper. */
function node(kind, anchorSeq, data) {
  return { kind, anchorSeq, data }
}

test('previousTurnEnd picks the nearest completed turn before the message', () => {
  const exports = materialize({})
  const { previousTurnEnd } = exports.__test
  assert.equal(previousTurnEnd([
    node('turn-tail', 10, { seq: 10 }),
    node('user', 20, { content: [] }),
    node('turn-tail', 30, { seq: 30 }),
    node('user', 40, { content: [] }),
  ], 40), 30)
  assert.equal(previousTurnEnd([
    node('turn-tail', 10, { seq: 10 }),
    node('user', 20, { content: [] }),
  ], 20), 10)
  assert.equal(previousTurnEnd([node('user', 5, { content: [] })], 5), undefined)
  assert.equal(previousTurnEnd([], 3), undefined)
  // Nodes without a valid turn/end seq are ignored rather than trusted.
  assert.equal(previousTurnEnd([node('turn-tail', 1, { seq: -1 }), node('user', 2, {})], 2), undefined)
})

test('userText joins text blocks and ignores attachments', () => {
  const exports = materialize({})
  const { userText, hasAttachments } = exports.__test
  const message = node('user', 3, {
    content: [
      { type: 'text', text: '第一段' },
      { type: 'image', attachment: {} },
      { type: 'text', text: '第二段' },
    ],
  })
  assert.equal(userText(message), '第一段第二段')
  assert.equal(hasAttachments(message), true)
  assert.equal(userText(node('user', 4, { content: [] })), '')
  assert.equal(hasAttachments(node('user', 5, { content: [] })), false)
  assert.equal(userText(undefined), '')
})

/**
 * Build the fake Cordis context the client half expects.
 * @param options - chat snapshot, running state, and call recorder.
 * @returns fake context.
 */
function fakeContext({ chat, calls, running = false }) {
  let registered
  const sessionId = 'session-1'
  const binding = {
    sessionId,
    ctx: { kind: 'agent-scope' },
    session: { getSnapshot: () => ({ running }) },
  }
  const scopes = new Map()
  const ctx = {
    locale: {
      register(_ns, dictionaries) {
        registered = dictionaries
        return () => {}
      },
      bind() {
        return key => (registered?.zh?.[key] ?? key)
      },
    },
    effect(callback) {
      return callback()
    },
    sessions: {
      list: { getSnapshot: () => ({ current: sessionId }) },
      binding: id => (id === sessionId ? binding : undefined),
      scope: (id) => {
        const scope = { id }
        scopes.set(id, scope)
        return scope
      },
      fork: async (options) => {
        calls.push(['fork', options])
        return 'session-2'
      },
      open: (id) => { calls.push(['open', id]) },
    },
    conversation: {
      input: {
        for: (scope) => {
          const id = scope.id ?? sessionId
          return {
            setDraft: (text) => { calls.push(['setDraft', id, text]) },
            notify: (level, text) => { calls.push(['notify', id, level, text]) },
            notices: {
              set: (value) => { calls.push(['setNotice', id, value]) },
            },
          }
        },
      },
    },
    uiConversation: {
      binding: () => ({
        target: () => ({ getSnapshot: () => chat }),
      }),
    },
  }
  return ctx
}

const skipNoJsdom = jsdom === undefined ? 'jsdom is not available in the DSH checkout' : false

test('clicking the injected button forks at the previous turn/end and refills the draft', { skip: skipNoJsdom }, async () => {
  const { JSDOM } = jsdom
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:3080/',
  })
  const { window } = dom
  const calls = []
  const userNode = node('user', 40, {
    content: [{ type: 'text', text: '这条发错会话了' }],
  })
  const chat = {
    nodes: {
      get: key => (key === 'input-message:u1' ? userNode : undefined),
      values: () => [node('turn-tail', 30, { seq: 30 }), userNode],
    },
  }
  const ctx = fakeContext({ chat, calls })

  window.document.body.innerHTML = `
    <div data-chat-flow-kind="user" data-chat-flow-key="input-message:u1">
      <div class="row">
        <div class="stack"><div class="bubble">这条发错会话了</div></div>
        <div class="actions"><span class="time">10:00</span><button aria-label="copy"></button></div>
      </div>
    </div>
    <div role="status">已回退到此消息；原会话保留为分支，可在侧栏找到。</div>
    <div data-composer-card><textarea></textarea></div>`

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.MutationObserver = window.MutationObserver
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)

  let dispose
  try {
    const exports = materialize(window)
    dispose = exports.apply(ctx)

    const waitForButton = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const button = window.document.querySelector('button[data-dsh-redo]')
        if (button !== null) return button
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('rewind button was not injected')
    }

    const button = await waitForButton()
    assert.equal(button.getAttribute('aria-label'), '回退到此消息')

    const close = window.document.querySelector('button[data-dsh-redo-notice-close]')
    assert.notEqual(close, null)
    assert.equal(close.getAttribute('aria-label'), '关闭提示')
    close.click()
    assert.ok(
      calls.some(call => call[0] === 'setNotice' && call[1] === 'session-1' && call[2] === null),
      'the notice close button clears the Session notice store',
    )

    button.click()

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (calls.some(call => call[0] === 'setDraft')) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    assert.deepEqual(calls.find(call => call[0] === 'fork'), ['fork', {
      sessionId: 'session-1',
      atSeq: 30,
      increaseTitle: true,
    }])
    assert.deepEqual(calls.find(call => call[0] === 'open'), ['open', 'session-2'])
    assert.deepEqual(calls.find(call => call[0] === 'setDraft'), [
      'setDraft', 'session-2', '这条发错会话了',
    ])
    assert.ok(calls.some(call => call[0] === 'notify' && call[2] === 'info'))
  } finally {
    if (typeof dispose === 'function') dispose()
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.MutationObserver = previous.MutationObserver
    globalThis.requestAnimationFrame = previous.requestAnimationFrame
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame
    window.close()
  }
})

test('a running turn refuses the rewind and reports it', { skip: skipNoJsdom }, async () => {
  const { JSDOM } = jsdom
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const { window } = dom
  const calls = []
  const userNode = node('input-message:u1', 40, { content: [{ type: 'text', text: 'x' }] })
  const chat = {
    nodes: {
      get: () => userNode,
      values: () => [node('turn-tail', 30, { seq: 30 }), userNode],
    },
  }
  const ctx = fakeContext({ chat, calls, running: true })
  window.document.body.innerHTML = `
    <div data-chat-flow-kind="user" data-chat-flow-key="input-message:u1">
      <div><div><div class="bubble">x</div></div><div class="actions"><button></button></div></div>
    </div>`

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.MutationObserver = window.MutationObserver
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)

  let dispose
  try {
    const exports = materialize(window)
    dispose = exports.apply(ctx)
    let button
    for (let attempt = 0; attempt < 100; attempt += 1) {
      button = window.document.querySelector('button[data-dsh-redo]')
      if (button !== null) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.notEqual(button, null)
    button.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(calls.some(call => call[0] === 'fork'), false)
    assert.ok(calls.some(call => call[0] === 'notify' && call[2] === 'error'))
  } finally {
    if (typeof dispose === 'function') dispose()
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.MutationObserver = previous.MutationObserver
    globalThis.requestAnimationFrame = previous.requestAnimationFrame
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame
    window.close()
  }
})

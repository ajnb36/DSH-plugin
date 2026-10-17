/**
 * dsh-redo Host-half tests: the diagnostic route reports whether the browser
 * bundle has been discovered by the client-module registry.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

/** Fake Host context capturing the registered web route. */
function fakeContext(graph) {
  let route
  const ctx = {
    effect(callback) {
      return callback()
    },
    webServer: {
      register(candidate) {
        route = candidate
        return () => {}
      },
    },
    get(service) {
      if (service !== 'clientModules') return undefined
      return { graph: () => graph }
    },
  }
  return { ctx, route: () => route }
}

/** Fake HTTP response capturing status, headers, and body. */
function fakeResponse() {
  const response = {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      response.status = status
      response.headers = headers
    },
    end(body) {
      response.body = body
    },
  }
  return response
}

test('declares the expected plugin shape', () => {
  assert.equal(name, 'redo')
  assert.deepEqual(inject, ['webServer'])
})

test('health route reports the composed client row', () => {
  const { ctx, route } = fakeContext({
    entries: [
      { id: 'dsh-client-ui-chat', url: '/plugins/??dsh-client-ui-chat/client.js&rev=1' },
      { id: 'dsh-redo', url: '/plugins/??dsh-redo/client.js&rev=2' },
    ],
  })
  apply(ctx)
  const registered = route()
  assert.equal(registered.kind, 'exact')
  assert.equal(registered.path, '/dsh-redo/health')

  const response = fakeResponse()
  registered.handler({ method: 'GET' }, response)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    plugin: 'dsh-redo',
    client: true,
    clientUrl: '/plugins/??dsh-redo/client.js&rev=2',
  })
})

test('health route stays honest before the client row is composed', () => {
  const { ctx, route } = fakeContext({ entries: [] })
  apply(ctx)
  const response = fakeResponse()
  route().handler({ method: 'GET' }, response)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    plugin: 'dsh-redo',
    client: false,
    clientUrl: null,
  })
})

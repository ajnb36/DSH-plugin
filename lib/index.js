/**
 * dsh-redo — Host half.
 *
 * The rewind itself is a browser-side composition of existing Remotes
 * (`session.fork`, `session.open`). This Host plugin exists so the package is
 * a real Loader entry, which is also what makes `@deepseek-ai/dsh-client-modules`
 * discover the `dsh.client` bundle declared in package.json.
 *
 * It additionally serves an unauthenticated, read-only diagnostic route so an
 * operator can confirm that both halves of the plugin are live:
 *
 *   GET /dsh-redo/health
 *   -> { ok: true, plugin: 'dsh-redo', client: true, clientUrl: '/plugins/...' }
 *
 * The route exposes no session data and accepts no input.
 *
 * @module dsh-redo
 */

/** Loader row name. */
export const name = 'redo'

/** The web server carrier that hosts the diagnostic route. */
export const inject = ['webServer']

/**
 * Mount the Host half.
 * @param ctx - Host context carrying `webServer` (and optionally `clientModules`).
 * @returns nothing.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-redo/health',
    handler: (_req, res) => {
      const graph = ctx.get('clientModules')?.graph?.()
      const row = graph?.entries?.find(entry => entry.id === 'dsh-redo')
      const body = JSON.stringify({
        ok: true,
        plugin: 'dsh-redo',
        client: row !== undefined,
        clientUrl: row?.url ?? null,
      })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(body)),
      })
      res.end(body)
    },
  }), 'dsh-redo: health route')
}

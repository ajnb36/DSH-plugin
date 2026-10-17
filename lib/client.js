/**
 * dsh-redo — browser half (hand-written `window.__ModuleLoader__` closure
 * factory, matching the artifact shape the DSH Web client loads).
 *
 * What it does
 * ------------
 * Every durable user message in the Chat transcript already renders a copy
 * button. This plugin appends a sibling "rewind" button to that same action
 * row. Clicking it:
 *
 *   1. resolves the clicked transcript node and the completed turn that
 *      precedes it (append-only Session logs cannot be truncated in place);
 *   2. forks the Session at that preceding `turn/end`, which produces a new
 *      branch whose transcript is exactly the prefix before the wrong message;
 *   3. fills the new branch's composer with the wrong message's text so the
 *      human can edit or delete it;
 *   4. opens the branch.
 *
 * The polluted source Session is left intact (DSH keeps session logs
 * append-only and exposes no delete), so the original stays available in the
 * sidebar.
 *
 * @module dsh-redo/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-redo',
  factory: (_require) => {
    const module = { exports: {} }
    const exports = module.exports

    /** Client services this plugin waits for. */
    const inject = ['sessions', 'conversation', 'uiConversation', 'locale']

    /** Locale namespace owned by the plugin. */
    const NS = 'redo'
    /** Marker attribute on the injected button. */
    const BUTTON_ATTR = 'data-dsh-redo'
    /** Id of the plugin-owned stylesheet. */
    const STYLE_ID = 'dsh-redo-style'

    const zh = {
      'action.rewind': '回退到此消息',
      'action.rewinding': '正在回退…',
      'error.noSession': '当前没有可回退的会话',
      'error.noBinding': '会话尚未就绪，请稍后重试',
      'error.notUser': '只能回退你自己发送的消息',
      'error.first': '这已经是会话的第一条消息，无法再回退',
      'error.running': '回复进行中，请先停止或等本轮结束后再回退',
      'error.fork': '回退失败：',
      'info.rewound': '已回退到此消息；原会话保留为分支，可在侧栏找到。',
      'info.attachments': ' 附件没有自动回填，需要重新添加。',
    }

    const en = {
      'action.rewind': 'Rewind to this message',
      'action.rewinding': 'Rewinding…',
      'error.noSession': 'No session is open',
      'error.noBinding': 'The session is not ready yet; try again',
      'error.notUser': 'Only your own messages can be rewound',
      'error.first': 'This is the first message in the conversation',
      'error.running': 'Stop the running reply (or wait for it) before rewinding',
      'error.fork': 'Rewind failed: ',
      'info.rewound': 'Rewound here. The original conversation remains as a branch in the sidebar.',
      'info.attachments': ' Attachments were not refilled; add them again.',
    }

    /** Button chrome copied from `MessageIconActions.module.css`. */
    const CSS = [
      '.dsh-redo-action{display:inline-flex;align-items:center;justify-content:center;',
      'width:calc(28px + var(--dsh-content-font-delta, 0px));',
      'height:calc(28px + var(--dsh-content-font-delta, 0px));padding:6px;border:none;',
      'border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary);',
      'cursor:pointer;flex:none}',
      '.dsh-redo-action svg{width:calc(15px + var(--dsh-content-font-delta, 0px));',
      'height:calc(15px + var(--dsh-content-font-delta, 0px))}',
      '.dsh-redo-action:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-secondary)}',
      '.dsh-redo-action:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill);',
      'outline-offset:2px}',
      '.dsh-redo-action[data-busy]{opacity:.5;cursor:default}',
    ].join('')

    /** Undo-style glyph (15px), inherits the action-row color. */
    const ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" '
      + 'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M5.8 3.6 2.4 7l3.4 3.4"/><path d="M2.4 7h6.9a3.7 3.7 0 0 1 0 7.4H6.4"/></svg>'

    /**
     * Select the `turn/end` seq of the completed turn immediately before one
     * transcript anchor. The Chat target renders one `turn-tail` node per
     * completed turn and stores the exact `turn/end` seq on it, so the fork
     * boundary is deterministic instead of guessed from event adjacency.
     * @param nodes - every materialized Chat node.
     * @param anchorSeq - anchor of the message being rewound.
     * @returns the preceding `turn/end` seq, or undefined for the first turn.
     */
    function previousTurnEnd(nodes, anchorSeq) {
      let bestAnchor = -Infinity
      let bestSeq
      for (const node of nodes) {
        if (node === null || node === undefined || node.kind !== 'turn-tail') continue
        if (typeof node.anchorSeq !== 'number' || node.anchorSeq >= anchorSeq) continue
        const seq = node.data === null || node.data === undefined ? undefined : node.data.seq
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) continue
        if (node.anchorSeq > bestAnchor) {
          bestAnchor = node.anchorSeq
          bestSeq = seq
        }
      }
      return bestSeq
    }

    /**
     * Join the text blocks of one durable user message exactly like the Chat
     * bubble projection does.
     * @param node - durable user Chat node.
     * @returns the concatenated text (empty for attachment-only messages).
     */
    function userText(node) {
      const blocks = node === null || node === undefined || node.data === undefined
        ? undefined
        : node.data.content
      if (!Array.isArray(blocks)) return ''
      let text = ''
      for (const block of blocks) {
        if (block !== null && typeof block === 'object'
          && block.type === 'text' && typeof block.text === 'string') {
          text += block.text
        }
      }
      return text
    }

    /**
     * Whether a user message carries image/file content that the text-only
     * draft refill cannot restore.
     * @param node - durable user Chat node.
     * @returns true when at least one attachment block exists.
     */
    function hasAttachments(node) {
      const blocks = node === null || node === undefined || node.data === undefined
        ? undefined
        : node.data.content
      if (!Array.isArray(blocks)) return false
      return blocks.some(block => block !== null && typeof block === 'object'
        && (block.type === 'image' || block.type === 'file'))
    }

    /**
     * Register the plugin dictionaries and bind a translator.
     * @param ctx - client root context.
     * @returns the translator used by every button and notice.
     */
    function configureLocale(ctx) {
      const fallback = key => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key)
      if (ctx.locale === undefined) return fallback
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-redo: dictionaries')
      return ctx.locale.bind(NS)
    }

    /** Inject the plugin stylesheet once. */
    function ensureStyle(doc) {
      if (doc.getElementById(STYLE_ID) !== null) return
      const style = doc.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', 'dsh-redo')
      style.textContent = CSS
      doc.head.append(style)
    }

    /**
     * Resolve the copy/clock action row of a user message wrapper. The wrapper
     * is the stable Chat Node Seat (`data-chat-flow-kind`); the row is the
     * direct parent of its last `<button>` (the built-in copy control), which
     * keeps the lookup working even if a provider wraps the bubble in extra
     * elements.
     * @param wrapper - `[data-chat-flow-kind="user"]` element.
     * @returns the action row, or undefined outside the expected structure.
     */
    function actionRowOf(wrapper) {
      const buttons = wrapper.querySelectorAll('button')
      if (buttons.length === 0) return undefined
      return buttons[buttons.length - 1].parentElement ?? undefined
    }

    /** Mount the rewind button into one transcript row. */
    function ensureButton(t, doc, wrapper, rewind) {
      const actions = actionRowOf(wrapper)
      if (actions === undefined) return
      let button = actions.querySelector(`button[${BUTTON_ATTR}]`)
      if (button === null) {
        button = doc.createElement('button')
        button.type = 'button'
        button.className = 'dsh-redo-action'
        button.setAttribute(BUTTON_ATTR, '')
        button.innerHTML = ICON_SVG
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (button.disabled) return
          void rewind(wrapper, button)
        })
        actions.append(button)
      }
      const label = button.getAttribute('data-busy') === null ? t('action.rewind') : t('action.rewinding')
      button.title = label
      button.setAttribute('aria-label', label)
    }

    /**
     * Mount the browser half.
     * @param ctx - client root context carrying the injected services.
     */
    function apply(ctx) {
      const doc = globalThis.document
      if (doc === undefined || doc.body === null) return

      const t = configureLocale(ctx)
      ensureStyle(doc)

      let busy = false
      let scheduled = false
      let frame

      /** Surface a composer notice for one session scope (best effort). */
      const notify = (scopeCtx, level, text) => {
        try {
          ctx.conversation.input.for(scopeCtx).notify(level, text)
        } catch {
          // The scoped composer may already be torn down (session switch).
        }
      }

      /**
       * Rewind one transcript row.
       * @param wrapper - the clicked Chat Node Seat wrapper.
       * @param button - the injected button, disabled while the fork runs.
       */
      const rewind = async (wrapper, button) => {
        if (busy) return
        busy = true
        button.disabled = true
        button.setAttribute('data-busy', '')
        const label = t('action.rewinding')
        button.title = label
        button.setAttribute('aria-label', label)

        let binding
        try {
          const sessionId = ctx.sessions.list.getSnapshot().current
          if (sessionId === undefined) return
          binding = ctx.sessions.binding(sessionId)
          if (binding === undefined) return
          const key = wrapper.getAttribute('data-chat-flow-key')
          if (key === null) return
          const chat = ctx.uiConversation.binding(binding).target('chat').getSnapshot()
          const node = chat === null || chat === undefined ? undefined : chat.nodes.get(key)
          if (node === undefined) return
          if (node.kind !== 'user') {
            notify(binding.ctx, 'error', t('error.notUser'))
            return
          }
          const cut = previousTurnEnd(chat.nodes.values(), node.anchorSeq)
          if (cut === undefined) {
            notify(binding.ctx, 'error', t('error.first'))
            return
          }
          if (binding.session.getSnapshot().running) {
            notify(binding.ctx, 'error', t('error.running'))
            return
          }

          const text = userText(node)
          const attachments = hasAttachments(node)
          const childId = await ctx.sessions.fork({
            sessionId: binding.sessionId,
            atSeq: cut,
            increaseTitle: true,
          })
          let childScope
          try {
            childScope = ctx.sessions.scope(childId)
          } catch {
            childScope = undefined
          }
          if (childScope !== undefined) {
            try {
              ctx.conversation.input.for(childScope).setDraft(text)
            } catch {
              // The draft refill is best effort; the branch itself is the rewind.
            }
          }
          ctx.sessions.open(childId)
          if (childScope !== undefined) {
            notify(childScope, 'info', t('info.rewound') + (attachments ? t('info.attachments') : ''))
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          if (binding !== undefined) notify(binding.ctx, 'error', t('error.fork') + detail)
        } finally {
          busy = false
          button.disabled = false
          button.removeAttribute('data-busy')
          const labelNow = t('action.rewind')
          button.title = labelNow
          button.setAttribute('aria-label', labelNow)
        }
      }

      /** Add any missing buttons and refresh their localized labels. */
      const scan = () => {
        scheduled = false
        if (!doc.body.isConnected) return
        ensureStyle(doc)
        for (const wrapper of doc.querySelectorAll('[data-chat-flow-kind="user"]')) {
          ensureButton(t, doc, wrapper, rewind)
        }
      }

      /** Coalesce DOM mutations into one animation-frame scan. */
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        if (typeof globalThis.requestAnimationFrame === 'function') {
          frame = globalThis.requestAnimationFrame(scan)
        } else {
          frame = globalThis.setTimeout(scan, 16)
        }
      }

      ctx.effect(() => {
        const observer = new globalThis.MutationObserver(schedule)
        observer.observe(doc.body, { childList: true, subtree: true })
        schedule()
        return () => {
          observer.disconnect()
          if (frame !== undefined) {
            if (typeof globalThis.cancelAnimationFrame === 'function') {
              globalThis.cancelAnimationFrame(frame)
            } else {
              globalThis.clearTimeout(frame)
            }
            frame = undefined
          }
          for (const button of doc.querySelectorAll(`button[${BUTTON_ATTR}]`)) button.remove()
          doc.getElementById(STYLE_ID)?.remove()
        }
      }, 'dsh-redo: rewind buttons')
    }

    exports.apply = apply
    exports.inject = inject
    // Pure helpers exposed for the package's Node tests; harmless at runtime.
    exports.__test = { previousTurnEnd, userText, hasAttachments, actionRowOf }
    return module.exports
  },
})

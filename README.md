# dsh-redo — 会话「回退」插件

给 DSH Web 会话里**自己发送的每一条消息**加一个「回退」按钮（就在复制按钮旁边）。点击后：

1. 回退到这条消息**之前**的对话内容；
2. 把这消息的文字**回填到输入框**，你可以改完再发，或者直接删掉；
3. 原来的（被污染的）会话仍保留在侧栏，作为一个分支，不会丢数据。

这解决“发串会话后无法撤回、会话被污染”的问题。

## 为什么是“分支”而不是原地删除

DSH 的会话日志是 append-only 的：已提交的事件不会被重写，也没有“删除会话事件”的 API。因此插件用 DSH 自带的 fork 能力实现回退：

- 在出错消息**前一个已完成轮次**的 `turn/end` 处 fork；
- 新分支的聊天记录正好是“发错之前”的前缀；
- 自动切到新分支，并把发错的内容填进输入框。

从你的视角看，会话就是回到了发错之前；原来的污染会话还在侧栏（可手动归档）。

## 安装

### 方式一：作为 bundle 安装（推荐，重启后仍然生效）

```sh
dsh plugin --profile web add link:/root/DSH/dsh-plugin
```

然后重启 `dsh web`（或重新打开你的 DSH Web）。

### 方式二：只改 profile patch（无需 pnpm，当前进程内热加载）

在 `~/.dsh/profiles/web/cordis.patch.yml` 里追加：

```yaml
- insert:
    - id: redo
      name: /root/DSH/dsh-plugin/lib/index.js
```

`patchReload: live` 的 profile 会热加载这个 patch；刷新浏览器页面即可看到按钮。注意这种方式和方式一不要同时用，否则会重复挂载。

安装后可以访问 `http://127.0.0.1:3080/dsh-redo/health` 自检：

```json
{ "ok": true, "plugin": "dsh-redo", "client": true, "clientUrl": "/plugins/…" }
```

`client: true` 表示浏览器端 bundle 也已经被 Host 发现。

## 使用

1. 刷新 Web 页面；
2. 把鼠标移到你发送的消息上，操作行里除了「复制」还会出现「回退」；
3. 点击「回退」，会话切换到干净的、出错之前的分支，输入框里自动带上出错的那段文字。

按钮的可用条件：

- 消息是你发送的普通消息（不是注入的上下文/steering）；
- 后面至少有一个已完成的轮次可供 fork；
- 当前没有正在生成的回复（先停止或等本轮结束）。

不满足时会在输入框上方给出提示。

## 限制

- **附件不会自动回填**：文字会回填，图片/文件需要重新添加（提示里会说明）。
- 回退粒度是“轮次”：如果点击的是当前轮里后来插入的 steering 消息，不支持；普通用户消息都行。
- 原会话保留为分支，不会自动删除或归档（DSH 没有删除会话的接口）。
- 只处理已经加载进当前窗口的对话；如果点击的是很久以前、尚未加载的历史消息，可能找不到前一个轮次边界（会提示无法回退）。

## 开发

插件是**零构建**的：`lib/index.js` 是 Host 半（纯 ESM），`lib/client.js` 是手写的 DSH client bundle（`window.__ModuleLoader__.load` 闭包工厂格式），改完刷新页面即可（若 Host 侧文件变化，live patch profile 会重载）。

```sh
cd /root/DSH/dsh-plugin
npm test          # node:test + jsdom
node --check lib/index.js
node --check lib/client.js
```

`tests/client.test.mjs` 覆盖：

- 从 Chat 节点里选出正确的 `turn/end` 边界；
- 用户消息文本拼接；
- 在模拟 DOM 中注入按钮、点击后调用 `sessions.fork` / `open` / `input.setDraft` 的完整链路。

## 结构

```
dsh-plugin/
├── package.json        # dsh.bundle.patch + dsh.client
├── cordis.patch.yml    # 插入 redo 这行 Loader entry
├── lib/
│   ├── index.js        # Host 半：health 路由（让 Loader 有可挂载的 Node 模块）
│   └── client.js       # 浏览器半：按钮注入 + fork/回填
└── tests/
```

import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * issue #30 的一键发图面板三项改造(第 4 项「用户侧显示」在 client-decorate.test.mjs):
 *
 * ① 图库 / 情绪改成两排多选 chip:都不选 = 不筛;结果 = 文字搜索 ∩ 所选图库 ∩ 所选情绪;
 *    情绪选项只在当前图库范围内派生、按数量降序带计数,右侧实时显示共 N 张。
 * ② 缩略图悬浮预览:1.5 倍大图 + 情绪 + 描述,右侧放不下翻左边,垂直按实测高度钳制,
 *    「指针离开 当前格子 ∪ 预览框」才关。
 * ③ 面板高度自适应:底边贴输入框(原来的 absolute 锚点不动),上缘不越窗口顶,网格内部滚。
 *
 * 筛选/计数/定位全是纯函数(exports.__test),这里先把它们钉死,再用极简 React 跑一遍真实
 * 渲染,断言 chip 上的计数、搜索后的张数、清空按钮。
 */

let stateCells = []
let passIndex = 0
let pendingEffects = []

const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat(Infinity) }),
  useState(initial) {
    const i = passIndex++
    if (!(i in stateCells)) stateCells[i] = typeof initial === 'function' ? initial() : initial
    return [stateCells[i], (v) => { stateCells[i] = typeof v === 'function' ? v(stateCells[i]) : v }]
  },
  useEffect(fn) { pendingEffects.push(fn) },
  useRef(v) { return { current: v } },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  useSyncExternalStore(_subscribe, get) { return get() },
}

const makeEl = () => ({
  textContent: '', style: {}, dataset: {}, attrs: {},
  appendChild() {}, remove() {}, setAttribute() {}, replaceWith() {}, click() {},
  insertBefore() {}, closest: () => null, addEventListener() {}, removeEventListener() {},
})
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {}, querySelector: () => null },
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  createDocumentFragment: () => makeEl(),
  createTextNode: () => makeEl(),
  createTreeWalker: () => ({ nextNode: () => null }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}
globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.window = {
  location: { origin: 'http://localhost', href: '' },
  open: () => null,
  __ModuleLoader__: {
    load(def) {
      globalThis.__dshMeme = def.factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
    },
  },
}

// ---- 两个图库 5 张图:url 带包前缀(和真实 /dsh-memes-api?packId=all 的响应一致) ----
const row = (pack, tag, caption, file, keywords) => ({
  path: 'memes/' + tag + '/' + file, tag, file_name: file, caption,
  keywords: keywords || '', url: '/dsh-memes/' + pack + '/memes/' + tag + '/' + file,
})
const rows = [
  row('p1', 'happy', '开心猫', 'a.jpg', '猫 比心'),
  row('p1', 'sad', '难过狗', 'b.jpg', ''),
  row('p1', 'happy', '开心鱼', 'c.jpg', ''),
  row('p2', 'happy', 'GPT吉祥物', 'd.jpg', ''),
  row('p2', 'daily', '摸鱼', 'e.jpg', ''),
]
const packs = [{ id: 'p1', name: '包一', count: 3 }, { id: 'p2', name: '包二', count: 2 }]

const fetched = []
globalThis.fetch = async (url) => {
  fetched.push(String(url))
  const reply = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) })
  if (String(url).includes('/dsh-memes-api')) return reply({ ok: true, packId: 'p1', packs, memes: rows, tags: [] })
  return reply({ ok: false, error: 'unexpected ' + url })
}

await import('../client.js')

const {
  packOfUrl, pickerTagCounts, pickerFilter, fitPanelHeight, previewPosition, inKeepZone, uniqueKeys,
} = globalThis.__dshMeme.__test

// ---------- ① 多选筛选:范围 / 计数 / 交集 ----------

test('packOfUrl 从图片 url 反推出图库 id', () => {
  assert.equal(packOfUrl('/dsh-memes/p1/memes/happy/a.jpg'), 'p1')
  assert.equal(packOfUrl('http://127.0.0.1:3999/dsh-memes/dafeiyu-001/memes/daily/x.png'), 'dafeiyu-001')
  assert.equal(packOfUrl(''), '')
  assert.equal(packOfUrl('/other/path/a.jpg'), '')
})

test('情绪计数只在所选图库范围内派生,按数量降序', () => {
  assert.deepEqual(pickerTagCounts(rows, []).map((t) => t.tag + ':' + t.count), ['happy:3', 'daily:1', 'sad:1'])
  // 同数量按 tag 名稳定排序(daily < sad)
  assert.deepEqual(pickerTagCounts(rows, ['p1']).map((t) => t.tag + ':' + t.count), ['happy:2', 'sad:1'])
  assert.deepEqual(pickerTagCounts(rows, ['p2']).map((t) => t.tag + ':' + t.count), ['daily:1', 'happy:1'])
})

test('结果 = 文字搜索 ∩ 所选图库 ∩ 所选情绪;两者都不选 = 不筛', () => {
  assert.equal(pickerFilter(rows, [], [], '').length, 5, '都不选 = 全部')
  assert.equal(pickerFilter(rows, ['p2'], [], '').length, 2, '只看所选图库')
  assert.equal(pickerFilter(rows, [], ['happy'], '').length, 3, '只看所选情绪')
  assert.equal(pickerFilter(rows, ['p1', 'p2'], ['happy'], '').length, 3, '多选图库取并集')
  assert.equal(pickerFilter(rows, ['p1'], ['happy'], '').length, 2, '图库 ∩ 情绪')
  assert.equal(pickerFilter(rows, ['p2'], ['happy'], '猫').length, 0, '三层都命中才算:「猫」只在 p1 里')
})

test('文字搜索:空格分词全命中,描述/关键词/图名都算', () => {
  assert.equal(pickerFilter(rows, [], [], '开心').length, 3, '打了「开心」= happy 桶(标签的中文显示也参与),其中两条是描述里就有')
  assert.equal(pickerFilter(rows, [], [], '开心 猫').length, 1, '多个词要全命中')
  assert.equal(pickerFilter(rows, [], [], '比心').length, 1, '关键词也参与')
  assert.equal(pickerFilter(rows, [], [], 'b.jpg').length, 1, '文件名也参与')
  assert.equal(pickerFilter(rows, [], [], '开心 不存在的词').length, 0)
})

test('格子 key:url 撞车(两个图库收同一张图)也要唯一,否则 React 协调会错乱', () => {
  // 实测现象:筛到 2 张后网格里还剩两百多个旧格子 —— key 撞车时 React 删不干净
  const dupes = [rows[0], rows[0], rows[3], rows[0]]
  const keys = uniqueKeys(dupes)
  assert.equal(new Set(keys).size, keys.length, 'key 必须唯一')
  assert.deepEqual(keys, [rows[0].url + '#1', rows[0].url + '#2', rows[3].url + '#1', rows[0].url + '#3'])
})

// ---------- ③ 面板高度自适应 ----------

test('面板高度:自然高度与可用空间取小,兜一个最小高度', () => {
  assert.equal(fitPanelHeight(1000, 400), 400, '放不下就顶到可用高度,内容在网格里滚')
  assert.equal(fitPanelHeight(300, 1000), 300, '放得下就用自然高度,不空撑')
  assert.equal(fitPanelHeight(40, 1000), 180, '太矮时兜最小高度')
  assert.equal(fitPanelHeight(0, 0), 180, '量不到就退回最小高度(JS 增强失败也不能塌)')
  assert.equal(fitPanelHeight(1000, 400, 220), 400, '最小高度可覆盖')
})

// ---------- ② 悬浮预览定位 / 关闭时机 ----------

test('悬浮预览:默认浮在格子右侧;右侧放不下翻到左侧', () => {
  const cell = { left: 100, top: 100, right: 176, bottom: 176 }
  const size = { width: 176, height: 184 }
  assert.deepEqual(previewPosition(cell, size, { width: 900, height: 800 }), { left: 186, top: 98 })
  // 右边只剩一点:翻到左侧(100 - 10 - 176 = -86 → 再钳到 8)
  assert.deepEqual(previewPosition({ ...cell, left: 40, right: 116 }, size, { width: 300, height: 800 }), { left: 8, top: 98 })
})

test('悬浮预览:垂直按实测高度钳制,最下面一排不被裁掉', () => {
  const size = { width: 176, height: 184 }
  // 面板里最后一排:格子底边贴窗口底,预览要往上收(800 - 184 - 8 = 608)
  assert.equal(previewPosition({ left: 10, top: 700, right: 86, bottom: 776 }, size, { width: 900, height: 800 }).top, 608)
  // 窗口特别矮也不能跑到负坐标
  assert.equal(previewPosition({ left: 10, top: 700, right: 86, bottom: 776 }, size, { width: 900, height: 200 }).top, 8)
})

test('停留区 = 当前格子 ∪ 预览框,带 4px 容差', () => {
  const cell = { left: 100, top: 100, right: 176, bottom: 176 }
  const preview = { left: 8, top: 300, right: 184, bottom: 484 }
  assert.equal(inKeepZone([cell, preview], 140, 140), true, '格子内')
  assert.equal(inKeepZone([cell, preview], 90, 400), true, '预览框内(从格子挪到大图不能闪掉)')
  assert.equal(inKeepZone([cell, preview], 180, 180), true, '贴边 4px 内算还在(避免抖动)')
  assert.equal(inKeepZone([cell, preview], 200, 180), false, '离开格子 ∪ 预览框就关')
  assert.equal(inKeepZone([cell, preview], 140, 250), false, '面板下半的空白区不算停留')
  assert.equal(inKeepZone([], 140, 140), false)
  assert.equal(inKeepZone([{ left: 0, top: 0, right: 0, bottom: 0 }], 0, 0), false, '退化矩形直接跳过')
})

// ---------- 渲染:chip 计数 / 共 N 张 / 清空 / 发图回归 ----------

const walk = (node, fn) => {
  if (node == null || typeof node === 'boolean') return
  if (Array.isArray(node)) { for (const n of node) walk(n, fn); return }
  if (typeof node !== 'object') return
  fn(node)
  for (const kid of node.kids || []) walk(kid, fn)
}
const textOf = (node) => {
  let out = ''
  walk(node, (n) => { for (const kid of n.kids || []) if (typeof kid === 'string' || typeof kid === 'number') out += kid + ' ' })
  return out.replace(/\s+/g, ' ').trim()
}
const run = (el) => (typeof el.type === 'function' ? el.type(el.props) : el)
const flush = async () => {
  for (const fn of pendingEffects.slice()) fn()
  pendingEffects = []
  await new Promise((ok) => setTimeout(ok, 0))
  await new Promise((ok) => setTimeout(ok, 0))
}
const byClass = (tree, cls) => {
  const out = []
  walk(tree, (n) => {
    const c = n.props && n.props.className
    if (typeof c === 'string' && c.split(/\s+/).includes(cls)) out.push(n)
  })
  return out
}
const chipWith = (tree, label) => byClass(tree, 'mp-tag').find((n) => textOf(n).includes(label))

/** 装一遍插件并打开面板,返回当前这棵树 + 重绘函数 + setDraft 记录 */
const openBoard = async () => {
  stateCells = []
  passIndex = 0
  pendingEffects = []
  const calls = []
  const inputActions = {
    setDraft: (text) => calls.push({ kind: 'setDraft', text }),
    submit: () => calls.push({ kind: 'submit' }),
  }
  const slots = {
    registered: [],
    inject(_name, fn) { fn() },
    register(meta, render) { this.registered.push({ meta, render }) },
  }
  globalThis.__dshMeme.apply({ get: (name) => (name === 'slots' ? slots : undefined), effect: () => {} })
  const find = (name) => slots.registered.find((r) => r.meta.name === name && r.meta.id === 'meme-picker')
  const props = { inputActions, useInput: (s) => s({ draft: '先说两句' }) }

  const trigger = find('conversation.input.left')
  passIndex = 0
  const buttonTree = run(trigger.render(props))
  let button = null
  walk(buttonTree, (n) => { if (!button && n.props && typeof n.props.onClick === 'function') button = n })
  button.props.onClick({ preventDefault() {}, stopPropagation() {} })

  const overlay = find('conversation.input.overlay')
  passIndex = 0
  run(overlay.render(props))
  await flush()
  const repaint = () => { passIndex = 0; return run(overlay.render(props)) }
  return { board: repaint(), repaint, calls }
}

test('打开面板拉的是全量(packId=all),默认不筛就是跨图库全部', async () => {
  fetched.length = 0
  const { board } = await openBoard()
  assert.ok(fetched.some((u) => u.includes('packId=all')), '多选筛选/情绪计数要全量数据:' + fetched.join(' '))
  assert.equal(byClass(board, 'mp-cell').length, 5, '两个图库的图都要出来')
  assert.equal(textOf(byClass(board, 'mp-count')[0]), '共 5 张')
  assert.ok(chipWith(board, '包一'), '图库 chip 应带名字')
  assert.ok(chipWith(board, '包二'))
})

test('图库 chip 多选:点一下只看它,再点取消;情绪 chip 跟着重新派生', async () => {
  const { board, repaint } = await openBoard()
  assert.equal(textOf(chipWith(board, '包一')), '包一 3', 'chip 上要带张数')
  chipWith(board, '包二').props.onClick()
  const filtered = repaint()
  assert.equal(textOf(byClass(filtered, 'mp-count')[0]), '共 2 张')
  assert.equal(byClass(filtered, 'mp-cell').length, 2)
  assert.ok(chipWith(filtered, '开心'), '包二里的 happy 要用中文标签显示')
  assert.equal(chipWith(filtered, '难过'), undefined, '包里没有的情绪不该列出来')
  // 再点一次取消 → 回到全部
  chipWith(filtered, '包二').props.onClick()
  assert.equal(textOf(byClass(repaint(), 'mp-count')[0]), '共 5 张')
})

test('情绪 chip 多选 + 搜索框:两层取交集,清空一键复位', async () => {
  const { board, repaint } = await openBoard()
  chipWith(board, '难过').props.onClick()
  let tree = repaint()
  assert.equal(textOf(byClass(tree, 'mp-count')[0]), '共 1 张')
  // 搜一个跟「难过」不沾边的词 → 交集为空
  byClass(tree, 'mp-search')[0].props.onChange({ target: { value: '开心' } })
  tree = repaint()
  assert.equal(textOf(byClass(tree, 'mp-count')[0]), '共 0 张')
  assert.ok(textOf(tree).includes('没有匹配的表情包'))
  // 清空:搜索 + 两排 chip 一起复位
  const clear = byClass(tree, 'mp-clear')[0]
  assert.ok(clear, '有筛选条件时才有清空按钮')
  clear.props.onClick()
  tree = repaint()
  assert.equal(textOf(byClass(tree, 'mp-count')[0]), '共 5 张')
  assert.equal(byClass(tree, 'mp-clear').length, 0, '没有筛选条件就不显示清空')
})

test('点图格照旧把草稿带上一并发送(跨图库也不变)', async () => {
  const { board, calls } = await openBoard()
  byClass(board, 'mp-cell')[0].props.onClick()
  await new Promise((ok) => setTimeout(ok, 0))
  const drafted = calls.filter((c) => c.kind === 'setDraft')
  assert.equal(drafted.length, 1)
  assert.equal(drafted[0].text, '先说两句\n[表情: 开心猫]')
  assert.ok(calls.some((c) => c.kind === 'submit'))
})

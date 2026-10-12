import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * 玻璃背板:选图面板(.meme-picker)与它的悬浮预览(.mp-hover)叠一层 backdrop-filter,
 * 底色改用宿主输入框令牌 --dsw-specific-input-major —— 主题把输入框做成半透明玻璃时,
 * 面板跟着透出背后的聊天内容;那个令牌是实色时这条规则等于没写(观感与原来一致)。
 *
 * 这里盯三件事:
 * ① 模糊真的写进去了,标准属性和 -webkit- 前缀各一份(Electron 上两个都认);
 * ② 底色必须带 fallback —— 少了它,不认识输入框令牌的环境下整条 background-color
 *    声明作废,面板底色掉回透明,比不加这条规则还糟;
 * ③ 不许出现 body[data-we-glass-page] 这类对外部插件的硬依赖。
 */

const appended = []
const makeEl = () => ({
  textContent: '', style: {}, dataset: {}, attrs: {},
  appendChild() {}, remove() {}, replaceWith() {}, click() {}, insertBefore() {},
  closest: () => null, addEventListener() {}, removeEventListener() {},
  setAttribute(k, v) { this.attrs[k] = String(v) },
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
})

globalThis.document = {
  head: { appendChild: (el) => appended.push(el) },
  body: {},
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
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
  __ModuleLoader__: {
    load(def) {
      globalThis.__dshMeme = def.factory((name) => {
        if (name === 'react') return { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), useSyncExternalStore: (_s, get) => get() }
        throw new Error('unexpected require: ' + name)
      })
    },
  },
}

await import('../client.js')
globalThis.__dshMeme.apply({ get: () => undefined, effect: () => {} })

// 第二个建的标签是选图器样式(第一个是设置面板样式)
const pickerCSS = appended[1].textContent
const glassRules = pickerCSS.match(/\.meme-picker[^{}]*\{[^}]*backdrop-filter[^}]*\}/g) || []
const glass = glassRules[glassRules.length - 1] || ''

test('选图面板带了 backdrop-filter(标准属性 + -webkit- 前缀)', () => {
  assert.ok(glassRules.length >= 1, '应该有一条给面板加模糊的规则')
  assert.ok(glass.includes('-webkit-backdrop-filter:blur('), 'Electron 上还要 -webkit- 那份')
  assert.ok(glass.includes('backdrop-filter:blur('), '标准属性那份缺了')
})

test('同一条规则也管住悬浮预览(不然它还是个实心块)', () => {
  assert.ok(glass.includes('.meme-picker,'), '选择器要包含 .meme-picker 本身')
  assert.ok(glass.includes('.meme-picker .mp-hover'), '悬浮预览 .mp-hover 也要一起')
})

test('底色用输入框令牌,并且带 fallback', () => {
  assert.ok(
    glass.includes('color-mix(in srgb,var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1))'),
    '必须写成 color-mix(in srgb,var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1)) …):少了 fallback,不认识这个令牌的主题下面板底色会掉成透明',
  )
})

test('透明度留了可覆盖的口子,默认值行为不变', () => {
  assert.ok(
    glass.includes('var(--meme-glass-alpha,100%)'),
    '透明度必须写成 var(--meme-glass-alpha,100%):默认 100% 等价于直接用底色(与不写这条规则一致),使用者想调透自己设这个变量即可',
  )
})

test('--we-* 每个都带 fallback,不对壁纸引擎形成硬依赖', () => {
  for (const v of ['--we-blur', '--we-saturate', '--we-glass-brightness']) {
    assert.ok(glass.includes('var(' + v + ','), v + ' 缺 fallback,没装壁纸引擎时整条声明会作废')
  }
})

test('玻璃规则不挂在外部插件的页面标记上', () => {
  assert.ok(!pickerCSS.includes('data-we-glass-page'), '不该要求 body[data-we-glass-page] —— 那是壁纸引擎的标记,等于硬依赖')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 插件在 dsh「插件」页里的展示元信息(title / description / icon)是宿主按约定读的,
 * 不是 README —— 本机核对 @deepseek-ai/dsh-app-boot 的 readPluginMeta():
 *
 *   ① 先解析 `<包>/locale/en.json`,拿它所在目录扫同目录下所有 `*.json`(文件名即语言 id),
 *      每个文件取 `{"meta":{"title","description"}}` 组成语言表;
 *      **en.json 是锚点:它不存在就一个词典都不读**,直接走 ②;
 *   ② 没有词典时回退 package.json 的 name(标题)/ description(描述);
 *   ③ package.json.icon:相对包目录的图片路径(SVG/PNG/JPEG/WebP,≤256KiB),转成 data URL;
 *   ④ 客户端 dsh-client-ui-plugin-manager 用 ctx.locale.resolveText() 按当前界面语言取值,
 *      取不到回退 en。
 *
 * 两个坑都在这里钉住:locale 子路径必须写进 package.json 的 exports(Node 的 exports 会挡
 * 掉没放行的子路径,宿主就解析不到词典 —— 实测踩过一次:标题退回包名 dsh-meme);locale/
 * 和图标都必须进 files,否则不会随包发布。
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('locale/en.json 是锚点,且 locale 子路径在 exports 里放行', () => {
  assert.ok(existsSync(join(root, 'locale', 'en.json')), '缺 en.json 宿主一个词典都不会读,标题会退回包名')
  assert.match(String(pkg.exports['./locale/*.json'] || ''), /^\.\/locale\/\*\.json$/, 'exports 必须放行 ./locale/*.json')
  assert.ok((pkg.files || []).includes('locale/'), 'locale/ 要进 files,否则不随包发布')
})

test('中英词典都有 meta.title / meta.description', () => {
  for (const [file, lang] of [['en.json', 'en'], ['zh.json', 'zh']]) {
    const path = join(root, 'locale', file)
    assert.ok(existsSync(path), '缺 ' + file)
    const dict = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(typeof dict.meta?.title, 'string', file + ' 要 meta.title')
    assert.equal(typeof dict.meta?.description, 'string', file + ' 要 meta.description')
    assert.ok(dict.meta.title.trim() !== '' && dict.meta.description.trim() !== '', file + ' 的字段不能是空串')
    assert.ok(lang.length >= 2, '文件名即语言 id(宿主按 LANGUAGE_ID 校验,如 en / zh)')
  }
})

test('icon 是包内相对路径、格式与大小都合法', () => {
  const icon = pkg.icon
  assert.equal(typeof icon, 'string', 'package.json 要写 icon(客户端卡片会显示它)')
  assert.ok(!isAbsolute(icon) && !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon), 'icon 必须是相对路径')
  const file = join(root, icon)
  assert.ok(existsSync(file), 'icon 文件不存在: ' + icon)
  assert.ok(/\.(svg|png|jpe?g|webp)$/i.test(icon), 'icon 只接受 SVG/PNG/JPEG/WebP')
  assert.ok(statSync(file).size <= 256 * 1024, 'icon 超过 256KiB,宿主会拒收')
  assert.ok((pkg.files || []).includes(icon), 'icon 要进 files,否则装完找不到图')
})

test('回退用的 package.json description 是有人话的一句简介', () => {
  assert.ok(typeof pkg.description === 'string' && pkg.description.length > 10, 'description 是 npm 搜索页/无词典时的兜底文案')
  assert.ok(!/,/.test(pkg.description), '中文简介里别用半角逗号(与其它文案不一致)')
})

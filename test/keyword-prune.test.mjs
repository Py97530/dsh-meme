import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

/**
 * issue #30 附带的建议:导入的图库常把「角色大标签」写进每一条的 keywords ——
 * deepseek-chan 里 4 个词各出现在 1407/1407 条,于是搜「GPT」命中全库;official-001 的
 * 「表情包」占 70%、dafeiyu-001 的「大肥鱼」占 100%,同类。
 *
 * 判定原则:出现在 ≥50% 条目里的词对检索零信息量(比维护黑名单通用)。这里盯三件事:
 *   ① 纯函数:过半才剔、小图库不动手、只动 keywords 不碰别的;
 *   ② DB 级:prunePackKeywords 只更新 keywords 字段;
 *   ③ 端到端:走真实 importMemePack 导入一个 ZIP,落盘的索引里高频词确实没了。
 */

const { pruneCommonKeywords } = await import('../memes.js')

const row = (keywords) => ({ keywords })

test('① 过半才剔:≥50% 的词删掉,下游的词保留', () => {
  // 10 条里:核心标签 9/10、开心 5/10(正好 50% 的边界)、个性词 4/10、独家词 1/10
  const rows = Array.from({ length: 10 }, (_, i) => row(
    i === 9
      ? '独门'
      : '核心标签' + (i < 5 ? ' 开心' : '') + (i < 4 ? ' 个性词' : '') + (i === 0 ? ' 独家词' : ''),
  ))
  const { drop, cleaned } = pruneCommonKeywords(rows)
  assert.deepEqual(drop.sort(), ['开心', '核心标签'], '过半的词才是噪音')
  assert.equal(cleaned[0], '个性词 独家词', '第 0 条剩下的词按原顺序留着')
  assert.equal(cleaned[4], '', '只剩被剔词的条目清空')
  assert.equal(cleaned[9], null, '本来就没有被剔词的条目不动(null)')
})

test('① 小图库不动手:3 张猫图里的「猫」是唯一检索入口', () => {
  const rows = Array.from({ length: 3 }, () => row('猫 可爱'))
  const { drop, cleaned } = pruneCommonKeywords(rows)
  assert.deepEqual(drop, [], '条目数不到 minRows 就不剔')
  assert.deepEqual(cleaned, [null, null, null])
})

test('① 大小写不敏感,写回时保留原样;同一条里重复的词只算一次', () => {
  const rows = [
    ...Array.from({ length: 4 }, () => row('DeepSeek娘 deepseek娘 GPT娘')),
    ...Array.from({ length: 3 }, () => row('DeepSeek娘 干饭')),
    row('DeepSeek娘'),
  ]
  const { drop, cleaned } = pruneCommonKeywords(rows)
  assert.deepEqual(drop, ['deepseek娘', 'gpt娘'], '同一个词大小写不同也只算一个')
  assert.equal(cleaned[4], '干饭', '不过半的词留着')
  assert.equal(cleaned[7], '', '被剔空的条目写成空串')
})

test('② prunePackKeywords 只改 keywords,别的不碰', async () => {
  const { prunePackKeywords } = await import('../memes.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-meme-prune-'))
  const dbPath = join(dir, 'index.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE memes (path TEXT PRIMARY KEY, tag TEXT, file_name TEXT, caption TEXT, keywords TEXT, mtime REAL, captioned_at REAL)')
  const ins = db.prepare('INSERT INTO memes VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (let i = 0; i < 9; i++) {
    ins.run('memes/happy/' + i + '.jpg', 'happy', i + '.jpg', '描述' + i, '全库标签' + (i < 4 ? ' 干饭' : ''), 1, 1)
  }
  db.close()

  const res = prunePackKeywords(dbPath)
  assert.deepEqual(res.drop, ['全库标签'])
  assert.equal(res.changed, 9)

  const check = new DatabaseSync(dbPath, { readOnly: true })
  const rows = check.prepare('SELECT path, tag, caption, keywords FROM memes ORDER BY path').all()
  check.close()
  assert.equal(rows.length, 9)
  assert.equal(rows[0].keywords, '干饭', '剩下的话留着')
  assert.equal(rows[0].tag, 'happy', 'tag 不动')
  assert.equal(rows[0].caption, '描述0', 'caption 不动')
})

// ---------- ③ 端到端:真实 importMemePack ----------

const home = mkdtempSync(join(tmpdir(), 'dsh-meme-prune-e2e-'))
process.env.DSH_MEME_HOME = home

const handlers = []
const webServer = {
  host: '127.0.0.1', port: 3999,
  register(r) { handlers.push(r) },
  tapIndex() {},
}
const ctx = {
  effect(body) { return body() },
  on() { return () => {} },
  get(name) { return name === 'webServer' ? webServer : undefined },
  tools: { register() { return () => {} } },
  agentDefaultModel: null,
}
const mod = await import('../index.js')
mod.apply(ctx, {})
const api = handlers.find((h) => h.path === '/dsh-memes-api')

const post = (body) => new Promise((resolve, reject) => {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/'
  req.headers = { host: '127.0.0.1:3999' }
  const res = {
    statusCode: null, body: null,
    writeHead(s) { res.statusCode = s },
    end(b) { res.body = String(b); resolve(res) },
  }
  api.handler(req, res).catch(reject)
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
})

test('③ 导入 ZIP 时自动剔除高频关键词(deepseek-chan 那种角色标签)', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-meme-prune-zip-'))
  const dbPath = join(work, 'index.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE memes (path TEXT PRIMARY KEY, tag TEXT, file_name TEXT, caption TEXT, keywords TEXT, mtime REAL, captioned_at REAL)')
  const ins = db.prepare('INSERT INTO memes VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (let i = 0; i < 10; i++) {
    // 站点把角色大标签写进每一条(10/10),另有一个 4/10 的真关键词
    ins.run('memes/happy/' + i + '.jpg', 'happy', i + '.jpg', '表情' + i,
      'DeepSeek娘 ' + (i < 4 ? '摸鱼 ' : ''), 1, 1)
  }
  db.close()
  const zip = mod.zipStore([{ name: 'index.db', data: readFileSync(dbPath) }])
  const res = await post({ op: 'importMemePack', dataBase64: zip.toString('base64'), name: 'prunetest' })
  assert.equal(res.statusCode, 200)
  assert.ok(JSON.parse(res.body).ok, res.body)

  const installed = join(home, '.dsh', 'meme-packs', 'prunetest', 'index.db')
  assert.ok(existsSync(installed), '图库应装到扫描目录下:' + installed)
  const check = new DatabaseSync(installed, { readOnly: true })
  const rows = check.prepare('SELECT keywords FROM memes').all()
  check.close()
  assert.equal(rows.length, 10)
  assert.ok(rows.every((r) => !String(r.keywords).includes('DeepSeek娘')), '角色大标签应被剔除')
  assert.equal(rows.filter((r) => String(r.keywords).includes('摸鱼')).length, 4, '不过半的真关键词要留着')
})

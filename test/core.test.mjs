// dsh-config-migrate — core pure-logic tests (no DSH runtime needed)
// Run: node test/core.test.mjs
// CI runs these on ubuntu / windows / macos.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---- pure helpers copied from host.js (kept dependency-free) ----
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes) {
  let out = ''
  const len = bytes.length
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < len ? bytes[i + 1] : 0
    const b2 = i + 2 < len ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < len ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < len ? B64[b2 & 63] : '='
  }
  return out
}

function base64Len(b64) {
  const s = String(b64).replace(/[^A-Za-z0-9+/=]/g, '')
  let pad = 0
  if (s.endsWith('==')) pad = 2
  else if (s.endsWith('=')) pad = 1
  return Math.floor((s.length * 3) / 4) - pad
}

function tryUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (e) {
    return null
  }
}

function relativizeLinks(text) {
  return String(text).replace(/"link:[^"]*external-plugins[\\/]+([^"\\/]+)"/g, '"link:../../external-plugins/$1"')
}

function isWindowsPath(p) {
  return /^[A-Za-z]:/.test(p) || p.indexOf('\\') !== -1
}

function joinBase(base, rel) {
  const sep = isWindowsPath(base) ? '\\' : '/'
  return String(base).replace(/[\\/]+$/, '') + sep + String(rel).split('/').join(sep)
}

function safeRel(rel) {
  const s = String(rel)
  if (!s) return null
  if (/^[A-Za-z]:/.test(s)) return null // windows drive prefix
  if (s.startsWith('/') || s.startsWith('\\')) return null // absolute
  const parts = s.split('/')
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || p.indexOf('\\') !== -1) return null
  }
  return parts.join('/')
}

// ---- tests ----
let passed = 0
function ok(name, cond) {
  assert.ok(cond, name)
  passed++
  console.log('  ✓ ' + name)
}

console.log('base64 encoding/decoding')
{
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 127, 128])
  const b64 = bytesToBase64(bytes)
  const decoded = Buffer.from(b64, 'base64')
  ok('roundtrip length', decoded.length === bytes.length)
  ok('roundtrip bytes', Buffer.from(bytes).equals(decoded))
  ok('base64Len matches', base64Len(b64) === bytes.length)
  ok('base64Len handles padding', base64Len('AA==') === 1 && base64Len('AAA=') === 2)
}

console.log('utf8 detection')
{
  ok('ascii is utf8', tryUtf8(new TextEncoder().encode('hello')) === 'hello')
  ok('binary rejected', tryUtf8(new Uint8Array([0xff, 0xfe, 0x00, 0x01])) === null)
  ok('utf8 multibyte ok', tryUtf8(new TextEncoder().encode('中文')) === '中文')
}

console.log('link relativization')
{
  const src = JSON.stringify({ dep: 'link:C:/Users/xxx/.dsh/external-plugins/skin-a' }, null, 2)
  const out = relativizeLinks(src)
  ok('absolute link rewritten', out.includes('link:../../external-plugins/skin-a'))
  ok('no absolute path remains', !out.includes('C:/Users'))
  const untouched = JSON.stringify({ dep: 'link:../../external-plugins/skin-a' })
  ok('relative link untouched', relativizeLinks(untouched) === untouched)
  ok('non-plugin link untouched', relativizeLinks('"link:file:///x"') === '"link:file:///x"')
}

console.log('platform detection & path joining')
{
  ok('windows drive', isWindowsPath('C:\\Users\\a'))
  ok('windows backslash', isWindowsPath('/x\\y'))
  ok('unix root', !isWindowsPath('/home/user'))
  ok('win join', joinBase('C:\\Users\\a', 'b/c') === 'C:\\Users\\a\\b\\c')
  ok('unix join', joinBase('/home/a', 'b/c') === '/home/a/b/c')
}

console.log('path safety')
{
  ok('clean rel ok', safeRel('a/b/c.yaml') === 'a/b/c.yaml')
  ok('dotdot rejected', safeRel('../x') === null)
  ok('absolute rejected', safeRel('/etc/passwd') === null)
  ok('windows abs rejected', safeRel('C:/x') === null)
  ok('empty rejected', safeRel('') === null)
}

console.log('credential encryption roundtrip (real crypto)')
{
  const pass = 'test-password'
  const secret = 'DEEPSEEK_API_KEY: sk-1234567890'
  const salt = crypto.randomBytes(16)
  const key = crypto.scryptSync(pass, salt, 32)
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()])
  const payload = { salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64') }
  // decrypt
  const dkey = crypto.scryptSync(pass, Buffer.from(payload.salt, 'base64'), 32)
  const d = crypto.createDecipheriv('aes-256-gcm', dkey, Buffer.from(payload.iv, 'base64'))
  d.setAuthTag(Buffer.from(payload.tag, 'base64'))
  const plain = Buffer.concat([d.update(Buffer.from(payload.data, 'base64')), d.final()])
  ok('encrypt/decrypt roundtrip', plain.toString('utf8') === secret)
  // wrong password must fail auth
  let wrongFailed = false
  try {
    const wk = crypto.scryptSync('wrong', Buffer.from(payload.salt, 'base64'), 32)
    const wd = crypto.createDecipheriv('aes-256-gcm', wk, Buffer.from(payload.iv, 'base64'))
    wd.setAuthTag(Buffer.from(payload.tag, 'base64'))
    wd.update(Buffer.from(payload.data, 'base64'))
    wd.final()
  } catch (e) {
    wrongFailed = true
  }
  ok('wrong password rejected', wrongFailed)
}

console.log('junction/symlink creation (temp dir)')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmig-test-'))
  try {
    const target = path.join(tmp, 'external-plugins', 'demo')
    const link = path.join(tmp, 'node_modules', '@dsh-external', 'demo')
    fs.mkdirSync(target, { recursive: true })
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.writeFileSync(path.join(target, 'package.json'), '{"name":"demo"}')
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    fs.symlinkSync(target, link, type)
    ok('link resolves to target', fs.readFileSync(path.join(link, 'package.json'), 'utf8') === '{"name":"demo"}')
    // remove link without touching target
    if (process.platform === 'win32') {
      fs.rmdirSync(link) // junction removal does not delete target
    } else {
      fs.unlinkSync(link)
    }
    ok('target survives link removal', fs.existsSync(path.join(target, 'package.json')))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('binary decode via Buffer')
{
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const b64 = bytes.toString('base64')
  ok('buffer roundtrip', Buffer.from(b64, 'base64').equals(bytes))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmig-bin-'))
  try {
    const inFile = path.join(tmp, 'in.b64')
    const outFile = path.join(tmp, 'out.bin')
    fs.writeFileSync(inFile, b64, 'utf8')
    const content = fs.readFileSync(inFile, 'utf8')
    fs.writeFileSync(outFile, Buffer.from(content.replace(/\s/g, ''), 'base64'))
    fs.unlinkSync(inFile)
    ok('decoded file matches', fs.readFileSync(outFile).equals(bytes))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log(`\nAll ${passed} assertions passed.`)

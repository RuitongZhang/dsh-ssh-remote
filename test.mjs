import assert from 'node:assert/strict'
import { apply, inject, name } from './index.js'

const tools = new Map()
const sections = []
const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    },
  },
}

apply(ctx, { host: process.env.TEST_HOST ?? 'Linux', root: '~' })

assert.equal(name, 'ssh-remote')
assert.deepEqual(inject, ['tools', 'systemPrompt'])
for (const tool of ['remote_bash', 'remote_read', 'remote_write', 'remote_edit', 'remote_grep', 'remote_glob']) {
  assert.ok(tools.has(tool), `missing tool ${tool}`)
}
assert.equal(sections.length, 1)

const exec = { signal: new AbortController().signal }
const text = async (tool, args) => {
  const definition = tools.get(tool)
  const value = await definition.execute(args, exec)
  return definition.output.render(args, value)[0].text
}
const dir = '/tmp/dsh-ssh-remote-test'

const results = []
const check = (label, condition, detail) => {
  results.push({ label, ok: Boolean(condition), detail })
  if (!condition) console.error('FAIL', label, detail)
}

const out = []
const step = async (label, fn) => {
  try {
    const value = await fn()
    out.push(value)
    check(label, true, String(value).slice(0, 160))
  } catch (error) {
    check(label, false, error.message)
  }
}

await step('bash echoes in a fresh remote root', async () => {
  const body = await text('remote_bash', { command: 'printf "hello\\n"; pwd; uname -s' })
  assert.match(body, /hello/)
  assert.match(body, /Linux/)
  assert.match(body, /home\/zrt/)
  return body
})

await step('bash reports a failing exit code', async () => {
  const body = await text('remote_bash', { command: 'echo boom >&2; exit 3' })
  assert.match(body, /boom/)
  assert.match(body, /\[exit code: 3\]/)
  return body
})

await step('bash times out', async () => {
  const body = await text('remote_bash', { command: 'sleep 5', timeoutMs: 800 })
  assert.match(body, /timed out/)
  return body
})

await step('write creates parent directories', async () => {
  const body = await text('remote_write', { path: `${dir}/nested/hello.txt`, content: 'alpha\nbeta\ngamma\n' })
  assert.match(body, /Wrote 17 bytes \(4 lines\)/)
  return body
})

await step('read numbers lines and reports the total', async () => {
  const body = await text('remote_read', { path: `${dir}/nested/hello.txt` })
  assert.match(body, /<path>\/tmp\/dsh-ssh-remote-test\/nested\/hello\.txt<\/path>/)
  assert.match(body, /1: alpha/)
  assert.match(body, /3: gamma/)
  assert.match(body, /total 3 lines/)
  return body
})

await step('read pages with offset and limit', async () => {
  const body = await text('remote_read', { path: `${dir}/nested/hello.txt`, offset: 2, limit: 1 })
  assert.match(body, /2: beta/)
  assert.doesNotMatch(body, /1: alpha/)
  assert.match(body, /Showing lines 2-2 of 3/)
  return body
})

await step('read rejects an out-of-range offset', async () => {
  await assert.rejects(
    () => text('remote_read', { path: `${dir}/nested/hello.txt`, offset: 9 }),
    /out of range/,
  )
  return 'rejected'
})

await step('read rejects a missing file', async () => {
  await assert.rejects(
    () => text('remote_read', { path: `${dir}/nope.txt` }),
    /no such file or directory/,
  )
  return 'rejected'
})

await step('read rejects a binary file', async () => {
  await text('remote_bash', { command: `printf 'a\\000b' > ${dir}/bin.dat` })
  await assert.rejects(
    () => text('remote_read', { path: `${dir}/bin.dat` }),
    /binary/,
  )
  return 'rejected'
})

await step('edit replaces exactly one occurrence', async () => {
  const body = await text('remote_edit', {
    path: `${dir}/nested/hello.txt`,
    old_string: 'beta',
    new_string: 'BETA',
  })
  assert.match(body, /Replaced 1 occurrence/)
  const after = await text('remote_read', { path: `${dir}/nested/hello.txt` })
  assert.match(after, /2: BETA/)
  return body
})

await step('edit refuses an ambiguous match', async () => {
  await text('remote_write', { path: `${dir}/dup.txt`, content: 'x\ny\nx\n' })
  await assert.rejects(
    () => text('remote_edit', { path: `${dir}/dup.txt`, old_string: 'x', new_string: 'z' }),
    /more than once/,
  )
  return 'rejected'
})

await step('edit replace_all changes every occurrence', async () => {
  const body = await text('remote_edit', { path: `${dir}/dup.txt`, old_string: 'x', new_string: 'z', replace_all: true })
  assert.match(body, /Replaced 2 occurrences/)
  return body
})

await step('edit round-trips unicode and preserves permissions', async () => {
  await text('remote_write', { path: `${dir}/mode.sh`, content: '#!/bin/sh\necho 你好\n' })
  await text('remote_bash', { command: `chmod 755 ${dir}/mode.sh` })
  const body = await text('remote_edit', { path: `${dir}/mode.sh`, old_string: '你好', new_string: '世界' })
  assert.match(body, /Replaced 1/)
  const mode = await text('remote_bash', { command: `stat -c %a ${dir}/mode.sh` })
  assert.match(mode, /755/)
  const content = await text('remote_read', { path: `${dir}/mode.sh` })
  assert.match(content, /世界/)
  return body
})

await step('grep finds a pattern with an include filter', async () => {
  const body = await text('remote_grep', { pattern: 'BETA', path: dir })
  assert.match(body, /nested\/hello\.txt:2:BETA/)
  return body
})

await step('grep reports no matches', async () => {
  const body = await text('remote_grep', { pattern: 'zzz-nothing-zzz', path: dir })
  assert.match(body, /No matches/)
  return body
})

await step('glob lists matching files', async () => {
  const body = await text('remote_glob', { pattern: '**/*.txt', path: dir })
  assert.match(body, /nested\/hello\.txt/)
  return body
})

await step('relative paths resolve against the remote root', async () => {
  const body = await text('remote_bash', { command: 'pwd' })
  assert.equal(body.split('\n')[0], '/home/zrt')
  return body
})

await text('remote_bash', { command: `mv ${dir} ${dir}.done.$$` })

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1

/**
 * dsh-ssh-remote — model-facing tools that read, edit, search, and run
 * commands on a remote Linux host through the local `ssh` client.
 *
 * The plugin registers plain tool definitions (no harness package imports) so
 * a profile-local bundle needs no dependency of its own. Paths are absolute
 * remote paths or paths relative to the configured remote root.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { posix } from 'node:path'

export const name = 'ssh-remote'
export const inject = ['tools', 'systemPrompt']

const DEFAULTS = {
  host: 'Linux',
  root: '~',
  bashTimeoutMs: 120000,
  maxOutputChars: 30000,
}

const READ_LINE_MAX = 2000
const READ_BYTES_MAX = 50000
const GREP_MATCHES_MAX = 200
const GLOB_RESULTS_MAX = 500
const FILE_BYTES_MAX = 8 * 1024 * 1024
const MARK = '<<<DSH_SSH'
const HEAD_CAP = 4 * 1024 * 1024
const TAIL_CAP = 64 * 1024

// A mux socket path must stay well under the 104-byte unix-socket limit, so use
// a short per-user directory instead of the (long) platform temp directory.
const CONTROL_DIR = posix.join('/tmp', `dsh-ssh-${typeof process.getuid === 'function' ? process.getuid() : 'me'}`)
mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 })

const SSH_OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${posix.join(CONTROL_DIR, '%C')}`,
  '-o', 'ControlPersist=120',
]

/** Quote one string as a POSIX shell word. */
function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/** Quote a path while keeping a leading `~` expandable by the shell. */
function shPath(value) {
  if (value === '~') return '~'
  if (value.startsWith('~/')) return `~/${shQuote(value.slice(2))}`
  return shQuote(value)
}

/** Turn bytes into text, noting any mid-stream omission. */
function decodeSink(sink) {
  const head = Buffer.concat(sink.head).toString('utf8')
  if (sink.dropped === 0) return head
  const tail = Buffer.concat(sink.tail).toString('utf8')
  return `${head}\n[... ${sink.dropped} bytes of output omitted ...]\n${tail}`
}

/**
 * Run one ssh invocation, collecting stdout and stderr with bounded memory.
 * A `script` runs through `bash -s` on stdin; otherwise `command` runs through
 * the remote login shell.
 */
function runSsh(settings, { script, command, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const args = [...SSH_OPTIONS, settings.host]
    if (script !== undefined) args.push('bash', '-s')
    else args.push('bash', '-lc', shQuote(command))

    let child
    try {
      child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }

    const sink = (label) => ({
      label,
      head: [],
      headBytes: 0,
      tail: [],
      tailBytes: 0,
      dropped: 0,
    })
    const out = sink('stdout')
    const err = sink('stderr')

    const collect = (sinkState, chunk) => {
      if (sinkState.headBytes + chunk.length <= HEAD_CAP) {
        sinkState.head.push(chunk)
        sinkState.headBytes += chunk.length
        return
      }
      const room = HEAD_CAP - sinkState.headBytes
      if (room > 0) {
        sinkState.head.push(chunk.subarray(0, room))
        sinkState.headBytes = HEAD_CAP
        chunk = chunk.subarray(room)
      }
      sinkState.dropped += chunk.length
      sinkState.tail.push(chunk)
      sinkState.tailBytes += chunk.length
      while (sinkState.tailBytes > TAIL_CAP) {
        const dropped = sinkState.tail.shift()
        sinkState.tailBytes -= dropped.length
      }
    }

    child.stdout.on('data', (chunk) => collect(out, chunk))
    child.stderr.on('data', (chunk) => collect(err, chunk))
    child.stdin.on('error', () => {})

    let settled = false
    let timedOut = false
    let aborted = false
    let timer
    const killTimer = () => {
      if (settled) return
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 2000)
      force.unref?.()
    }
    const onAbort = () => {
      aborted = true
      killTimer()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTimer()
      }, timeoutMs)
      timer.unref?.()
    }

    const settle = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }

    child.on('error', (error) => {
      settle(reject, new Error(`cannot run ssh: ${error.message}`))
    })
    child.on('close', (code) => {
      settle(resolve, {
        code: code ?? -1,
        stdout: decodeSink(out),
        stderr: decodeSink(err),
        timedOut,
        aborted,
      })
    })

    if (script !== undefined) child.stdin.end(script)
    else child.stdin.end()
  })
}

/**
 * Run a script and fail on a non-zero exit or on a `error=` marker.
 * @returns the trimmed stdout without the marker line.
 */
async function runScript(settings, script, options = {}) {
  const result = await runSsh(settings, {
    script,
    timeoutMs: options.timeoutMs ?? 30000,
    signal: options.signal,
  })
  if (result.aborted) throw new Error('aborted')
  if (result.timedOut) throw new Error(`ssh timed out after ${options.timeoutMs ?? 30000}ms`)
  const { body, meta } = splitMeta(result.stdout)
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || body.trim()).slice(0, 2000)
    throw new Error(detail || `ssh exited with code ${result.code}`)
  }
  if (meta?.error) throw new Error(describeMetaError(meta, options.path))
  return { body: body.replace(/\n$/, ''), meta: meta ?? {} }
}

/** Diagnostic text for the error markers the remote scripts emit. */
function describeMetaError(meta, path) {
  const target = path ?? meta.path ?? 'target'
  switch (meta.error) {
    case 'missing': return `no such file or directory: ${target}`
    case 'isdir': return `${target} is a directory; use remote_glob or remote_bash (ls) to inspect it`
    case 'noread': return `permission denied: ${target}`
    case 'toolarge': return `${target} is ${meta.size ?? 'too'} bytes; the limit is ${FILE_BYTES_MAX}`
    case 'mkdir': return `cannot create the parent directory of ${target}`
    case 'write': return `cannot write ${target}`
    case 'move': return `cannot replace ${target}`
    default: return `remote operation failed: ${meta.error}`
  }
}

/** Split the trailing marker line off one stdout payload. */
function splitMeta(text) {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].replace(/\r$/, '')
    if (!line.startsWith(MARK)) continue
    const meta = {}
    for (const part of line.slice(MARK.length).replace(/>>>$/, '').trim().split(/\s+/)) {
      const eq = part.indexOf('=')
      if (eq > 0) meta[part.slice(0, eq)] = part.slice(eq + 1)
    }
    return { body: lines.slice(0, index).join('\n'), meta }
  }
  return { body: text, meta: null }
}

/** Resolve `~`, absolute paths, and root-relative paths to one remote path. */
function resolveRemotePath(value, root, home) {
  if (value.startsWith('~/')) return posix.join(home, value.slice(2))
  if (value === '~') return home
  if (value.startsWith('/')) return posix.normalize(value)
  return posix.join(root, value)
}

/** Cap one text payload for the model, keeping both ends. */
function capText(text, max) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n[... ${text.length - max} characters omitted ...]\n${text.slice(-tail)}`
}

/** Render one tool call's pending card. */
function genericView(title, kind, rawInput, locations) {
  return {
    card: 'generic',
    title,
    kind,
    ...rawInput === undefined ? {} : { rawInput },
    ...locations === undefined ? {} : { locations },
  }
}

function readScript(path, offset, end, maxLine, maxBytes) {
  return `f=${shQuote(path)}
if [ ! -e "$f" ]; then printf '${MARK} error=missing>>>\\n'; exit 0; fi
if [ -d "$f" ]; then printf '${MARK} error=isdir>>>\\n'; exit 0; fi
if [ ! -r "$f" ]; then printf '${MARK} error=noread>>>\\n'; exit 0; fi
awk -v s=${offset} -v e=${end} -v maxline=${maxLine} -v maxbytes=${maxBytes} '
{ n=NR
  if (n>=s && n<=e && !over) {
    line=$0
    if (length(line)>maxline) line=substr(line,1,maxline) "... (line truncated to " maxline " chars)"
    if (out+length(line)+16>maxbytes) { over=1; next }
    out+=length(line)+16; shown++; last=n
    printf "%d: %s\\n", n, line
  }
}
END { printf "${MARK} total=%d shown=%d last=%d over=%d>>>\\n", NR, shown, last, over }
' < "$f"
`
}

function base64ReadScript(path) {
  return `f=${shQuote(path)}
if [ ! -e "$f" ]; then printf '${MARK} error=missing>>>\\n'; exit 0; fi
if [ -d "$f" ]; then printf '${MARK} error=isdir>>>\\n'; exit 0; fi
sz=$(stat -c %s -- "$f")
if [ "$sz" -gt ${FILE_BYTES_MAX} ]; then printf '${MARK} error=toolarge size=%s>>>\\n' "$sz"; exit 0; fi
base64 -w0 -- "$f"
printf '\\n'
`
}

function base64WriteScript(path, base64) {
  return `f=${shQuote(path)}
d=$(dirname -- "$f")
tmp="$f.dsh-tmp.$$"
trap 'rm -f -- "$tmp"' EXIT
mkdir -p -- "$d" || { printf '${MARK} error=mkdir>>>\\n'; exit 0; }
printf '%s' '${base64}' | base64 -d > "$tmp" || { printf '${MARK} error=write>>>\\n'; exit 0; }
if [ -e "$f" ]; then chmod --reference="$f" "$tmp" 2>/dev/null; fi
mv -f -- "$tmp" "$f" || { printf '${MARK} error=move>>>\\n'; exit 0; }
printf '${MARK} ok=1>>>\\n'
`
}

function grepScript(dir, pattern, include) {
  const includeArg = include === undefined ? '' : ` -g ${shQuote(include)}`
  return `cd ${shQuote(dir)} 2>/dev/null || { printf '${MARK} error=missing>>>\\n'; exit 0; }
out=$(rg --no-heading --line-number --with-filename --color=never --hidden --max-columns 400 --max-columns-preview -g '!**/.git/**'${includeArg} -e ${shQuote(pattern)} . | head -n ${GREP_MATCHES_MAX + 1})
status=\${PIPESTATUS[0]}
printf '%s\\n' "$out"
printf '${MARK} status=%d>>>\\n' "$status"
`
}

function globScript(dir, pattern) {
  return `cd ${shQuote(dir)} 2>/dev/null || { printf '${MARK} error=missing>>>\\n'; exit 0; }
rg --files --hidden -g ${shQuote(pattern)} -g '!**/.git/**' | LC_ALL=C sort | head -n ${GLOB_RESULTS_MAX + 1}
`
}

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  const rootLabel = String(settings.root)
  let resolved // { root, home }, resolved once per activation

  const ensurePaths = async (signal) => {
    if (resolved) return resolved
    const { body } = await runScript(
      settings,
      `printf '%s\\n' "$HOME"
cd ${shPath(settings.root)} 2>/dev/null && pwd || printf '${MARK} error=missing path=%s>>>\\n' ${shQuote(settings.root)}
`,
      { signal, path: rootLabel },
    )
    const [home, root] = body.split('\n').map((line) => line.trim())
    if (!root || !root.startsWith('/')) throw new Error(`remote root is not a directory: ${rootLabel}`)
    resolved = { root, home: home || root }
    return resolved
  }

  const resolvePath = async (value, signal) => {
    const { root, home } = await ensurePaths(signal)
    return resolveRemotePath(value, root, home)
  }

  const displayPath = (value) => {
    if (typeof value !== 'string' || value.length === 0) return rootLabel
    if (value.startsWith('/')) return value
    if (value.startsWith('~')) return value
    return posix.join(resolved?.root ?? rootLabel, value)
  }

  const requireString = (value, field) => {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`)
    return value
  }

  const textOutput = {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }

  ctx.tools.register({
    name: 'remote_bash',
    description: `Run a shell command on the remote Linux host (local SSH alias "${settings.host}") with its login environment.
Use this for git, builds, tests, package managers, service state, and any other work on that machine; the local bash tool cannot see or change the remote host.
The command starts in \`cwd\` — an absolute remote path, or one relative to the remote root ${rootLabel} — and returns combined stdout/stderr plus the exit code. Long output is truncated. Start servers and long jobs detached (nohup, tmux) because the call itself has a timeout.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run on the remote host.' },
        cwd: { type: 'string', description: `Working directory on the remote host. Defaults to ${rootLabel}; a relative path resolves against it.` },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds before the SSH call is killed. Defaults to 120000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'terminal',
      title: typeof args.command === 'string' && args.command.length > 0 ? args.command : 'remote command',
      description: `${settings.host} · remote`,
      cwd: typeof args.cwd === 'string' && args.cwd.startsWith('/') ? args.cwd : rootLabel,
    }),
    async execute(args, exec) {
      const command = requireString(args.command, 'command')
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : rootLabel
      const target = await resolvePath(cwd, exec.signal)
      const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : settings.bashTimeoutMs
      const result = await runSsh(settings, {
        command: `cd ${shQuote(target)} 2>/dev/null || { echo ${shQuote(`dsh-ssh: cannot cd to ${target}`)} >&2; exit 2; }
${command}`,
        timeoutMs,
        signal: exec.signal,
      })
      if (result.aborted) throw new Error('aborted')
      const parts = []
      if (result.stdout.trim().length > 0) parts.push(result.stdout.trimEnd())
      if (result.stderr.trim().length > 0) parts.push(`[stderr]\n${result.stderr.trimEnd()}`)
      if (result.timedOut) parts.push(`[timed out after ${timeoutMs}ms]`)
      if (result.code !== 0 && !result.timedOut) parts.push(`[exit code: ${result.code}]`)
      const body = parts.length > 0 ? parts.join('\n\n') : '(no output)'
      return {
        text: capText(`${body}\n\n[exit code: ${result.code}]`, settings.maxOutputChars),
      }
    },
  })

  ctx.tools.register({
    name: 'remote_read',
    description: `Read a UTF-8 text file on the remote Linux host (SSH alias "${settings.host}") as line-numbered text.
\`path\` is an absolute remote path or a path relative to the remote root ${rootLabel}. Use \`offset\` (1-based) and \`limit\` to page through large files; the footer reports the total line count. The local read tool cannot see this file.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Remote file path: absolute, ~/..., or relative to the remote root.' },
        offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to 1000.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    presentCall: (args) => genericView(`Read ${displayPath(args.path)}`, 'read', undefined, [{ path: displayPath(args.path), line: Number.isFinite(args.offset) ? args.offset : 1 }]),
    async execute(args, exec) {
      const path = await resolvePath(requireString(args.path, 'path'), exec.signal)
      const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 1
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 1000
      const { body, meta } = await runScript(settings, readScript(path, offset, offset + limit - 1, READ_LINE_MAX, READ_BYTES_MAX), {
        signal: exec.signal,
        path,
      })
      if (body.includes('\u0000')) throw new Error(`${path} looks like a binary file; use remote_bash (e.g. file, xxd) instead`)
      const total = Number(meta.total ?? 0)
      const shown = Number(meta.shown ?? 0)
      const last = Number(meta.last ?? 0)
      if (offset > total && !(total === 0 && offset === 1)) {
        throw new Error(`offset ${offset} is out of range for "${path}" (${total} lines)`)
      }
      let footer
      if (meta.over === '1') footer = `(Output capped. Showing lines ${offset}-${last}. Use offset=${last + 1} to continue.)`
      else if (last < total) footer = `(Showing lines ${offset}-${last} of ${total}. Use offset=${last + 1} to continue.)`
      else footer = `(End of file - total ${total} lines)`
      const numbered = shown > 0 ? body.replace(/\n$/, '') : ''
      return {
        text: `<path>${path}</path>
<content>
${numbered.length > 0 ? `${numbered}\n\n${footer}` : footer}
</content>`,
      }
    },
  })

  ctx.tools.register({
    name: 'remote_write',
    description: `Create or fully replace a text file on the remote Linux host (SSH alias "${settings.host}"). Parent directories are created and an existing file is replaced atomically, keeping its permissions.
Use \`remote_edit\` for targeted changes. The local write tool only affects this Mac.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Remote file path: absolute, ~/..., or relative to the remote root.' },
        content: { type: 'string', description: 'Full UTF-8 text content of the file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    presentCall: (args) => genericView(`Write ${displayPath(args.path)}`, 'edit', undefined, [{ path: displayPath(args.path) }]),
    async execute(args, exec) {
      const path = await resolvePath(requireString(args.path, 'path'), exec.signal)
      if (typeof args.content !== 'string') throw new Error('content must be a string')
      const bytes = Buffer.from(args.content, 'utf8')
      if (bytes.length > FILE_BYTES_MAX) throw new Error(`${path}: content is ${bytes.length} bytes; the limit is ${FILE_BYTES_MAX}`)
      await runScript(settings, base64WriteScript(path, bytes.toString('base64')), { signal: exec.signal, path })
      const lines = args.content.length === 0 ? 0 : args.content.split('\n').length
      return { text: `Wrote ${bytes.length} bytes (${lines} lines) to ${path}.` }
    },
  })

  ctx.tools.register({
    name: 'remote_edit',
    description: `Edit a text file on the remote Linux host (SSH alias "${settings.host}") by replacing literal text.
\`old_string\` must appear exactly once unless \`replace_all\` is true; include surrounding context to make it unique. The file is rewritten atomically and keeps its permissions. The local edit tool only affects this Mac.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Remote file path: absolute, ~/..., or relative to the remote root.' },
        old_string: { type: 'string', description: 'Literal text to replace.' },
        new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Defaults to false; otherwise old_string must occur exactly once.' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    presentCall: (args) => genericView(`Edit ${displayPath(args.path)}`, 'edit', undefined, [{ path: displayPath(args.path) }]),
    async execute(args, exec) {
      const path = await resolvePath(requireString(args.path, 'path'), exec.signal)
      if (typeof args.old_string !== 'string' || args.old_string.length === 0) throw new Error('old_string must be a non-empty string')
      if (typeof args.new_string !== 'string') throw new Error('new_string must be a string')
      const { body } = await runScript(settings, base64ReadScript(path), { signal: exec.signal, path })
      const before = Buffer.from(body.trim(), 'base64')
      if (before.length > FILE_BYTES_MAX) throw new Error(`${path} is larger than ${FILE_BYTES_MAX} bytes`)
      const needle = Buffer.from(args.old_string, 'utf8')
      const replacement = Buffer.from(args.new_string, 'utf8')
      const positions = []
      for (let at = before.indexOf(needle); at !== -1; at = before.indexOf(needle, at + needle.length)) {
        positions.push(at)
        if (positions.length > 1 && args.replace_all !== true) break
      }
      if (positions.length === 0) throw new Error(`old_string was not found in ${path}`)
      if (positions.length > 1 && args.replace_all !== true) {
        throw new Error(`old_string occurs more than once in ${path}; include more surrounding context or set replace_all`)
      }
      const chunks = []
      let cursor = 0
      for (const at of positions) {
        chunks.push(before.subarray(cursor, at), replacement)
        cursor = at + needle.length
      }
      chunks.push(before.subarray(cursor))
      const after = Buffer.concat(chunks)
      await runScript(settings, base64WriteScript(path, after.toString('base64')), { signal: exec.signal, path })
      return { text: `Replaced ${positions.length} occurrence${positions.length === 1 ? '' : 's'} in ${path}.` }
    },
  })

  ctx.tools.register({
    name: 'remote_grep',
    description: `Search file contents on the remote Linux host (SSH alias "${settings.host}") with ripgrep.
\`pattern\` is a ripgrep regular expression. \`path\` is an absolute remote path or a path relative to the remote root ${rootLabel}; \`include\` is one glob filter such as "*.ts". Respects the repository's .gitignore and returns up to ${GREP_MATCHES_MAX} matching lines as path:line:text.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Ripgrep regular expression.' },
        path: { type: 'string', description: 'Remote file or directory to search. Defaults to the remote root.' },
        include: { type: 'string', description: 'One glob filter for which files to search, e.g. "*.ts".' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    presentCall: (args) => genericView(`Search "${args.pattern}" in ${displayPath(args.path)}`, 'search'),
    async execute(args, exec) {
      const pattern = requireString(args.pattern, 'pattern')
      const dir = await resolvePath(typeof args.path === 'string' && args.path.length > 0 ? args.path : '.', exec.signal)
      const include = typeof args.include === 'string' && args.include.length > 0 ? args.include : undefined
      const { body, meta } = await runScript(settings, grepScript(dir, pattern, include), { signal: exec.signal, path: dir })
      const lines = body.split('\n').map((line) => line.replace(/\r$/, '').replace(/^\.\//, '')).filter((line) => line.length > 0)
      if (meta.status === '2') throw new Error(`ripgrep failed: ${lines.join('\n').slice(0, 2000)}`)
      if (lines.length === 0) return { text: `No matches for ${JSON.stringify(pattern)} in ${dir}.` }
      const shown = lines.slice(0, GREP_MATCHES_MAX)
      const truncated = lines.length > GREP_MATCHES_MAX
      const footer = truncated ? `\n\n[showing the first ${GREP_MATCHES_MAX} matches]` : ''
      return { text: capText(`${shown.join('\n')}${footer}`, settings.maxOutputChars) }
    },
  })

  ctx.tools.register({
    name: 'remote_glob',
    description: `Find files on the remote Linux host (SSH alias "${settings.host}") whose paths match a glob pattern.
\`path\` is an absolute remote directory or a path relative to the remote root ${rootLabel}; \`pattern\` is a ripgrep glob such as "**/*.py" or "*.toml". Hidden files are included, .gitignore is respected, directories are not returned, and at most ${GLOB_RESULTS_MAX} paths are listed.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts".' },
        path: { type: 'string', description: 'Remote directory to search. Defaults to the remote root.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    presentCall: (args) => genericView(`Find ${args.pattern} in ${displayPath(args.path)}`, 'search'),
    async execute(args, exec) {
      const pattern = requireString(args.pattern, 'pattern')
      const dir = await resolvePath(typeof args.path === 'string' && args.path.length > 0 ? args.path : '.', exec.signal)
      const { body } = await runScript(settings, globScript(dir, pattern), { signal: exec.signal, path: dir })
      const lines = body.split('\n').map((line) => line.replace(/\r$/, '').replace(/^\.\//, '')).filter((line) => line.length > 0)
      if (lines.length === 0) return { text: `No files in ${dir} match ${JSON.stringify(pattern)}.` }
      const truncated = lines.length > GLOB_RESULTS_MAX
      const shown = lines.slice(0, GLOB_RESULTS_MAX)
      const footer = truncated ? `\n\n[showing the first ${GLOB_RESULTS_MAX} paths]` : ''
      return { text: capText(`${shown.join('\n')}${footer}`, settings.maxOutputChars) }
    },
  })

  ctx.systemPrompt.section({
    name: 'ssh-remote:host',
    order: 1500,
    text: `## Remote Linux host over SSH

A Linux development host is reachable with the local SSH alias \`${settings.host}\`. The \`remote_*\` tools operate on that host: \`remote_bash\` runs shell commands, \`remote_read\`/\`remote_write\`/\`remote_edit\` handle its files, and \`remote_grep\`/\`remote_glob\` search them. Their \`path\` arguments are absolute remote paths or paths relative to the remote root \`${rootLabel}\`.

The local \`bash\`, \`read\`, \`write\`, \`edit\`, \`grep\`, and \`glob\` tools operate only on this Mac. Use the \`remote_*\` tools whenever the work is on the Linux host.`,
  })
}

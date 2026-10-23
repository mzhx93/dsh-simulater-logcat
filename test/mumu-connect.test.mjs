import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { registerHooks } from 'node:module'
import { win32 } from 'node:path'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'ws') return { url: 'data:text/javascript,export%20class%20WebSocket%7Bstatic%20OPEN%3D1%7D%3Bexport%20class%20WebSocketServer%7Bconstructor()%7B%7D%7D', shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-tools') return { url: 'data:text/javascript,export%20function%20defineTool(x)%7Breturn%20x%7D', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { AdbEngine, MuMuReconnect, makeMuMuRoutes, apply, inject } = await import('../lib/index.js')
const manager = 'C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\MuMuManager.exe'
const adb = 'C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe'
const info = (patch = {}) => JSON.stringify({
  '0': { index: '0', name: 'MuMu 12', adb_host_ip: '127.0.0.1', adb_port: 16384, is_process_started: true, is_android_started: true, player_state: 'start_finished', ...patch },
})
function createHarness(responses = {}) {
  const calls = []
  const engine = new AdbEngine({ mumu: {
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files' },
    isFile: (path) => path === manager,
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, options })
      queueMicrotask(() => callback(null, responses[args[0] === 'info' ? 'info' : args[0]] ?? '', ''))
      return { kill() {} }
    },
  } })
  engine.adb = adb
  engine.adbResolvedPath = adb
  engine.devices.set('USB-1', { serial: 'USB-1', state: 'device', model: 'phone' })
  engine.streams.set('USB-1', { marker: 'existing stream', stop() {} })
  return { engine, calls }
}

function readyDevices(extra = '') {
  return 'List of devices attached\n' + extra + '127.0.0.1:16384\tdevice product:mumu model:MuMu12\n'
}
function response() {
  return Object.assign(new EventEmitter(), {
    status: null, headers: {}, body: '', destroyed: false, writableEnded: false,
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status) { this.status = status },
    end(body = '') { this.body = body; this.writableEnded = true },
  })
}
function request(method, path, body = '', auth = undefined) {
  const headers = { host: '127.0.0.1:9800' }
  if (method === 'POST') headers['content-type'] = 'application/json'
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)])
  req.method = method
  req.url = path
  req.headers = headers
  req.socket = { remoteAddress: '127.0.0.1' }
  req.auth = auth
  return req
}
async function invoke(route, req) {
  const res = response()
  await route.handler(req, res)
  return { res, body: JSON.parse(res.body || '{}') }
}

const conn = { requestRejection: (req) => req.auth === false ? 401 : undefined }

test('MuMu discovery accepts only ready keyed rows and canonical endpoints', async () => {
  const { engine, calls } = createHarness({ info: JSON.stringify({
    '0': { index: '0', name: 'ready', adb_host_ip: '127.0.0.1', adb_port: 16384, is_process_started: true, is_android_started: true, player_state: 'start_finished' },
    '1': { index: '1', name: 'starting', adb_port: 16385, is_process_started: true, is_android_started: false, player_state: 'starting_rom' },
    '2': { index: '2', name: 'remote', adb_host_ip: '192.168.1.2', adb_port: 16386, is_process_started: true, is_android_started: true, player_state: 'start_finished' },
    '3': { index: '3', name: 'bad port', adb_port: 65536, is_process_started: true, is_android_started: true, player_state: 'start_finished' },
    '4': { index: '5', name: 'index mismatch', adb_port: 16387, is_process_started: true, is_android_started: true, player_state: 'start_finished' },
  }) })
  try {
    const found = await engine.mumu.discover()
    assert.equal(found.available, true)
    assert.deepEqual(found.instances.map((item) => [item.id, item.serial]), [['0', '127.0.0.1:16384']])
    assert.equal(calls[0].file, manager)
    assert.deepEqual(calls[0].args, ['info', '-v', 'all'])
    assert.equal(calls[0].options.shell, false)
    assert.ok(calls[0].options.timeout <= 5000)
  } finally { engine.dispose() }
})

test('discovery reports unsupported platform and malformed manager output diagnostically', async () => {
  const unsupported = new MuMuReconnect({ adb })
  unsupported.platform = 'linux'
  assert.equal((await unsupported.discover()).diagnostic.code, 'unsupported_platform')
  const { engine } = createHarness({ info: 'not json' })
  try { await assert.rejects(engine.mumu.discover(), (error) => error.code === 'invalid_manager_output') }
  finally { engine.dispose() }
})

test('reconnect uses fresh manager port, exact online serial, and preserves active streams', async () => {
  const { engine, calls } = createHarness({ info: info(), connect: 'connected to 127.0.0.1:16384\n', devices: readyDevices('USB-1\tdevice model:phone\n') })
  const stream = engine.streams.get('USB-1')
  const frames = []
  engine.broadcast = (frame) => frames.push(frame)
  try {
    const result = await engine.mumu.connect('0')
    assert.equal(result.ok, true)
    assert.equal(result.serial, '127.0.0.1:16384')
    assert.deepEqual(calls.map((call) => call.args), [['info', '-v', 'all'], ['connect', '127.0.0.1:16384'], ['devices', '-l']])
    assert.equal(engine.streams.get('USB-1'), stream)
    assert.equal(engine.devices.get('USB-1').state, 'device')
    assert.equal(engine.devices.get('127.0.0.1:16384').state, 'device')
    assert.equal(frames.length, 1)
    assert.equal(engine.mumu.busy, false)
  } finally { engine.dispose() }
})

test('reconnect refuses an unauthorized or non-exact offline result', async () => {
  const { engine, calls } = createHarness({ info: info(), connect: 'unable\n', devices: readyDevices().replace('127.0.0.1:16384\tdevice', '127.0.0.1:16384\toffline') })
  try {
    await assert.rejects(engine.mumu.connect('0'), (error) => error.code === 'device_not_online')
    assert.deepEqual(calls.map((call) => call.args[0]), ['info', 'connect', 'devices'])
  } finally { engine.dispose() }

  const blocked = createHarness({ info: info() })
  const routes = makeMuMuRoutes(blocked.engine, { requestRejection: () => 401 })
  try {
    const route = routes.routes.find((item) => item.path.endsWith('/mumu/instances'))
    const { res, body } = await invoke(route, request('GET', route.path))
    assert.equal(res.status, 401)
    assert.equal(body.code, 'unauthorized')
    assert.equal(blocked.calls.length, 0)
  } finally { routes.dispose(); blocked.engine.dispose() }
})

test('connect route requires only canonical instanceId and authenticated loopback', async () => {
  const { engine, calls } = createHarness({ info: info(), connect: 'ok\n', devices: readyDevices() })
  const routes = makeMuMuRoutes(engine, conn)
  try {
    const route = routes.routes.find((item) => item.path.endsWith('/mumu/connect'))
    for (const body of ['{}', '{"instanceId":0}', '{"instanceId":"00"}', '{"instanceId":"0","port":16384}']) {
      const { res } = await invoke(route, request('POST', route.path, body))
      assert.equal(res.status, 400)
    }
    assert.equal(calls.length, 0)
    const remote = request('POST', route.path, '{"instanceId":"0"}')
    remote.socket.remoteAddress = '192.168.1.5'
    const denied = await invoke(route, remote)
    assert.equal(denied.res.status, 403)
    assert.equal(calls.length, 0)
    const accepted = await invoke(route, request('POST', route.path, '{"instanceId":"0"}'))
    assert.equal(accepted.res.status, 200)
    assert.equal(accepted.body.serial, '127.0.0.1:16384')
  } finally { routes.dispose(); engine.dispose() }
})

test('canonical numeric IDs reject coercions, injection strings, and out-of-range indices', async () => {
  const { engine, calls } = createHarness({ info: info() })
  try {
    for (const id of [0, null, '', '00', '-1', '+0', ' 0', '0 ', '0;connect', '2147483648', '999999999999999999999']) {
      await assert.rejects(engine.mumu.connect(id), (error) => error.code === 'invalid_instance')
    }
    assert.equal(calls.length, 0)
  } finally { engine.dispose() }
})

test('manager rows validate exact port, host, readiness, and index types', async () => {
  for (const patch of [
    { index: '00' }, { index: '0junk' }, { index: 0.5 }, { adb_port: '16384' }, { adb_port: 0 }, { adb_port: -1 },
    { adb_port: 1.5 }, { adb_port: 65536 }, { adb_host_ip: '' }, { adb_host_ip: null }, { adb_host_ip: 'localhost' },
    { adb_host_ip: '127.0.0.2' }, { adb_host_ip: '127.0.0.1;echo' }, { is_process_started: 1 }, { is_android_started: 'true' },
    { player_state: 'starting_rom' }, { player_state: 'stopped' },
  ]) {
    const { engine, calls } = createHarness({ info: info(patch) })
    try {
      assert.deepEqual((await engine.mumu.discover()).instances, [], JSON.stringify(patch))
      await assert.rejects(engine.mumu.connect('0'), (error) => error.code === 'instance_not_ready')
      assert.ok(calls.every((call) => call.args[0] === 'info'))
    } finally { engine.dispose() }
  }
  for (const port of [1, 65535]) {
    const row = JSON.parse(info({ index: 0, adb_port: port }))
    delete row['0'].adb_host_ip
    const { engine } = createHarness({ info: JSON.stringify(row) })
    try { assert.equal((await engine.mumu.discover()).instances[0].port, port) }
    finally { engine.dispose() }
  }
})

test('POST re-discovers instead of trusting cached ports or a now-stopped instance', async () => {
  const { engine, calls } = createHarness()
  const outputs = [info(), info({ adb_port: 16399 })]
  engine.mumu.execFile = (file, args, options, callback) => {
    calls.push({ file, args, options })
    const stdout = args[0] === 'info' ? outputs.shift() : args[0] === 'devices' ? readyDevices().replaceAll('16384', '16399') : 'connected'
    queueMicrotask(() => callback(null, stdout, ''))
    return { kill() {} }
  }
  try {
    assert.equal((await engine.mumu.discover()).instances[0].port, 16384)
    assert.equal((await engine.mumu.connect('0')).serial, '127.0.0.1:16399')
    assert.deepEqual(calls[2].args, ['connect', '127.0.0.1:16399'])
    outputs.push(info({ is_process_started: false }))
    await assert.rejects(engine.mumu.connect('0'), (error) => error.code === 'instance_not_ready')
    assert.equal(calls.filter((call) => call.args[0] === 'connect').length, 1)
  } finally { engine.dispose() }
})

test('connect text alone cannot prove success or select a different online serial', async () => {
  for (const devices of ['List of devices attached\n', readyDevices().replaceAll('16384', '16385'), readyDevices().replace('\tdevice', '\tunauthorized')]) {
    const { engine } = createHarness({ info: info(), connect: 'connected to 127.0.0.1:16384', devices })
    try {
      await assert.rejects(engine.mumu.connect('0'), (error) => error.code === 'device_not_online')
      assert.equal(engine.devices.has('127.0.0.1:16384'), false)
    } finally { engine.dispose() }
  }
})

test('manager prefers selected adb sibling, supports standard roots, and reports missing/unresolved', async () => {
  const { engine, calls } = createHarness({ info: info() })
  const customAdb = 'D:\\MuMu installation\\shell\\adb.exe'
  const customManager = 'D:\\MuMu installation\\shell\\MuMuManager.exe'
  engine.adbResolvedPath = customAdb
  engine.mumu.isFile = (path) => path === manager || path === customManager
  try {
    await engine.mumu.discover()
    assert.equal(calls[0].file, customManager)
    engine.mumu.isFile = (path) => path === manager
    await engine.mumu.discover()
    assert.equal(calls[1].file, manager)
    engine.mumu.isFile = () => false
    assert.equal((await engine.mumu.discover()).diagnostic.code, 'manager_missing')
    assert.equal(calls.length, 2)
    engine.adb = 'adb'
    engine.adbResolvedPath = null
    assert.equal((await engine.mumu.discover()).diagnostic.code, 'adb_unresolved')
    engine.adb = null
    assert.equal((await engine.mumu.discover()).diagnostic.code, 'adb_unavailable')
  } finally { engine.dispose() }
})

test('MuMu Player 12 nx_main manager is found from alternate MuMu adb copies or standard roots', async () => {
  const { engine, calls } = createHarness({ info: info() })
  const installedManager = win32.normalize('D:/Program Files/Netease/MuMu Player 12/nx_main/MuMuManager.exe')
  engine.mumu.isFile = path => path === installedManager
  try {
    for (const selected of [
      'D:/Program Files/Netease/MuMu Player 12/shell/adb.exe',
      'D:/Program Files/Netease/MuMu Player 12/nx_device/12.0/shell/adb.exe',
    ]) {
      engine.adbResolvedPath = selected
      await engine.mumu.discover()
      assert.equal(calls.at(-1).file, installedManager)
    }
    engine.adbResolvedPath = 'C:/AndroidSdk/platform-tools/adb.exe'
    engine.mumu.env = { ProgramFiles: 'D:/Program Files' }
    await engine.mumu.discover()
    assert.equal(calls.at(-1).file, installedManager)
  } finally { engine.dispose() }
})

test('manager output has strict size, shape and row-count limits', async () => {
  for (const [value, code] of [
    ['[]', 'invalid_manager_output'], ['null', 'invalid_manager_output'], ['{"error":"bad"}', 'invalid_manager_output'],
    ['x'.repeat(256 * 1024 + 1), 'output_limit'],
    [JSON.stringify(Object.fromEntries(Array.from({ length: 129 }, (_, id) => [String(id), {}]))), 'output_limit'],
  ]) {
    const { engine } = createHarness({ info: value })
    try { await assert.rejects(engine.mumu.discover(), (error) => error.code === code) }
    finally { engine.dispose() }
  }
  const duplicate = JSON.parse(info())
  duplicate['1'] = { ...duplicate['0'], index: '1' }
  const { engine } = createHarness({ info: JSON.stringify(duplicate) })
  try { assert.deepEqual((await engine.mumu.discover()).instances, []) }
  finally { engine.dispose() }
})

test('command failures and spawn throws release busy without touching ADB server', async () => {
  for (const failingCommand of ['info', 'connect', 'devices']) {
    const { engine, calls } = createHarness()
    engine.mumu.execFile = (file, args, options, callback) => {
      calls.push({ file, args, options })
      if (args[0] === failingCommand) throw new Error('spawn failed with local details')
      queueMicrotask(() => callback(null, args[0] === 'info' ? info() : 'connected', ''))
      return { kill() {} }
    }
    try {
      await assert.rejects(engine.mumu.connect('0'), (error) => error.code === (failingCommand === 'info' ? 'manager_failed' : failingCommand + '_failed'))
      assert.equal(engine.mumu.busy, false)
      assert.ok(calls.every((call) => ['info', 'connect', 'devices'].includes(call.args[0])))
      for (const call of calls) {
        assert.equal(call.options.shell, false)
        assert.equal(call.options.windowsHide, true)
        assert.ok(call.options.timeout <= 8000)
        assert.ok(call.options.maxBuffer <= 256 * 1024)
      }
    } finally { engine.dispose() }
  }
})

test('routes fail closed without host auth, enforce methods/body bounds, and reject malformed loopback hosts', async () => {
  const { engine, calls } = createHarness({ info: info() })
  const noAuth = makeMuMuRoutes(engine, {})
  const routes = makeMuMuRoutes(engine, conn)
  try {
    assert.equal((await invoke(noAuth.routes[0], request('GET', noAuth.routes[0].path))).res.status, 503)
    const [get, post] = routes.routes
    assert.equal((await invoke(get, request('POST', get.path))).res.status, 405)
    assert.equal((await invoke(post, request('GET', post.path))).res.status, 405)
    assert.equal((await invoke(post, request('POST', post.path, '{'))).res.status, 400)
    assert.equal((await invoke(post, request('POST', post.path, 'x'.repeat(1025)))).res.status, 413)
    const wrongType = request('POST', post.path, '{"instanceId":"0"}')
    wrongType.headers['content-type'] = 'text/plain'
    assert.equal((await invoke(post, wrongType)).res.status, 415)
    for (const host of ['127.evil:9800', '127.0.0.1:9800/evil', 'user@127.0.0.1:9800', 'example.com:9800']) {
      const req = request('GET', get.path)
      req.headers.host = host
      assert.equal((await invoke(get, req)).res.status, 403)
    }
    assert.equal(calls.length, 0)
    const accepted = await invoke(get, request('GET', get.path))
    assert.equal(accepted.res.status, 200)
    assert.equal(accepted.res.headers['cache-control'], 'no-store')
  } finally { noAuth.dispose(); routes.dispose(); engine.dispose() }
})

test('response disconnect or route disposal cancels child processes and rejects late results', async () => {
  for (const reason of ['disconnect', 'dispose']) {
    let finish
    let killed = false
    let started
    const began = new Promise((resolve) => { started = resolve })
    const { engine } = createHarness()
    engine.mumu.execFile = (_file, _args, _options, callback) => {
      finish = callback
      started()
      return { kill() { killed = true } }
    }
    const routes = makeMuMuRoutes(engine, conn)
    const res = response()
    const req = request('GET', routes.routes[0].path)
    const pending = routes.routes[0].handler(req, res)
    await began
    if (reason === 'disconnect') { res.destroyed = true; res.emit('close') } else routes.dispose()
    await pending
    assert.equal(killed, true)
    assert.equal(engine.mumu.busy, false)
    finish(null, info(), '')
    assert.equal(engine.devices.size, 1)
    if (reason === 'dispose') assert.equal((await invoke(routes.routes[0], request('GET', routes.routes[0].path))).res.status, 503)
    routes.dispose()
    engine.dispose()
  }
})

test('subprocess deadlines kill only the owned short command and release busy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let killed = false
  const { engine } = createHarness()
  engine.mumu.execFile = (_file, _args, _options, _callback) => ({ kill(signal) { assert.equal(signal, 'SIGKILL'); killed = true } })
  try {
    const pending = engine.mumu.discover()
    const failed = assert.rejects(pending, (error) => error.code === 'timeout' && error.status === 504)
    t.mock.timers.tick(5001)
    await failed
    assert.equal(killed, true)
    assert.equal(engine.mumu.busy, false)
    assert.equal(engine.streams.has('USB-1'), true)
  } finally { engine.dispose(); t.mock.timers.reset() }
})

test('request abort and changed adb stop reconnect before side effects', async () => {
  const { engine, calls } = createHarness({ info: info(), connect: 'connected', devices: readyDevices() })
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(engine.mumu.connect('0', { signal: controller.signal }), (error) => error.code === 'cancelled')
    assert.equal(calls.length, 0)
    engine.mumu.execFile = (_file, args, _options, callback) => {
      calls.push(args)
      queueMicrotask(() => { engine.adb = 'D:\\Other\\adb.exe'; callback(null, info(), '') })
      return { kill() {} }
    }
    await assert.rejects(engine.mumu.connect('0'), (error) => error.code === 'adb_changed')
    assert.equal(calls.length, 1)
  } finally { engine.dispose() }
})

test('poll never starts a capture while reconnect is in flight or after disposal', async () => {
  let finish
  const { engine } = createHarness()
  engine.mumu.execFile = (_file, _args, _options, callback) => { finish = callback; return { kill() {} } }
  try {
    const pending = engine.mumu.connect('0')
    assert.equal(engine.mumu.connecting, true)
    await engine.poll()
    assert.equal(engine.polling, false)
    assert.equal(engine.streams.size, 1)
    engine.dispose()
    await assert.rejects(pending, (error) => error.code === 'cancelled')
    await engine.poll()
    engine.startPolling()
    assert.equal(engine.timer, null)
    assert.equal(engine.devices.has('127.0.0.1:16384'), false)
    finish(null, info(), '')
  } finally { engine.dispose() }
})

test('Cordis mounts authenticated routes through effects and cleans them on disposal', async () => {
  const originalInit = AdbEngine.prototype.init
  const originalFetch = globalThis.fetch
  const registered = []
  const upgrades = []
  const tools = []
  const effects = []
  let provided
  const ctx = {
    connection: conn,
    provide(name, value) { assert.equal(name, 'logcat'); provided = value },
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    webServer: {
      register(route) { registered.push(route); return () => registered.splice(registered.indexOf(route), 1) },
      registerUpgrade(route) { upgrades.push(route); return () => upgrades.splice(upgrades.indexOf(route), 1) },
    },
    tools: { register(tool) { tools.push(tool); return () => tools.splice(tools.indexOf(tool), 1) } },
    systemPrompt: { section() { throw new Error('announcement should be disabled') } },
  }
  AdbEngine.prototype.init = async () => false
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  try {
    apply(ctx, { announceToAgent: false })
    assert.ok(inject.includes('connection'))
    assert.ok(provided.engine instanceof AdbEngine)
    const get = registered.find((route) => route.path === '/api/dsh-logcat/mumu/instances')
    const post = registered.find((route) => route.path === '/api/dsh-logcat/mumu/connect')
    assert.ok(get)
    assert.ok(post)
    assert.equal(tools.length, 30)
    const refused = await invoke(get, request('GET', get.path, '', false))
    assert.equal(refused.res.status, 401)
    for (const dispose of effects.reverse()) dispose?.()
    assert.equal(registered.length, 0)
    assert.equal(upgrades.length, 0)
    assert.equal(tools.length, 0)
    assert.equal(provided.engine.disposed, true)
    assert.equal((await invoke(get, request('GET', get.path))).res.status, 503)
    await Promise.resolve()
  } finally {
    provided?.engine.dispose()
    AdbEngine.prototype.init = originalInit
    globalThis.fetch = originalFetch
  }
})

test('concurrent operations are rejected and disposal cancels in-flight manager commands', async () => {
  let callback
  let killed = false
  const engine = new AdbEngine({ mumu: {
    platform: 'win32', env: {}, isFile: () => true,
    execFile: (_file, _args, _options, cb) => { callback = cb; return { kill() { killed = true } } },
  } })
  engine.adb = adb
  const pending = engine.mumu.discover()
  await assert.rejects(engine.mumu.discover(), (error) => error.code === 'busy')
  engine.dispose()
  await assert.rejects(pending, (error) => error.code === 'cancelled')
  assert.equal(killed, true)
  callback?.(null, info(), '')
})

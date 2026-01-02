import { ChildProcess, execFile, execFileSync, spawn, exec } from 'child_process'
import {
  dataDir,
  logPath,
  mihomoCorePath,
  mihomoIpcPath,
  mihomoProfileWorkDir,
  mihomoTestDir,
  mihomoWorkConfigPath,
  mihomoWorkDir
} from '../utils/dirs'
import { generateProfile, getRuntimeConfig } from './factory'
import {
  getAppConfig,
  getControledMihomoConfig,
  getProfileConfig,
  patchAppConfig,
  patchControledMihomoConfig
} from '../config'
import { app, dialog, ipcMain, net } from 'electron'
import {
  startMihomoTraffic,
  startMihomoConnections,
  startMihomoLogs,
  startMihomoMemory,
  stopMihomoConnections,
  stopMihomoTraffic,
  stopMihomoLogs,
  stopMihomoMemory,
  patchMihomoConfig,
  mihomoGroups
} from './mihomoApi'
import { readFile, rm, writeFile } from 'fs/promises'
import { promisify } from 'util'
import { mainWindow } from '..'
import path from 'path'
import os from 'os'
import { createWriteStream, existsSync } from 'fs'
import { uploadRuntimeConfig } from '../resolve/gistApi'
import { startMonitor } from '../resolve/trafficMonitor'
import { disableSysProxy, triggerSysProxy } from '../sys/sysproxy'
import { getAxios } from './mihomoApi'
import { setSysDns } from '../service/api'

const ctlParam = process.platform === 'win32' ? '-ext-ctl-pipe' : '-ext-ctl-unix'
const execPromise = promisify(exec)

class UserCancelledError extends Error {
  constructor(message = '用户取消操作') {
    super(message)
    this.name = 'UserCancelledError'
  }
}

function isUserCancelledError(error: unknown): boolean {
  if (error instanceof UserCancelledError) {
    return true
  }
  const errorMsg = error instanceof Error ? error.message : String(error)
  return (
    errorMsg.includes('用户已取消') ||
    errorMsg.includes('User canceled') ||
    errorMsg.includes('(-128)') ||
    errorMsg.includes('user cancelled') ||
    errorMsg.includes('dismissed')
  )
}

let setPublicDNSTimer: NodeJS.Timeout | null = null
let recoverDNSTimer: NodeJS.Timeout | null = null
let networkDetectionTimer: NodeJS.Timeout | null = null
let networkDownHandled = false

let child: ChildProcess
let retry = 10

/**
 * 清理占用管道的残留进程
 * 在Windows上查找并终止所有mihomo相关进程，确保管道可用
 */
async function cleanupPipeAndProcesses(): Promise<void> {
  if (process.platform !== 'win32') {
    return
  }

  try {
    await writeFile(logPath(), '[Manager]: 开始清理管道和残留进程\n', { flag: 'a' })

    // 查找所有mihomo进程
    const { stdout } = await execPromise(
      'powershell -Command "Get-Process | Where-Object {$_.ProcessName -like \'*mihomo*\'} | Select-Object Id,ProcessName,Path | ConvertTo-Json"',
      { encoding: 'utf8' }
    )

    if (!stdout || stdout.trim() === '') {
      await writeFile(logPath(), '[Manager]: 没有发现残留的mihomo进程\n', { flag: 'a' })
      return
    }

    let processes: Array<{ Id: number; ProcessName: string; Path: string | null }> = []
    try {
      const parsed = JSON.parse(stdout)
      processes = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      // 如果解析失败，可能没有进程或格式不对
      return
    }

    // 过滤掉当前进程（如果child存在）
    const currentPid = child?.pid
    const processesToKill = processes.filter((p) => p.Id !== currentPid && p.Id !== process.pid)

    if (processesToKill.length === 0) {
      await writeFile(logPath(), '[Manager]: 没有需要清理的进程\n', { flag: 'a' })
      return
    }

    await writeFile(
      logPath(),
      `[Manager]: 发现 ${processesToKill.length} 个残留进程: ${processesToKill.map((p) => `${p.ProcessName}(${p.Id})`).join(', ')}\n`,
      { flag: 'a' }
    )

    // 依次终止这些进程
    for (const proc of processesToKill) {
      try {
        // 先尝试正常终止
        await execPromise(`taskkill /PID ${proc.Id} /T`, { timeout: 2000 })
        await writeFile(logPath(), `[Manager]: 成功终止进程 ${proc.Id}\n`, { flag: 'a' })
      } catch {
        try {
          // 如果失败，强制终止
          await execPromise(`taskkill /F /PID ${proc.Id} /T`, { timeout: 2000 })
          await writeFile(logPath(), `[Manager]: 强制终止进程 ${proc.Id}\n`, { flag: 'a' })
        } catch (error) {
          await writeFile(
            logPath(),
            `[Manager]: 无法终止进程 ${proc.Id}: ${error}\n`,
            { flag: 'a' }
          )
        }
      }
    }

    // 等待进程完全退出和管道释放
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await writeFile(logPath(), '[Manager]: 管道清理完成\n', { flag: 'a' })
  } catch (error) {
    await writeFile(logPath(), `[Manager]: 清理管道时出错: ${error}\n`, { flag: 'a' })
  }
}

/**
 * 检测管道是否可用
 * 在Windows上尝试短暂连接管道来验证其可用性
 */
async function checkPipeAvailability(): Promise<boolean> {
  if (process.platform !== 'win32') {
    return true
  }

  return new Promise((resolve) => {
    const pipePath = mihomoIpcPath()
    const testCmd = `powershell -Command "Test-Path '${pipePath}'"`

    exec(testCmd, { timeout: 1000 }, (_error, stdout) => {
      // 如果管道不存在（返回False），说明可用
      const available = !stdout.trim().toLowerCase().includes('true')
      resolve(available)
    })
  })
}

export async function startCore(detached = false): Promise<Promise<void>[]> {
  const {
    core = 'mihomo',
    autoSetDNSMode = 'exec',
    diffWorkDir = false,
    mihomoCpuPriority = 'PRIORITY_NORMAL',
    disableLoopbackDetector = false,
    disableEmbedCA = false,
    disableSystemCA = false,
    disableNftables = false,
    safePaths = []
  } = await getAppConfig()
  const { 'log-level': logLevel } = await getControledMihomoConfig()
  const { current } = await getProfileConfig()
  const { tun } = await getControledMihomoConfig()

  let corePath: string
  try {
    corePath = mihomoCorePath(core)
  } catch (error) {
    if (core === 'system') {
      await patchAppConfig({ core: 'mihomo' })
      return startCore(detached)
    }
    throw error
  }

  await generateProfile()
  await checkProfile()
  await stopCore()

  // Windows平台特殊处理：清理管道和残留进程
  if (process.platform === 'win32') {
    // 等待stopCore完全完成，确保管道释放
    await new Promise((resolve) => setTimeout(resolve, 500))

    // 检测管道是否可用
    const isPipeAvailable = await checkPipeAvailability()
    if (!isPipeAvailable) {
      await writeFile(
        logPath(),
        '[Manager]: 检测到管道被占用，开始清理残留进程\n',
        { flag: 'a' }
      )
      await cleanupPipeAndProcesses()

      // 清理后再次检测
      const retryCheck = await checkPipeAvailability()
      if (!retryCheck) {
        await writeFile(
          logPath(),
          '[Manager]: 警告：管道可能仍被占用，尝试继续启动\n',
          { flag: 'a' }
        )
        // 再等待一段时间
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  if (tun?.enable && autoSetDNSMode !== 'none') {
    try {
      await setPublicDNS()
    } catch (error) {
      await writeFile(logPath(), `[Manager]: set dns failed, ${error}`, {
        flag: 'a'
      })
    }
  }
  const { 'rule-providers': ruleProviders, 'proxy-providers': proxyProviders } =
    await getRuntimeConfig()

  const normalize = (s: string): string =>
    s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .normalize('NFC')

  const providerNames = new Set(
    [...Object.keys(ruleProviders || {}), ...Object.keys(proxyProviders || {})].map(normalize)
  )
  const unmatchedProviders = new Set(providerNames)
  const stdout = createWriteStream(logPath(), { flags: 'a' })
  const stderr = createWriteStream(logPath(), { flags: 'a' })
  const env = {
    DISABLE_LOOPBACK_DETECTOR: String(disableLoopbackDetector),
    DISABLE_EMBED_CA: String(disableEmbedCA),
    DISABLE_SYSTEM_CA: String(disableSystemCA),
    DISABLE_NFTABLES: String(disableNftables),
    SAFE_PATHS: safePaths.join(path.delimiter),
    PATH: process.env.PATH
  }
  let initialized = false
  child = spawn(
    corePath,
    [
      '-d',
      diffWorkDir ? mihomoProfileWorkDir(current) : mihomoWorkDir(),
      ctlParam,
      mihomoIpcPath()
    ],
    {
      detached: detached,
      stdio: detached ? 'ignore' : undefined,
      env: env
    }
  )
  if (process.platform === 'win32' && child.pid) {
    os.setPriority(child.pid, os.constants.priority[mihomoCpuPriority])
  }
  if (detached) {
    child.unref()
    return new Promise((resolve) => {
      resolve([new Promise(() => {})])
    })
  }
  child.on('close', async (code, signal) => {
    await writeFile(logPath(), `[Manager]: Core closed, code: ${code}, signal: ${signal}\n`, {
      flag: 'a'
    })
    if (retry) {
      await writeFile(logPath(), `[Manager]: Try Restart Core\n`, { flag: 'a' })
      retry--
      await restartCore()
    } else {
      await stopCore()
    }
  })
  child.stdout?.pipe(stdout)
  child.stderr?.pipe(stderr)
  return new Promise((resolve, reject) => {
    child.stdout?.on('data', async (data) => {
      const str = data.toString()
      if (
        (process.platform !== 'win32' && str.includes('External controller unix listen error')) ||
        (process.platform === 'win32' && str.includes('External controller pipe listen error'))
      ) {
        const errorMsg = `控制器监听错误:\n${str}\n\n可能的原因：\n1. 管道被其他进程占用\n2. 上次内核未正常退出\n\n已尝试自动清理，如问题持续，请尝试：\n- 重启应用\n- 手动结束所有mihomo进程\n- 重启计算机`
        await writeFile(logPath(), `[Manager]: ${errorMsg}\n`, { flag: 'a' })
        reject(errorMsg)
      }

      if (process.platform === 'win32' && str.includes('updater: finished')) {
        try {
          await stopCore(true)
          const promises = await startCore()
          await Promise.all(promises)
        } catch (e) {
          dialog.showErrorBox('内核启动出错', `${e}`)
        }
      }

      if (
        (process.platform !== 'win32' && str.includes('RESTful API unix listening at')) ||
        (process.platform === 'win32' && str.includes('RESTful API pipe listening at'))
      ) {
        resolve([
          new Promise((resolve, reject) => {
            const handleProviderInitialization = async (logLine: string): Promise<void> => {
              for (const match of logLine.matchAll(/Start initial provider ([^"]+)"/g)) {
                const name = normalize(match[1])
                if (providerNames.has(name)) {
                  unmatchedProviders.delete(name)
                }
              }

              if (
                logLine.includes(
                  'Start TUN listening error: configure tun interface: Connect: operation not permitted'
                )
              ) {
                patchControledMihomoConfig({ tun: { enable: false } })
                mainWindow?.webContents.send('controledMihomoConfigUpdated')
                ipcMain.emit('updateTrayMenu')
                reject('虚拟网卡启动失败，前往内核设置页尝试手动授予内核权限')
              }

              const isDefaultProvider = logLine.includes(
                'Start initial compatible provider default'
              )
              const isAllProvidersMatched = providerNames.size > 0 && unmatchedProviders.size === 0

              if ((providerNames.size === 0 && isDefaultProvider) || isAllProvidersMatched) {
                const waitForMihomoReady = async (): Promise<void> => {
                  const maxRetries = 30
                  const retryInterval = 100

                  for (let i = 0; i < maxRetries; i++) {
                    try {
                      await mihomoGroups()
                      break
                    } catch (error) {
                      await new Promise((r) => setTimeout(r, retryInterval))
                    }
                  }
                }

                await waitForMihomoReady()
                initialized = true
                Promise.all([
                  new Promise((r) => setTimeout(r, 100)).then(() => {
                    mainWindow?.webContents.send('groupsUpdated')
                    mainWindow?.webContents.send('rulesUpdated')
                  }),
                  uploadRuntimeConfig(),
                  new Promise((r) => setTimeout(r, 100)).then(() =>
                    patchMihomoConfig({ 'log-level': logLevel })
                  )
                ]).then(() => resolve())
              }
            }
            child.stdout?.on('data', (data) => {
              if (!initialized) {
                handleProviderInitialization(data.toString())
              }
            })
          })
        ])
        await startMihomoTraffic()
        await startMihomoConnections()
        await startMihomoLogs()
        await startMihomoMemory()
        retry = 10
      }
    })
  })
}

export async function stopCore(force = false): Promise<void> {
  try {
    if (!force) {
      await recoverDNS()
    }
  } catch (error) {
    await writeFile(logPath(), `[Manager]: recover dns failed, ${error}`, {
      flag: 'a'
    })
  }

  stopMihomoTraffic()
  stopMihomoConnections()
  stopMihomoLogs()
  stopMihomoMemory()

  if (child && !child.killed) {
    await stopChildProcess(child)
    child = undefined as unknown as ChildProcess
  }

  await getAxios(true).catch(() => {})

  if (existsSync(path.join(dataDir(), 'core.pid'))) {
    const pidString = await readFile(path.join(dataDir(), 'core.pid'), 'utf-8')
    const pid = parseInt(pidString.trim())
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0)
        process.kill(pid, 'SIGINT')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        try {
          process.kill(pid, 0)
          process.kill(pid, 'SIGKILL')
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }
    }
    await rm(path.join(dataDir(), 'core.pid')).catch(() => {})
  }
}

async function stopChildProcess(process: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!process || process.killed) {
      resolve()
      return
    }

    const pid = process.pid
    if (!pid) {
      resolve()
      return
    }

    process.removeAllListeners()

    let isResolved = false
    const timers: NodeJS.Timeout[] = []

    const resolveOnce = async (): Promise<void> => {
      if (!isResolved) {
        isResolved = true

        timers.forEach((timer) => clearTimeout(timer))
        resolve()
      }
    }

    process.once('close', resolveOnce)
    process.once('exit', resolveOnce)

    try {
      process.kill('SIGINT')

      const timer1 = setTimeout(async () => {
        if (!process.killed && !isResolved) {
          try {
            if (pid) {
              globalThis.process.kill(pid, 0)
              process.kill('SIGTERM')
            }
          } catch {
            await resolveOnce()
          }
        }
      }, 3000)
      timers.push(timer1)

      const timer2 = setTimeout(async () => {
        if (!process.killed && !isResolved) {
          try {
            if (pid) {
              globalThis.process.kill(pid, 0)
              process.kill('SIGKILL')
              await writeFile(logPath(), `[Manager]: Force killed process ${pid} with SIGKILL\n`, {
                flag: 'a'
              })
            }
          } catch {
            // ignore
          }
          await resolveOnce()
        }
      }, 6000)
      timers.push(timer2)
    } catch (error) {
      resolveOnce()
      return
    }
  })
}

export async function restartCore(): Promise<void> {
  try {
    await stopCore()
    const promises = await startCore()
    await Promise.all(promises)
  } catch (e) {
    dialog.showErrorBox('内核启动出错', `${e}`)
  }
}

export async function keepCoreAlive(): Promise<void> {
  try {
    await startCore(true)
    if (child && child.pid) {
      await writeFile(path.join(dataDir(), 'core.pid'), child.pid.toString())
    }
  } catch (e) {
    dialog.showErrorBox('内核启动出错', `${e}`)
  }
}

export async function quitWithoutCore(): Promise<void> {
  await keepCoreAlive()
  await startMonitor(true)
  app.exit()
}

async function checkProfile(): Promise<void> {
  const { core = 'mihomo', diffWorkDir = false, safePaths = [] } = await getAppConfig()
  const { current } = await getProfileConfig()
  const corePath = mihomoCorePath(core)
  const execFilePromise = promisify(execFile)
  const env = {
    SAFE_PATHS: safePaths.join(path.delimiter)
  }
  try {
    await execFilePromise(
      corePath,
      [
        '-t',
        '-f',
        diffWorkDir ? mihomoWorkConfigPath(current) : mihomoWorkConfigPath('work'),
        '-d',
        mihomoTestDir()
      ],
      { env }
    )
  } catch (error) {
    if (error instanceof Error && 'stdout' in error) {
      const { stdout } = error as { stdout: string }
      const errorLines = stdout
        .split('\n')
        .filter((line) => line.includes('level=error'))
        .map((line) => line.split('level=error')[1])
      throw new Error(`Profile Check Failed:\n${errorLines.join('\n')}`)
    } else {
      throw error
    }
  }
}

export async function manualGrantCorePermition(
  cores?: ('mihomo' | 'mihomo-alpha')[]
): Promise<void> {
  const execFilePromise = promisify(execFile)

  const grantPermission = async (coreName: 'mihomo' | 'mihomo-alpha'): Promise<void> => {
    const corePath = mihomoCorePath(coreName)
    try {
      if (process.platform === 'darwin') {
        const escapedPath = corePath.replace(/"/g, '\\"')
        const shell = `chown root:admin \\"${escapedPath}\\" && chmod +sx \\"${escapedPath}\\"`
        const command = `do shell script "${shell}" with administrator privileges`
        await execFilePromise('osascript', ['-e', command])
      }
      if (process.platform === 'linux') {
        await execFilePromise('pkexec', [
          'bash',
          '-c',
          `chown root:root "${corePath}" && chmod +sx "${corePath}"`
        ])
      }
    } catch (error) {
      if (isUserCancelledError(error)) {
        throw new UserCancelledError()
      }
      throw error
    }
  }

  const targetCores = cores || ['mihomo', 'mihomo-alpha']
  await Promise.all(targetCores.map((core) => grantPermission(core)))
}

export function checkCorePermissionSync(coreName: 'mihomo' | 'mihomo-alpha'): boolean {
  if (process.platform === 'win32') return true
  try {
    const corePath = mihomoCorePath(coreName)
    const stdout = execFileSync('ls', ['-l', corePath], { encoding: 'utf8' })
    const permissions = stdout.trim().split(/\s+/)[0]
    return permissions.includes('s') || permissions.includes('S')
  } catch {
    return false
  }
}

export async function checkCorePermission(): Promise<{ mihomo: boolean; 'mihomo-alpha': boolean }> {
  const execFilePromise = promisify(execFile)

  const checkPermission = async (coreName: 'mihomo' | 'mihomo-alpha'): Promise<boolean> => {
    try {
      const corePath = mihomoCorePath(coreName)
      const { stdout } = await execFilePromise('ls', ['-l', corePath])
      const permissions = stdout.trim().split(/\s+/)[0]
      return permissions.includes('s') || permissions.includes('S')
    } catch (error) {
      return false
    }
  }

  const [mihomoPermission, mihomoAlphaPermission] = await Promise.all([
    checkPermission('mihomo'),
    checkPermission('mihomo-alpha')
  ])

  return {
    mihomo: mihomoPermission,
    'mihomo-alpha': mihomoAlphaPermission
  }
}

export async function revokeCorePermission(cores?: ('mihomo' | 'mihomo-alpha')[]): Promise<void> {
  const execFilePromise = promisify(execFile)

  const revokePermission = async (coreName: 'mihomo' | 'mihomo-alpha'): Promise<void> => {
    const corePath = mihomoCorePath(coreName)
    try {
      if (process.platform === 'darwin') {
        const escapedPath = corePath.replace(/"/g, '\\"')
        const shell = `chmod a-s \\"${escapedPath}\\"`
        const command = `do shell script "${shell}" with administrator privileges`
        await execFilePromise('osascript', ['-e', command])
      }
      if (process.platform === 'linux') {
        await execFilePromise('pkexec', ['bash', '-c', `chmod a-s "${corePath}"`])
      }
    } catch (error) {
      if (isUserCancelledError(error)) {
        throw new UserCancelledError()
      }
      throw error
    }
  }

  const targetCores = cores || ['mihomo', 'mihomo-alpha']
  await Promise.all(targetCores.map((core) => revokePermission(core)))
}

export async function getDefaultDevice(): Promise<string> {
  const execFilePromise = promisify(execFile)
  const { stdout: deviceOut } = await execFilePromise('route', ['-n', 'get', 'default'])
  let device = deviceOut.split('\n').find((s) => s.includes('interface:'))
  device = device?.trim().split(' ').slice(1).join(' ')
  if (!device) throw new Error('Get device failed')
  return device
}

async function getDefaultService(): Promise<string> {
  const execFilePromise = promisify(execFile)
  const device = await getDefaultDevice()
  const { stdout: order } = await execFilePromise('networksetup', ['-listnetworkserviceorder'])
  const block = order.split('\n\n').find((s) => s.includes(`Device: ${device}`))
  if (!block) throw new Error('Get networkservice failed')
  for (const line of block.split('\n')) {
    if (line.match(/^\(\d+\).*/)) {
      return line.trim().split(' ').slice(1).join(' ')
    }
  }
  throw new Error('Get service failed')
}

async function getOriginDNS(): Promise<void> {
  const execFilePromise = promisify(execFile)
  const service = await getDefaultService()
  const { stdout: dns } = await execFilePromise('networksetup', ['-getdnsservers', service])
  if (dns.startsWith("There aren't any DNS Servers set on")) {
    await patchAppConfig({ originDNS: 'Empty' })
  } else {
    await patchAppConfig({ originDNS: dns.trim().replace(/\n/g, ' ') })
  }
}

async function setDNS(dns: string, mode: 'none' | 'exec' | 'service'): Promise<void> {
  const service = await getDefaultService()
  const dnsServers = dns.split(' ')
  if (mode === 'exec') {
    const execFilePromise = promisify(execFile)
    await execFilePromise('networksetup', ['-setdnsservers', service, ...dnsServers])
    return
  }
  if (mode === 'service') {
    await setSysDns(service, dnsServers)
    return
  }
}

async function setPublicDNS(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (net.isOnline()) {
    const { originDNS, autoSetDNSMode = 'none' } = await getAppConfig()
    if (!originDNS) {
      await getOriginDNS()
      await setDNS('223.5.5.5', autoSetDNSMode)
    }
  } else {
    if (setPublicDNSTimer) clearTimeout(setPublicDNSTimer)
    setPublicDNSTimer = setTimeout(() => setPublicDNS(), 5000)
  }
}

async function recoverDNS(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (net.isOnline()) {
    const { originDNS, autoSetDNSMode = 'none' } = await getAppConfig()
    if (originDNS) {
      await setDNS(originDNS, autoSetDNSMode)
      await patchAppConfig({ originDNS: undefined })
    }
  } else {
    if (recoverDNSTimer) clearTimeout(recoverDNSTimer)
    recoverDNSTimer = setTimeout(() => recoverDNS(), 5000)
  }
}

export async function startNetworkDetection(): Promise<void> {
  const {
    onlyActiveDevice = false,
    networkDetectionBypass = [],
    networkDetectionInterval = 10,
    sysProxy = { enable: false }
  } = await getAppConfig()
  const { tun: { device = process.platform === 'darwin' ? undefined : 'mihomo' } = {} } =
    await getControledMihomoConfig()
  if (networkDetectionTimer) {
    clearInterval(networkDetectionTimer)
  }
  const extendedBypass = networkDetectionBypass.concat(
    [device, 'lo', 'docker0', 'utun'].filter((item): item is string => item !== undefined)
  )

  networkDetectionTimer = setInterval(async () => {
    if (isAnyNetworkInterfaceUp(extendedBypass) && net.isOnline()) {
      if ((networkDownHandled && !child) || (child && child.killed)) {
        const promises = await startCore()
        await Promise.all(promises)
        if (sysProxy.enable) triggerSysProxy(true, onlyActiveDevice)
        networkDownHandled = false
      }
    } else {
      if (!networkDownHandled) {
        if (sysProxy.enable) disableSysProxy(onlyActiveDevice)
        await stopCore()
        networkDownHandled = true
      }
    }
  }, networkDetectionInterval * 1000)
}

export async function stopNetworkDetection(): Promise<void> {
  if (networkDetectionTimer) {
    clearInterval(networkDetectionTimer)
    networkDetectionTimer = null
  }
}

function isAnyNetworkInterfaceUp(excludedKeywords: string[] = []): boolean {
  const interfaces = os.networkInterfaces()
  return Object.entries(interfaces).some(([name, ifaces]) => {
    if (excludedKeywords.some((keyword) => name.includes(keyword))) return false

    return ifaces?.some((iface) => {
      return !iface.internal && (iface.family === 'IPv4' || iface.family === 'IPv6')
    })
  })
}

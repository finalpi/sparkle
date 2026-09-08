import { addProfileItem, getCurrentProfileItem, getProfileConfig } from '../config'
import { appendAppLog } from '../utils/log'

const intervalPool: Record<string, NodeJS.Timeout> = {}

async function logUpdate(message: string): Promise<void> {
  await appendAppLog(`[ProfileUpdater]: ${message}\n`).catch(() => {})
}

function calculateScheduledDelay(schedule: ProfileItem['updateSchedule']): number {
  if (!schedule || schedule.type === 'interval') return -1

  const now = new Date()
  const targetDate = new Date(now)
  if (!schedule.time) return -1

  const [hours, minutes] = schedule.time.split(':').map(Number)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return -1
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return -1

  if (schedule.type === 'daily') {
    targetDate.setHours(hours, minutes, 0, 0)
    if (targetDate.getTime() <= now.getTime()) targetDate.setDate(targetDate.getDate() + 1)
    return targetDate.getTime() - now.getTime()
  }

  if (schedule.type === 'weekly') {
    if (schedule.weekday === undefined || schedule.weekday < 0 || schedule.weekday > 6) return -1
    let daysUntilTarget = schedule.weekday - now.getDay()
    if (daysUntilTarget < 0) daysUntilTarget += 7
    targetDate.setDate(now.getDate() + daysUntilTarget)
    targetDate.setHours(hours, minutes, 0, 0)
    if (targetDate.getTime() <= now.getTime()) targetDate.setDate(targetDate.getDate() + 7)
    return targetDate.getTime() - now.getTime()
  }

  return -1
}

function calculateUpdateDelay(item: ProfileItem): number {
  if (item.updateSchedule && item.updateSchedule.type !== 'interval') {
    return calculateScheduledDelay(item.updateSchedule)
  }
  if (!item.interval || item.interval <= 0) return -1

  const intervalMs = item.interval * 60 * 1000
  const elapsed = Date.now() - (item.updated || 0)
  return elapsed >= intervalMs ? 0 : intervalMs - elapsed
}

function getNextDelay(item: ProfileItem): number {
  if (item.updateSchedule && item.updateSchedule.type !== 'interval') {
    return calculateScheduledDelay(item.updateSchedule)
  }
  return (item.interval || 0) * 60 * 1000
}

function describeSchedule(item: ProfileItem): string {
  const schedule = item.updateSchedule
  if (schedule?.type === 'daily') return `每天 ${schedule.time}`
  if (schedule?.type === 'weekly') {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `${weekdays[schedule.weekday ?? 0]} ${schedule.time}`
  }
  return `每 ${item.interval} 分钟`
}

export async function initProfileUpdater(): Promise<void> {
  const { items, current } = await getProfileConfig()
  const currentItem = await getCurrentProfileItem()

  for (const item of items.filter((candidate) => candidate.id !== current)) {
    await addProfileUpdater(item)
  }

  if (currentItem?.type === 'remote') {
    await addProfileUpdater(currentItem, 10000)
  }
}

export async function addProfileUpdater(item: ProfileItem, startupDelay = 0): Promise<void> {
  if (intervalPool[item.id]) {
    clearTimeout(intervalPool[item.id])
    delete intervalPool[item.id]
  }

  if (item.type !== 'remote' || item.autoUpdate === false) return
  if (!item.updateSchedule && !item.interval) return

  const delay = calculateUpdateDelay(item)
  if (delay < 0) {
    await logUpdate(`订阅 [${item.name}] 未配置有效的更新策略`)
    return
  }

  const finalDelay = (delay === 0 ? getNextDelay(item) : delay) + startupDelay
  if (finalDelay <= 0) {
    await logUpdate(`订阅 [${item.name}] 更新间隔无效`)
    return
  }

  const nextUpdateTime = new Date(Date.now() + finalDelay).toLocaleString('zh-CN', {
    hour12: false
  })
  await logUpdate(
    `订阅 [${item.name}] 设置定时更新: ${describeSchedule(item)}，下次更新时间: ${nextUpdateTime}`
  )

  intervalPool[item.id] = setTimeout(async () => {
    try {
      await logUpdate(`订阅 [${item.name}] 定时触发更新`)
      await addProfileItem(item)
    } catch (error) {
      await logUpdate(`订阅 [${item.name}] 更新失败: ${error}`)
      const config = await getProfileConfig()
      const currentItem = config.items.find((candidate) => candidate.id === item.id)
      if (currentItem) await addProfileUpdater(currentItem)
    }
  }, finalDelay)
}

export async function delProfileUpdater(id: string): Promise<void> {
  if (intervalPool[id]) {
    clearTimeout(intervalPool[id])
    delete intervalPool[id]
  }
}

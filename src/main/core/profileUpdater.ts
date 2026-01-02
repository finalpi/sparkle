import { addProfileItem, getCurrentProfileItem, getProfileConfig } from '../config'
import { logPath } from '../utils/dirs'
import { writeFile } from 'fs/promises'

const intervalPool: Record<string, NodeJS.Timeout> = {}

/**
 * 写入更新日志
 */
async function logUpdate(message: string): Promise<void> {
  try {
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false })
    await writeFile(logPath(), `[${timestamp}] [ProfileUpdater]: ${message}\n`, { flag: 'a' })
  } catch {
    // ignore
  }
}

/**
 * 计算订阅下次更新的延迟时间（毫秒）
 * @param item 订阅配置项
 * @returns 延迟时间（毫秒），-1 表示不需要更新
 */
function calculateUpdateDelay(item: ProfileItem): number {
  // 优先使用新的 updateSchedule 配置
  if (item.updateSchedule) {
    return calculateScheduledDelay(item.updateSchedule)
  }

  // 兼容旧的 interval 配置
  if (!item.interval) {
    return -1
  }

  const now = Date.now()
  const lastUpdated = item.updated || 0
  const intervalMs = item.interval * 60 * 1000
  const timeSinceLastUpdate = now - lastUpdated

  if (timeSinceLastUpdate >= intervalMs) {
    return 0
  }

  return intervalMs - timeSinceLastUpdate
}

/**
 * 根据定时配置计算下次更新延迟
 * @param schedule 定时配置
 * @returns 延迟时间（毫秒）
 */
function calculateScheduledDelay(schedule: ProfileItem['updateSchedule']): number {
  if (!schedule) return -1

  const now = new Date()
  let targetDate = new Date()

  switch (schedule.type) {
    case 'interval': {
      // 使用旧的 interval 逻辑（这里不应该到达，因为有 interval 字段会走上面的逻辑）
      return -1
    }

    case 'daily': {
      // 每天某个时间
      if (!schedule.time) return -1

      const [hours, minutes] = schedule.time.split(':').map(Number)
      targetDate.setHours(hours, minutes, 0, 0)

      // 如果今天的时间已经过了，设置为明天
      if (targetDate.getTime() <= now.getTime()) {
        targetDate.setDate(targetDate.getDate() + 1)
      }

      return targetDate.getTime() - now.getTime()
    }

    case 'weekly': {
      // 每周某天某个时间
      if (!schedule.time || schedule.weekday === undefined) return -1

      const [hours, minutes] = schedule.time.split(':').map(Number)
      const currentWeekday = now.getDay()
      const targetWeekday = schedule.weekday

      // 计算距离目标星期几还有几天
      let daysUntilTarget = targetWeekday - currentWeekday
      if (daysUntilTarget < 0) {
        daysUntilTarget += 7
      } else if (daysUntilTarget === 0) {
        // 今天就是目标日期，检查时间
        targetDate.setHours(hours, minutes, 0, 0)
        if (targetDate.getTime() <= now.getTime()) {
          // 时间已过，设置为下周
          daysUntilTarget = 7
        }
      }

      targetDate.setDate(now.getDate() + daysUntilTarget)
      targetDate.setHours(hours, minutes, 0, 0)

      return targetDate.getTime() - now.getTime()
    }

    default:
      return -1
  }
}

export async function initProfileUpdater(): Promise<void> {
  const { items, current } = await getProfileConfig()
  const currentItem = await getCurrentProfileItem()
  
  // 初始化非当前订阅的定时器
  for (const item of items.filter((i) => i.id !== current)) {
    if (
      item.type === 'remote' &&
      item.autoUpdate !== false &&
      (item.updateSchedule || item.interval)
    ) {
      await addProfileUpdater(item)
    }
  }

  // 初始化当前订阅的定时器（延迟10秒启动）
  if (
    currentItem?.type === 'remote' &&
    currentItem.autoUpdate !== false &&
    (currentItem.updateSchedule || currentItem.interval)
  ) {
    const delay = calculateUpdateDelay(currentItem)

    if (delay === -1) {
      return
    }

    if (delay === 0) {
      try {
        await addProfileItem(currentItem)
      } catch (e) {
        // ignore
      }
    }

    const finalDelay =
      delay === 0 ? getNextIntervalDelay(currentItem) : delay + 10000 // +10s

    intervalPool[currentItem.id] = setTimeout(async () => {
      try {
        await addProfileItem(currentItem)
        // 更新后重新获取配置并重新调度
        const config = await getProfileConfig()
        const updatedItem = config.items.find((i) => i.id === currentItem.id)
        if (updatedItem && updatedItem.autoUpdate !== false) {
          await addProfileUpdater(updatedItem)
        }
      } catch (e) {
        // ignore
      }
    }, finalDelay)
  }
}

export async function addProfileUpdater(item: ProfileItem): Promise<void> {
  // 必须是远程订阅，并且开启了自动更新
  if (item.type !== 'remote' || item.autoUpdate === false) {
    return
  }

  // 必须有 updateSchedule 或 interval 配置
  if (!item.updateSchedule && !item.interval) {
    return
  }

  if (intervalPool[item.id]) {
    clearTimeout(intervalPool[item.id])
  }

  const delay = calculateUpdateDelay(item)

  if (delay === -1) {
    await logUpdate(`订阅 [${item.name}] 未配置有效的更新策略`)
    return
  }

  if (delay === 0) {
    try {
      await logUpdate(`订阅 [${item.name}] 立即执行更新`)
      await addProfileItem(item)
    } catch (e) {
      await logUpdate(`订阅 [${item.name}] 更新失败: ${e}`)
    }
  }

  // 设置定时器
  const scheduleNext = async (): Promise<void> => {
    try {
      await logUpdate(`订阅 [${item.name}] 定时触发更新`)
      await addProfileItem(item)
    } catch (e) {
      await logUpdate(`订阅 [${item.name}] 更新失败: ${e}`)
    }

    // 更新后重新获取配置，因为订阅内容可能已变化
    const config = await getProfileConfig()
    const updatedItem = config.items.find((i) => i.id === item.id)

    if (updatedItem && updatedItem.autoUpdate !== false) {
      // 递归调度下一次更新
      await addProfileUpdater(updatedItem)
    }
  }

  const finalDelay = delay === 0 ? getNextIntervalDelay(item) : delay
  const nextUpdateTime = new Date(Date.now() + finalDelay).toLocaleString('zh-CN', {
    hour12: false
  })

  let scheduleInfo = ''
  if (item.updateSchedule) {
    if (item.updateSchedule.type === 'daily') {
      scheduleInfo = `每天 ${item.updateSchedule.time}`
    } else if (item.updateSchedule.type === 'weekly') {
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
      scheduleInfo = `${weekdays[item.updateSchedule.weekday || 0]} ${item.updateSchedule.time}`
    }
  } else if (item.interval) {
    scheduleInfo = `每 ${item.interval} 分钟`
  }

  await logUpdate(
    `订阅 [${item.name}] 设置定时更新: ${scheduleInfo}，下次更新时间: ${nextUpdateTime}`
  )

  intervalPool[item.id] = setTimeout(scheduleNext, finalDelay)
}

/**
 * 获取下一次间隔更新的延迟（用于 interval 模式立即更新后）
 */
function getNextIntervalDelay(item: ProfileItem): number {
  if (item.updateSchedule?.type === 'daily' || item.updateSchedule?.type === 'weekly') {
    // 对于定时模式，重新计算下次触发时间
    return calculateScheduledDelay(item.updateSchedule)
  }

  // 对于间隔模式，使用 interval
  return (item.interval || 0) * 60 * 1000
}

export async function delProfileUpdater(id: string): Promise<void> {
  if (intervalPool[id]) {
    clearTimeout(intervalPool[id])
    delete intervalPool[id]
  }
}

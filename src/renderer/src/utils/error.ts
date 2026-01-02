/**
 * 格式化错误信息，用于友好地显示错误
 * @param error 任意类型的错误对象
 * @returns 格式化后的错误信息字符串
 */
export function formatError(error: unknown): string {
  // null 或 undefined
  if (error == null) {
    return '发生未知错误'
  }

  // 字符串类型
  if (typeof error === 'string') {
    return error || '发生未知错误'
  }

  // Error 对象
  if (error instanceof Error) {
    return error.message || error.toString()
  }

  // IPC 错误包装对象
  if (typeof error === 'object' && 'invokeError' in error) {
    const invokeError = (error as { invokeError: unknown }).invokeError
    if (typeof invokeError === 'string') {
      return invokeError || '操作失败'
    }
    if (invokeError instanceof Error) {
      return invokeError.message
    }
    // 如果 invokeError 是对象，尝试 JSON 格式化
    if (typeof invokeError === 'object' && invokeError != null) {
      const jsonStr = JSON.stringify(invokeError)
      if (jsonStr === '{}') {
        return '操作失败，请查看日志获取详细信息'
      }
      return jsonStr
    }
  }

  // 尝试 JSON 序列化
  try {
    const jsonStr = JSON.stringify(error)
    if (jsonStr === '{}' || jsonStr === 'null' || jsonStr === 'undefined') {
      return '操作失败，请查看日志获取详细信息'
    }
    return jsonStr
  } catch {
    // JSON 序列化失败
    return String(error) || '发生未知错误'
  }
}


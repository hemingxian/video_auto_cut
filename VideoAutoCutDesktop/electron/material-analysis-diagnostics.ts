import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function redactAnalysisOutput(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => url.split('?')[0])
}

type PathAccessState = 'file' | 'not_file' | 'missing' | 'denied' | 'too_long' | 'unknown'

function inspectAnalysisSource(source: string) {
  const ordinaryPath = source.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
  const windowsPath = path.win32.isAbsolute(ordinaryPath) && /^(?:[a-z]:[\\/]|\\\\)/i.test(ordinaryPath)
  const inspect = (candidate: string): PathAccessState => {
    try {
      return fs.statSync(candidate).isFile() ? 'file' : 'not_file'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
      if (code === 'EACCES' || code === 'EPERM') return 'denied'
      if (code === 'ENAMETOOLONG') return 'too_long'
      return 'unknown'
    }
  }
  return {
    pathLength: ordinaryPath.length,
    windowsPath,
    ordinary: inspect(ordinaryPath),
    extended: windowsPath ? inspect(path.win32.toNamespacedPath(ordinaryPath)) : undefined,
  }
}

export function classifyAnalysisFailure(output: string, runtimeMissing = false, context: { source?: string } = {}) {
  // File names can contain HTTP codes and words such as timeout or SSL. They
  // are not evidence that a request reached the model service.
  const diagnostic = output.replace(/(['"])(?:[a-z]:[\\/]|\\\\|\/)[^\r\n]*?\1/gi, '[file path]')
  const status = diagnostic.match(/(?:HTTP(?:Error)?\s*[:=]?\s*|status(?:_code)?["']?\s*[:=]\s*)([45]\d\d)\b/i)?.[1]
  const responseLabel = status ? `（HTTP ${status}）` : ''
  if (runtimeMissing) return { category: 'runtime_missing', message: '分析引擎未就绪：未找到运行环境，请先在设置中检查或更新引擎' }
  if (/ModuleNotFoundError|ImportError|No module named|DLL load failed/i.test(diagnostic)) return { category: 'dependency', message: '分析引擎依赖缺失或损坏，请更新或修复引擎' }
  if (/\bENAMETOOLONG\b|\bERROR_FILENAME_EXCED_RANGE\b|\[WinError\s+206\]|file(?:name| name) (?:or extension )?is too long|file name too long/i.test(diagnostic)) {
    return { category: 'path_too_long', message: '分析所需文件路径过长，当前运行环境无法访问；请更新引擎，或将素材移到较短目录后重新选择并分析' }
  }
  if (/\bEACCES\b|\bEPERM\b|\bPermissionError\b|\[WinError\s+5\]/i.test(diagnostic)
    || (!status && /permission denied|access (?:is )?denied|拒绝访问/i.test(diagnostic))) {
    return { category: 'file_access_denied', message: '分析所需文件或目录被拒绝访问，请确认当前用户有读取权限并检查安全软件的拦截记录后重试' }
  }
  const clickMissing = /(?:Path|File|Directory)\s+(['"])[^\r\n]*\1\s+does not exist\.?/i.test(output)
  if (clickMissing || /\bENOENT\b|\bENOTDIR\b|no such file|\bFileNotFoundError\b/i.test(diagnostic)) {
    // The Click DIRECTORY argument is the source passed to index, even if its
    // Chinese name was mangled while decoding stderr. Other missing files may
    // be dependencies: do not infer their state from an unrelated source.
    const source = context.source?.trim()
    const sourceFailure = source && (
      (clickMissing && /Invalid value for ['"]DIRECTORY['"]/i.test(output))
      || output.includes(source) || output.includes(source.replace(/\\/g, '\\\\'))
    )
    const pathEvidence = sourceFailure ? inspectAnalysisSource(source) : undefined
    if (pathEvidence?.ordinary === 'too_long'
      || (pathEvidence?.windowsPath && pathEvidence.extended === 'file'
        && pathEvidence.ordinary === 'missing')) {
      return { category: 'path_too_long', message: '素材文件仍在本机，但普通路径无法访问、扩展路径可以访问；请更新引擎，或将素材移到较短目录后重新选择并分析', pathEvidence }
    }
    if (pathEvidence?.ordinary === 'denied' || pathEvidence?.extended === 'denied') {
      return { category: 'file_access_denied', message: '素材文件的访问被拒绝，请确认当前用户有读取权限并检查安全软件的拦截记录后重试', pathEvidence }
    }
    if (pathEvidence?.ordinary === 'file' || pathEvidence?.extended === 'file') {
      const detail = pathEvidence.windowsPath && pathEvidence.pathLength >= 260
        ? `当前路径有 ${pathEvidence.pathLength} 个字符，可先将素材移到较短目录后重新选择并分析`
        : '请检查文件路径和引擎版本，重新选择素材后重试'
      return { category: 'file_path_access', message: `已确认素材文件在本机存在，但分析引擎无法访问该路径；${detail}`, pathEvidence }
    }
    if (pathEvidence?.ordinary === 'not_file' || pathEvidence?.extended === 'not_file') {
      return { category: 'file_path_access', message: '素材路径指向的不是视频文件，请重新选择实际的视频文件后分析', pathEvidence }
    }
    return { category: 'file_missing', message: '分析引擎未找到所需文件，请检查素材和引擎文件的位置；素材如已移动或删除，请重新选择或导入', ...(pathEvidence ? { pathEvidence } : {}) }
  }
  if (/timed?\s*out|timeout/i.test(diagnostic) || status === '504') return { category: 'timeout', message: '素材分析请求超时，请稍后重试；详细日志中可查看超时位置' }
  if (/\bDASHSCOPE_API_KEY\b["']?\s+is not set\b/i.test(diagnostic)) return { category: 'authentication', message: '模型服务授权未就绪，请重新登录或检查服务配置后重试' }
  if (/unauthorized|forbidden|invalid.?api.?key/i.test(diagnostic) || status === '401' || status === '403') return { category: 'authentication', message: '模型服务鉴权失败，请检查账号授权或服务配置' }
  if (/quota|rate.?limit|throttl|insufficient.?balance/i.test(diagnostic) || status === '429') return { category: 'quota', message: '模型服务限流或额度不足，请稍后重试或检查额度' }
  if (/SSL|TLS|ConnectionError|ConnectionReset|connection (?:reset|refused|aborted)|getaddrinfo|NameResolution|RemoteDisconnected|Unexpected.*EOF/i.test(diagnostic)) return { category: 'connection', message: '连接模型服务失败，请检查网络或代理后重试' }
  if (/decode|invalid data|unsupported|InvalidVideo|InvalidImage/i.test(diagnostic)) return { category: 'media', message: '素材格式或编码无法处理，请检查视频文件或转换格式' }
  if (status || /DashScopeAPIError|HTTPError|InvalidParameter|InternalError/i.test(diagnostic)) return { category: 'model_response', message: `模型服务返回错误${responseLabel}，请查看诊断日志中的错误信息` }
  return { category: 'unknown', message: '素材分析异常退出，具体原因尚未分类，请查看诊断日志' }
}

export function recordAnalysisFailure(dataRoot: string, input: {
  source: string; startedAt: string; command: string; args: string[];
  code: number | null; stdout: string; stderr: string; runtimeMissing?: boolean
}) {
  const failure = classifyAnalysisFailure(`${input.stderr}\n${input.stdout}`, input.runtimeMissing, { source: input.source })
  const id = randomUUID()
  const logPath = path.join(dataRoot, 'logs', 'material-analysis', `${id}.json`)
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, JSON.stringify({
      id, ...input, ...failure, finishedAt: new Date().toISOString(),
      command: redactAnalysisOutput(input.command), args: input.args.map(redactAnalysisOutput),
      stdout: redactAnalysisOutput(input.stdout), stderr: redactAnalysisOutput(input.stderr),
      durationMs: Date.now() - Date.parse(input.startedAt),
    }, null, 2), 'utf8')
    return `${failure.message}。诊断日志：${logPath}`
  } catch {
    return `${failure.message}。诊断日志写入失败，请检查工作目录权限或磁盘空间`
  }
}

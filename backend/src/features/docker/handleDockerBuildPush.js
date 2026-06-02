const { spawn } = require('child_process')
const path = require('path')

const buildPushState = {
  running: false,
  log: '',
  error: null,
  image: null,
}

function appendBuildPushLog(text) {
  buildPushState.log += String(text || '')
}

function runDockerCommand(args, cwd, onChunk) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd,
      windowsHide: true,
      shell: false,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      const part = String(chunk || '')
      stdout += part
      if (onChunk) onChunk(part)
    })

    child.stderr.on('data', (chunk) => {
      const part = String(chunk || '')
      stderr += part
      if (onChunk) onChunk(part)
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const error = new Error(`Docker command failed with exit code ${code}`)
      error.stdout = stdout
      error.stderr = stderr
      error.exitCode = code
      reject(error)
    })
  })
}

async function runBuildPushJob(payload) {
  const image = String(payload?.image || 'levkaster/saitplayerok').trim()
  const contextPath = String(payload?.contextPath || '.').trim() || '.'
  const dockerfilePath = String(payload?.dockerfilePath || '').trim()
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
  const resolvedContextPath = path.resolve(repoRoot, contextPath)

  const buildArgs = ['build', '-t', image]
  if (dockerfilePath) {
    buildArgs.push('-f', dockerfilePath)
  }
  buildArgs.push(resolvedContextPath)

  buildPushState.running = true
  buildPushState.log = ''
  buildPushState.error = null
  buildPushState.image = null

  try {
    appendBuildPushLog('=== docker build ===\n')
    await runDockerCommand(buildArgs, repoRoot, appendBuildPushLog)

    appendBuildPushLog('\n=== docker push ===\n')
    await runDockerCommand(['push', image], repoRoot, appendBuildPushLog)

    buildPushState.image = image
    appendBuildPushLog(`\nГотово: ${image}\n`)
  } catch (error) {
    buildPushState.error =
      error instanceof Error ? error.message : 'Docker command failed'
    const extra = [error?.stdout, error?.stderr].filter(Boolean).join('\n')
    if (extra) appendBuildPushLog(`\n${extra}\n`)
  } finally {
    buildPushState.running = false
  }
}

function getDockerBuildPushStatus() {
  return {
    ok: true,
    running: buildPushState.running,
    log: buildPushState.log,
    error: buildPushState.error,
    image: buildPushState.image,
    success: !buildPushState.running && Boolean(buildPushState.image) && !buildPushState.error,
  }
}

async function handleDockerBuildPush({ payload }) {
  if (buildPushState.running) {
    return {
      statusCode: 409,
      data: {
        ok: false,
        running: true,
        error: 'Уже выполняется docker build/push. Дождитесь завершения.',
        log: buildPushState.log,
      },
    }
  }

  runBuildPushJob(payload || {}).catch(() => {})

  return {
    statusCode: 202,
    data: {
      ok: true,
      started: true,
      running: true,
    },
  }
}

module.exports = {
  handleDockerBuildPush,
  getDockerBuildPushStatus,
}

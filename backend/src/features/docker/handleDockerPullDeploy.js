const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

let dockerDeployTaskRunning = false

function runDeployScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], {
      windowsHide: true,
      shell: false,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '')
    })

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const error = new Error(`Deploy script failed with exit code ${code}`)
      error.stdout = stdout
      error.stderr = stderr
      error.exitCode = code
      reject(error)
    })
  })
}

function resolveDeployScriptPath() {
  const fromEnv = String(process.env.DEPLOY_SCRIPT_PATH || '').trim()
  const candidates = [
    fromEnv,
    '/opt/sait/deploy.sh',
    path.resolve(__dirname, '..', '..', '..', '..', 'deploy.sh'),
    path.resolve(process.cwd(), '..', 'deploy.sh'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  return null
}

function collectDeployScriptCandidates() {
  const fromEnv = String(process.env.DEPLOY_SCRIPT_PATH || '').trim()
  return [
    fromEnv,
    '/opt/sait/deploy.sh',
    path.resolve(__dirname, '..', '..', '..', '..', 'deploy.sh'),
    path.resolve(process.cwd(), '..', 'deploy.sh'),
  ].filter(Boolean)
}

async function handleDockerPullDeploy() {
  if (dockerDeployTaskRunning) {
    return {
      statusCode: 409,
      data: {
        ok: false,
        error: 'Deploy уже выполняется. Дождитесь завершения.',
      },
    }
  }

  dockerDeployTaskRunning = true
  try {
    const scriptPath = resolveDeployScriptPath()
    if (!scriptPath) {
      const checkedPaths = collectDeployScriptCandidates()
      return {
        statusCode: 500,
        data: {
          ok: false,
          error: 'Deploy script not found',
          checkedPaths,
          cwd: process.cwd(),
          stdout: '',
          stderr: '',
        },
      }
    }

    const result = await runDeployScript(scriptPath)
    return {
      statusCode: 200,
      data: {
        ok: true,
        scriptPath,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    }
  } catch (error) {
    return {
      statusCode: 500,
      data: {
        ok: false,
        error: error instanceof Error ? error.message : 'Deploy failed',
        stdout: error?.stdout || '',
        stderr: error?.stderr || '',
      },
    }
  } finally {
    dockerDeployTaskRunning = false
  }
}

module.exports = { handleDockerPullDeploy }

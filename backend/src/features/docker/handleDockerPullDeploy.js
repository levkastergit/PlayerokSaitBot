const { spawn } = require('child_process')
const path = require('path')

// Имя detached-контейнера, который выполняет обновление. Он переживает
// пересоздание sait-app-1, поэтому деплой не убивает сам себя.
const SELF_UPDATE_CONTAINER = 'sait-self-update'
// Образ с Docker Compose v2 на борту. У образа приложения только compose v1
// (другое имя проекта → создал бы дубль sait_app_1), поэтому берём docker:cli.
const DEPLOY_HELPER_IMAGE = 'docker:cli'

function resolveSaitDir() {
  const fromEnv = String(process.env.SAIT_DIR || '').trim()
  if (fromEnv) return fromEnv
  const deployScript = String(process.env.DEPLOY_SCRIPT_PATH || '').trim()
  if (deployScript) return path.posix.dirname(deployScript)
  return '/opt/sait'
}

function resolveComposeProject() {
  return String(process.env.COMPOSE_PROJECT_NAME || '').trim() || 'sait'
}

function runDocker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '')
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const error = new Error(`docker exited with code ${code}`)
      error.stdout = stdout
      error.stderr = stderr
      error.exitCode = code
      reject(error)
    })
  })
}

async function isSelfUpdateRunning() {
  try {
    const { stdout } = await runDocker([
      'ps',
      '-q',
      '--filter',
      `name=^${SELF_UPDATE_CONTAINER}$`,
    ])
    return Boolean(stdout.trim())
  } catch (_) {
    return false
  }
}

async function handleDockerPullDeploy() {
  if (await isSelfUpdateRunning()) {
    return {
      statusCode: 409,
      data: {
        ok: false,
        error: 'Обновление уже выполняется. Дождитесь завершения.',
      },
    }
  }

  // На случай, если прошлый helper-контейнер не успел сам удалиться (--rm),
  // а демон был перезапущен — снимаем застрявшее имя, иначе docker run упадёт.
  await runDocker(['rm', '-f', SELF_UPDATE_CONTAINER]).catch(() => {})

  const saitDir = resolveSaitDir()
  const project = resolveComposeProject()
  // Тянем свежий образ и пересоздаём ТОЛЬКО сервис app. nginx (host-network)
  // не трогаем — он переживёт краткий рестарт app с 502 на пару секунд.
  const innerCommand =
    `docker compose -p ${project} pull app && ` +
    `docker compose -p ${project} up -d --force-recreate app`

  const runArgs = [
    'run',
    '-d',
    '--rm',
    '--name',
    SELF_UPDATE_CONTAINER,
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${saitDir}:${saitDir}`,
    '-w',
    saitDir,
    '--entrypoint',
    'sh',
    DEPLOY_HELPER_IMAGE,
    '-c',
    innerCommand,
  ]

  try {
    const { stdout } = await runDocker(runArgs)
    const containerId = stdout.trim()
    return {
      statusCode: 202,
      data: {
        ok: true,
        started: true,
        containerId,
        message: 'Обновление запущено: загружается новый образ и перезапускается приложение.',
      },
    }
  } catch (error) {
    return {
      statusCode: 500,
      data: {
        ok: false,
        error: error instanceof Error ? error.message : 'Не удалось запустить обновление',
        stdout: error?.stdout || '',
        stderr: error?.stderr || '',
      },
    }
  }
}

module.exports = { handleDockerPullDeploy }

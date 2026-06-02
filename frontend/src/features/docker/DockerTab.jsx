import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  dockerBuildAndPush,
  dockerPullAndDeploy,
  fetchDockerBuildPushStatus,
  fetchRuntimeActionsState,
  resumeRuntimeActions,
  stopRuntimeActions,
} from '../../services/dockerApi'

export function DockerTab() {
  const isLocalUi = useMemo(() => {
    const host = String(window?.location?.hostname || '').toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  }, [])

  const [buildRunning, setBuildRunning] = useState(false)
  const [deployRunning, setDeployRunning] = useState(false)
  const [changingActionsState, setChangingActionsState] = useState(false)
  const [actionsStopped, setActionsStopped] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [output, setOutput] = useState('')
  const pollTimerRef = useRef(null)

  const running = isLocalUi ? buildRunning : deployRunning

  const applyBuildStatus = useCallback((status) => {
    if (!status?.ok) return false

    if (status.running) {
      setBuildRunning(true)
      if (status.log) setOutput(status.log)
      return true
    }

    setBuildRunning(false)
    if (status.log) setOutput(status.log)

    if (status.success) {
      setError(null)
      setMessage(status.image ? `Готово: ${status.image}` : 'Готово')
      return false
    }

    if (status.error) {
      setMessage(null)
      setError(status.error)
    }
    return false
  }, [])

  const stopBuildPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const pollBuildStatus = useCallback(async () => {
    const status = await fetchDockerBuildPushStatus()
    const stillRunning = applyBuildStatus(status)
    if (stillRunning) {
      pollTimerRef.current = setTimeout(() => {
        pollBuildStatus()
      }, 1200)
    } else {
      stopBuildPolling()
    }
  }, [applyBuildStatus, stopBuildPolling])

  const startBuildPolling = useCallback(() => {
    stopBuildPolling()
    pollBuildStatus()
  }, [pollBuildStatus, stopBuildPolling])

  useEffect(() => {
    let cancelled = false
    fetchRuntimeActionsState().then((result) => {
      if (cancelled) return
      if (result.ok) setActionsStopped(Boolean(result.stopped))
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isLocalUi) return undefined

    let cancelled = false
    fetchDockerBuildPushStatus().then((status) => {
      if (cancelled) return
      if (status.running) {
        applyBuildStatus(status)
        startBuildPolling()
      }
    })

    return () => {
      cancelled = true
      stopBuildPolling()
    }
  }, [isLocalUi, applyBuildStatus, startBuildPolling, stopBuildPolling])

  const handleBuildPush = async (event) => {
    event.preventDefault()
    setMessage(null)
    setError(null)
    setOutput('Запуск docker build…\n')
    setBuildRunning(true)

    const result = await dockerBuildAndPush()

    if (result.running || result.started) {
      if (result.log) setOutput(result.log)
      startBuildPolling()
      return
    }

    setBuildRunning(false)
    if (!result.ok) {
      setError(result.error || 'Не удалось выполнить docker build/push')
      if (result.log) setOutput(result.log)
    }
  }

  const handlePullDeploy = async (event) => {
    event.preventDefault()
    setMessage(null)
    setError(null)
    setOutput('Запуск pull/deploy…\n')
    setDeployRunning(true)

    const result = await dockerPullAndDeploy()

    setDeployRunning(false)
    if (!result.ok) {
      setError(result.error || 'Не удалось выполнить pull/deploy')
      setOutput([result.stdout, result.stderr].filter(Boolean).join('\n\n'))
      return
    }

    setMessage('Готово: pull/deploy выполнен')
    setOutput([
      '=== DEPLOY STDOUT ===',
      result.stdout || '',
      '=== DEPLOY STDERR ===',
      result.stderr || '',
    ].join('\n'))
  }

  const handleStopActions = async () => {
    setChangingActionsState(true)
    setMessage(null)
    setError(null)
    const result = await stopRuntimeActions()
    setChangingActionsState(false)
    if (!result.ok) {
      setError(result.error || 'Не удалось остановить фоновые действия')
      return
    }
    setActionsStopped(true)
    setMessage('Фоновые действия на сервере остановлены')
  }

  const handleResumeActions = async () => {
    setChangingActionsState(true)
    setMessage(null)
    setError(null)
    const result = await resumeRuntimeActions()
    setChangingActionsState(false)
    if (!result.ok) {
      setError(result.error || 'Не удалось запустить фоновые действия')
      return
    }
    setActionsStopped(false)
    setMessage('Фоновые действия на сервере запущены')
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Docker</h1>
      </div>

      <div className="tab-grid">
        <section className="card docker-card" style={{ gridColumn: '1 / -1' }}>
          <form className="settings-form" onSubmit={isLocalUi ? handleBuildPush : handlePullDeploy}>
            <div className="token-actions">
              <button type="submit" className="btn-primary" disabled={running || changingActionsState}>
                {running ? (isLocalUi ? 'Сборка и push…' : 'Pull и deploy…') : (isLocalUi ? 'Build и Push' : 'Pull и Deploy')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={changingActionsState || actionsStopped || running}
                onClick={handleStopActions}
              >
                {changingActionsState && !actionsStopped ? 'Останавливаем…' : 'Остановить все действия'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={changingActionsState || !actionsStopped || running}
                onClick={handleResumeActions}
              >
                {changingActionsState && actionsStopped ? 'Запускаем…' : 'Запустить все действия'}
              </button>
            </div>

            {message ? <p className="settings-message settings-message--success">{message}</p> : null}
            {error ? <p className="settings-message settings-message--error">{error}</p> : null}
          </form>

          <textarea
            className="input-theme docker-output"
            readOnly
            value={output}
            placeholder={isLocalUi ? 'Логи docker build/push появятся здесь' : 'Логи pull/deploy появятся здесь'}
          />
        </section>
      </div>
    </div>
  )
}

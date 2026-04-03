import React, { useEffect, useMemo, useState } from 'react'
import { fetchAuthMe } from '../../services/authApi'
import {
  connectToDirector,
  deletePartnerInvite,
  fetchDirectorsForWorker,
  fetchPartnersForOwner,
  invitePartner,
} from '../../services/partnersApi'

function connectStatusToText(connectStatus) {
  const s = Number(connectStatus)
  if (s === 1) return '1 (ожидает)'
  if (s === 2) return '2 (подключен)'
  return `${s || '—'}`
}

export function PartnersTab() {
  const [meLoading, setMeLoading] = useState(true)
  const [meError, setMeError] = useState(null)
  const [currentUserId, setCurrentUserId] = useState(null)
  const [currentLogin, setCurrentLogin] = useState(null)

  const [ownerPartnerId, setOwnerPartnerId] = useState('')
  const [ownerPartnerPassword, setOwnerPartnerPassword] = useState('')
  const [ownerMessage, setOwnerMessage] = useState(null)

  const [partnerOurId, setPartnerOurId] = useState('')
  const [partnerPassword, setPartnerPassword] = useState('')
  const [partnerMessage, setPartnerMessage] = useState(null)

  const [ownerPartnersLoading, setOwnerPartnersLoading] = useState(false)
  const [ownerPartnersError, setOwnerPartnersError] = useState(null)
  const [ownerPartners, setOwnerPartners] = useState([])

  const [workerDirectorsLoading, setWorkerDirectorsLoading] = useState(false)
  const [workerDirectorsError, setWorkerDirectorsError] = useState(null)
  const [workerDirectors, setWorkerDirectors] = useState([])

  useEffect(() => {
    let cancelled = false
    setMeLoading(true)
    setMeError(null)
    fetchAuthMe().then((r) => {
      if (cancelled) return
      if (!r?.ok) {
        setMeError(r?.error || 'Не удалось получить данные аккаунта')
        setCurrentUserId(null)
        setCurrentLogin(null)
        return
      }
      setCurrentUserId(typeof r.userId === 'number' ? r.userId : null)
      setCurrentLogin(r.login ?? null)
    }).catch((err) => {
      if (cancelled) return
      setMeError(err instanceof Error ? err.message : 'Ошибка сети')
    }).finally(() => {
      if (cancelled) return
      setMeLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const ownerId = currentUserId

  useEffect(() => {
    if (meLoading) return
    if (!currentUserId) {
      setOwnerPartners([])
      setWorkerDirectors([])
      return
    }

    let cancelled = false

    const reloadOwner = async () => {
      setOwnerPartnersLoading(true)
      setOwnerPartnersError(null)
      try {
        const data = await fetchPartnersForOwner()
        if (cancelled) return
        setOwnerPartners(Array.isArray(data?.list) ? data.list : [])
      } catch (err) {
        if (cancelled) return
        setOwnerPartnersError(err instanceof Error ? err.message : 'Ошибка загрузки')
        setOwnerPartners([])
      } finally {
        if (!cancelled) setOwnerPartnersLoading(false)
      }
    }

    const reloadWorker = async () => {
      setWorkerDirectorsLoading(true)
      setWorkerDirectorsError(null)
      try {
        const data = await fetchDirectorsForWorker()
        if (cancelled) return
        setWorkerDirectors(Array.isArray(data?.list) ? data.list : [])
      } catch (err) {
        if (cancelled) return
        setWorkerDirectorsError(err instanceof Error ? err.message : 'Ошибка загрузки')
        setWorkerDirectors([])
      } finally {
        if (!cancelled) setWorkerDirectorsLoading(false)
      }
    }

    void reloadOwner()
    void reloadWorker()

    return () => { cancelled = true }
  }, [currentUserId, meLoading])

  const handleOwnerAdd = async (e) => {
    e.preventDefault()
    setOwnerMessage(null)

    if (!currentUserId) {
      setOwnerMessage('Сначала нужно дождаться загрузки данных аккаунта владельца.')
      return
    }

    const partnerIdNum = Number(ownerPartnerId)
    const password = String(ownerPartnerPassword || '')
    if (!Number.isFinite(partnerIdNum) || String(ownerPartnerId).trim() === '') {
      setOwnerMessage('Введите корректный ID напарника.')
      return
    }
    if (!password) {
      setOwnerMessage('Введите пароль для напарника.')
      return
    }

    try {
      await invitePartner(partnerIdNum, password)
      setOwnerPartnerId('')
      setOwnerPartnerPassword('')
      setOwnerMessage('Напарник добавлен')
      const data = await fetchPartnersForOwner()
      setOwnerPartners(Array.isArray(data?.list) ? data.list : [])
      const dataWorker = await fetchDirectorsForWorker()
      setWorkerDirectors(Array.isArray(dataWorker?.list) ? dataWorker.list : [])
    } catch (err) {
      setOwnerMessage(err instanceof Error ? err.message : 'Ошибка добавления')
    }
  }

  const handleOwnerDelete = async (partnerIdToDelete) => {
    if (!currentUserId) return
    try {
      await deletePartnerInvite(partnerIdToDelete)
      const data = await fetchPartnersForOwner()
      setOwnerPartners(Array.isArray(data?.list) ? data.list : [])
    } catch (err) {
      setOwnerMessage(err instanceof Error ? err.message : 'Ошибка удаления')
    }
  }

  const handlePartnerLogin = async (e) => {
    e.preventDefault()
    setPartnerMessage(null)

    if (!currentUserId) {
      setPartnerMessage('Не удалось определить ваш аккаунт.')
      return
    }

    const directorIdNum = Number(partnerOurId)
    const password = String(partnerPassword || '')
    if (!Number.isFinite(directorIdNum) || String(partnerOurId).trim() === '') {
      setPartnerMessage('Введите корректный ID владельца аккаунта.')
      return
    }
    if (!password) {
      setPartnerMessage('Введите пароль, который вам дали.')
      return
    }

    try {
      await connectToDirector({ ownerId: directorIdNum, password })
      setPartnerMessage('Подключение подтверждено')
      setPartnerPassword('')
      const data = await fetchPartnersForOwner()
      setOwnerPartners(Array.isArray(data?.list) ? data.list : [])
      const dataWorker = await fetchDirectorsForWorker()
      setWorkerDirectors(Array.isArray(dataWorker?.list) ? dataWorker.list : [])
    } catch (err) {
      setPartnerMessage(err instanceof Error ? err.message : 'Ошибка подключения')
    }
  }

  return (
    <div className="tab-page tab-page--partners">
      <div className="tab-page-header">
        <h1>Напарники</h1>
      </div>

      <div className="tab-grid">
        <section className="card">
          <h2 className="card-title">Настройка владельца</h2>

          {meLoading && <p className="card-text">Загрузка данных аккаунта…</p>}
          {!meLoading && meError && <p className="card-text card-text--error">{meError}</p>}

          {!meLoading && !meError && (
            <>
              <p className="card-text">
                Ваш ID аккаунта: <strong>{ownerId ?? '—'}</strong>
                {currentLogin ? <span style={{ color: 'var(--text-muted)' }}> ({currentLogin})</span> : null}
              </p>

              <form onSubmit={handleOwnerAdd}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }}>
                  <label className="field">
                    <span className="field-label">ID напарника</span>
                    <input
                      className="input-theme"
                      value={ownerPartnerId}
                      onChange={(e) => setOwnerPartnerId(e.target.value)}
                      placeholder="например, 123"
                      inputMode="numeric"
                    />
                  </label>

                  <label className="field">
                    <span className="field-label">Пароль для напарника</span>
                    <input
                      className="input-theme"
                      type="password"
                      value={ownerPartnerPassword}
                      onChange={(e) => setOwnerPartnerPassword(e.target.value)}
                      placeholder="задайте пароль"
                    />
                  </label>

                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <button type="submit" className="btn-primary">
                      Добавить
                    </button>
                    {ownerMessage && (
                      <span className="card-text" style={{ fontSize: '0.9rem' }}>
                        {ownerMessage}
                      </span>
                    )}
                  </div>
                </div>
              </form>

              <div style={{ marginTop: '1rem' }}>
                <p className="card-text" style={{ marginBottom: '0.6rem' }}>
                  <strong>Коннект</strong>: 1 — приглашение не подтверждено, 2 — подтверждено.
                </p>

                <div className="history-table-wrap">
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th>ID напарника</th>
                        <th>Роль</th>
                        <th>Коннект</th>
                        <th>Пароль</th>
                        <th>Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ownerPartnersLoading && (
                        <tr>
                          <td colSpan={5}>
                            <span className="card-text" style={{ display: 'inline-block' }}>Загрузка…</span>
                          </td>
                        </tr>
                      )}

                      {!ownerPartnersLoading && ownerPartnersError && (
                        <tr>
                          <td colSpan={5}>
                            <span className="card-text card-text--error" style={{ display: 'inline-block' }}>{ownerPartnersError}</span>
                          </td>
                        </tr>
                      )}

                      {!ownerPartnersLoading && !ownerPartnersError && ownerPartners.length === 0 && (
                        <tr>
                          <td colSpan={5}>
                            <span className="card-text" style={{ display: 'inline-block' }}>
                              Пока список напарников пуст.
                            </span>
                          </td>
                        </tr>
                      )}

                      {ownerPartners.map((p) => (
                        <tr key={p.partnerId}>
                          <td>{p.partnerId}</td>
                          <td>Работник</td>
                          <td>{connectStatusToText(p.connectStatus)}</td>
                          <td className="history-table__time">установлен</td>
                          <td>
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => handleOwnerDelete(p.partnerId)}
                            >
                              Удалить
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </section>

        <section className="card">
          <h2 className="card-title">Вход напарника</h2>

          {meLoading && <p className="card-text">Загрузка данных аккаунта…</p>}
          {!meLoading && meError && <p className="card-text card-text--error">{meError}</p>}

          {!meLoading && !meError && (
            <>
              <p className="card-text" style={{ marginBottom: '0.75rem' }}>
                Напарник вводит <strong>ID владельца</strong> и пароль, который ему дали.
              </p>

              <form onSubmit={handlePartnerLogin}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.25rem' }}>
                  <label className="field">
                    <span className="field-label">ID владельца аккаунта</span>
                    <input
                      className="input-theme"
                      value={partnerOurId}
                      onChange={(e) => setPartnerOurId(e.target.value)}
                      placeholder="например, 123"
                      inputMode="numeric"
                    />
                  </label>

                  <label className="field">
                    <span className="field-label">Пароль</span>
                    <input
                      className="input-theme"
                      type="password"
                      value={partnerPassword}
                      onChange={(e) => setPartnerPassword(e.target.value)}
                      placeholder="пароль, который вам дали"
                    />
                  </label>

                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <button type="submit" className="btn-primary">
                      Подключиться
                    </button>
                    {partnerMessage && (
                      <span className={`card-text ${partnerMessage.startsWith('Не') ? 'card-text--error' : ''}`} style={{ fontSize: '0.9rem' }}>
                        {partnerMessage}
                      </span>
                    )}
                  </div>
                </div>
              </form>

              <div style={{ marginTop: '1rem' }}>
                <div className="history-table-wrap">
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th>ID директора</th>
                        <th>Роль</th>
                        <th>Коннект</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workerDirectorsLoading && (
                        <tr>
                          <td colSpan={3}>
                            <span className="card-text" style={{ display: 'inline-block' }}>Загрузка…</span>
                          </td>
                        </tr>
                      )}

                      {!workerDirectorsLoading && workerDirectorsError && (
                        <tr>
                          <td colSpan={3}>
                            <span className="card-text card-text--error" style={{ display: 'inline-block' }}>{workerDirectorsError}</span>
                          </td>
                        </tr>
                      )}

                      {!workerDirectorsLoading && !workerDirectorsError && workerDirectors.length === 0 && (
                        <tr>
                          <td colSpan={3}>
                            <span className="card-text" style={{ display: 'inline-block' }}>
                              Пока нет директорів для подключения.
                            </span>
                          </td>
                        </tr>
                      )}

                      {workerDirectors.map((d) => (
                        <tr key={d.directorId}>
                          <td>{d.directorId}</td>
                          <td>Директор</td>
                          <td>{connectStatusToText(d.connectStatus)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}


import { useEffect, useRef, useState } from 'react'
import {
  addTableCode,
  addTableCodes,
  createTableColumn,
  createTableSubtab,
  createTableTab,
  deleteTableCode,
  deleteTableColumn,
  deleteTableSubtab,
  deleteTableTab,
  fetchTableCodes,
  fetchTableColumns,
  fetchTableTabs,
  renameTableColumn,
  renameTableSubtab,
  updateTableCodeCellValue,
  updateTableCodeUsed,
} from '../../services/playerokApi'

const HOVER_DELETE_MS = 5000
const TABLE_FIXED_COL_COUNT = 8
const DEFAULT_TABLE_FILTERS = { dateFrom: '', dateTo: '', used: 'all' }

function parseCodesFromInput(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

const CODE_STATUS_FILTER_VALUES = new Set(['yes', 'no', 'pending'])

// Трёхзначный статус кода с откатом на старое булево поле used.
function codeStatusOf(code) {
  if (code && typeof code.status === 'string' && code.status) return code.status
  return code && code.used ? 'used' : 'unused'
}

function getSubtabFilters(filtersBySubtab, subtabId) {
  if (!subtabId) return DEFAULT_TABLE_FILTERS
  const stored = filtersBySubtab[subtabId]
  if (!stored || typeof stored !== 'object') return DEFAULT_TABLE_FILTERS
  return {
    dateFrom: typeof stored.dateFrom === 'string' ? stored.dateFrom : '',
    dateTo: typeof stored.dateTo === 'string' ? stored.dateTo : '',
    used: CODE_STATUS_FILTER_VALUES.has(stored.used) ? stored.used : 'all',
  }
}

function dateInputToDayStartSec(dateStr) {
  const value = String(dateStr || '').trim()
  if (!value) return null
  const date = new Date(value + 'T00:00:00')
  const ms = date.getTime()
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / 1000)
}

function dateInputToDayEndSec(dateStr) {
  const value = String(dateStr || '').trim()
  if (!value) return null
  const date = new Date(value + 'T23:59:59')
  const ms = date.getTime()
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / 1000)
}

function codeMatchesFilters(code, filters) {
  const status = codeStatusOf(code)
  if (filters.used === 'yes' && status !== 'used') return false
  if (filters.used === 'pending' && status !== 'pending') return false
  if (filters.used === 'no' && status !== 'unused') return false

  const fromSec = dateInputToDayStartSec(filters.dateFrom)
  const toSec = dateInputToDayEndSec(filters.dateTo)
  if (fromSec == null && toSec == null) return true

  const createdAt = Number(code.createdAt)
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false
  if (fromSec != null && createdAt < fromSec) return false
  if (toSec != null && createdAt > toSec) return false
  return true
}

export function TableTab() {
  const [tabs, setTabs] = useState([])
  const [activeTabId, setActiveTabId] = useState(null)
  const [activeSubtabId, setActiveSubtabId] = useState(null)
  const [codeInput, setCodeInput] = useState('')
  const [codesBySubtab, setCodesBySubtab] = useState({})
  const [columnsBySubtab, setColumnsBySubtab] = useState({})
  const [filtersBySubtab, setFiltersBySubtab] = useState({})

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [updatingCodeId, setUpdatingCodeId] = useState(null)
  const [deletingCodeId, setDeletingCodeId] = useState(null)
  const [copyState, setCopyState] = useState({ id: null, status: '', x: 0, y: 0 })
  const [isCreatingTab, setIsCreatingTab] = useState(false)
  const [isCreatingSubtab, setIsCreatingSubtab] = useState(false)
  const [renamingSubtabId, setRenamingSubtabId] = useState(null)
  const [renamingSubtabName, setRenamingSubtabName] = useState('')
  const [deleteHoverHint, setDeleteHoverHint] = useState(null)
  const [deletingTabId, setDeletingTabId] = useState(null)
  const [deletingSubtabId, setDeletingSubtabId] = useState(null)
  const [renamingColumnId, setRenamingColumnId] = useState(null)
  const [renamingColumnName, setRenamingColumnName] = useState('')
  const [isCreatingColumn, setIsCreatingColumn] = useState(false)
  const [deletingColumnId, setDeletingColumnId] = useState(null)
  const [savingCellKey, setSavingCellKey] = useState(null)
  const deleteHoverTimerRef = useRef(null)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null
  const activeSubtabs = Array.isArray(activeTab?.subtabs) ? activeTab.subtabs : []
  const activeCodes = Array.isArray(codesBySubtab[activeSubtabId]) ? codesBySubtab[activeSubtabId] : []
  const activeColumns = Array.isArray(columnsBySubtab[activeSubtabId]) ? columnsBySubtab[activeSubtabId] : []
  const activeFilters = getSubtabFilters(filtersBySubtab, activeSubtabId)
  const filteredCodes = activeCodes.filter((code) => codeMatchesFilters(code, activeFilters))
  const tableColSpan = TABLE_FIXED_COL_COUNT + activeColumns.length + 2

  const setActiveSubtabFilter = (patch) => {
    if (!activeSubtabId) return
    setFiltersBySubtab((prev) => ({
      ...prev,
      [activeSubtabId]: { ...getSubtabFilters(prev, activeSubtabId), ...patch },
    }))
  }

  useEffect(() => {
    return () => {
      if (deleteHoverTimerRef.current) clearTimeout(deleteHoverTimerRef.current)
    }
  }, [])

  const clearDeleteHoverHint = () => {
    if (deleteHoverTimerRef.current) {
      clearTimeout(deleteHoverTimerRef.current)
      deleteHoverTimerRef.current = null
    }
    setDeleteHoverHint(null)
  }

  const scheduleDeleteHoverHint = (kind, id) => {
    if (deleteHoverTimerRef.current) clearTimeout(deleteHoverTimerRef.current)
    deleteHoverTimerRef.current = setTimeout(() => {
      setDeleteHoverHint({ kind, id })
      deleteHoverTimerRef.current = null
    }, HOVER_DELETE_MS)
  }

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError('')
    fetchTableTabs()
      .then((data) => {
        if (cancelled) return
        const list = Array.isArray(data.list) ? data.list : []
        setTabs(list)
        const firstTab = list[0] || null
        const nextTabId = firstTab ? firstTab.id : null
        const nextSubtabId = firstTab && firstTab.subtabs && firstTab.subtabs[0] ? firstTab.subtabs[0].id : null
        setActiveTabId(nextTabId)
        setActiveSubtabId(nextSubtabId)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Ошибка загрузки вкладок')
      })
      .finally(() => {
        if (cancelled) return
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (activeSubtabs.length === 0) {
      setActiveSubtabId(null)
      return
    }
    if (!activeSubtabs.some((subtab) => subtab.id === activeSubtabId)) {
      setActiveSubtabId(activeSubtabs[0].id)
    }
  }, [activeSubtabs, activeSubtabId])

  useEffect(() => {
    if (!activeSubtabId) return
    const needCodes = !Array.isArray(codesBySubtab[activeSubtabId])
    const needColumns = !Array.isArray(columnsBySubtab[activeSubtabId])
    if (!needCodes && !needColumns) return
    let cancelled = false
    setIsLoading(true)
    setError('')

    Promise.all([
      needCodes ? fetchTableCodes(activeSubtabId) : Promise.resolve(null),
      needColumns ? fetchTableColumns(activeSubtabId) : Promise.resolve(null),
    ])
      .then(([codesData, columnsData]) => {
        if (cancelled) return
        if (codesData) {
          setCodesBySubtab((prev) => ({
            ...prev,
            [activeSubtabId]: Array.isArray(codesData.list) ? codesData.list : [],
          }))
        }
        if (columnsData) {
          setColumnsBySubtab((prev) => ({
            ...prev,
            [activeSubtabId]: Array.isArray(columnsData.list) ? columnsData.list : [],
          }))
        }
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Ошибка загрузки таблицы')
      })
      .finally(() => {
        if (cancelled) return
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeSubtabId, codesBySubtab, columnsBySubtab])

  const handleAddCode = async () => {
    const parsedCodes = parseCodesFromInput(codeInput)
    if (parsedCodes.length === 0 || isSaving || !activeSubtabId) return

    setIsSaving(true)
    setError('')
    try {
      if (parsedCodes.length === 1) {
        const nextCode = parsedCodes[0]
        const result = await addTableCode(activeSubtabId, nextCode)
        const item = result?.item && typeof result.item === 'object'
          ? result.item
          : {
            id: Date.now(),
            code: nextCode,
            used: false,
            dealId: null,
            itemId: null,
            chatId: null,
            createdAt: Math.floor(Date.now() / 1000),
            customValues: {},
          }
        setCodesBySubtab((prev) => ({
          ...prev,
          [activeSubtabId]: [item, ...(Array.isArray(prev[activeSubtabId]) ? prev[activeSubtabId] : [])],
        }))
      } else {
        const result = await addTableCodes(activeSubtabId, parsedCodes)
        const items = Array.isArray(result.list) ? result.list : []
        const itemsNewestFirst = [...items].reverse()
        setCodesBySubtab((prev) => ({
          ...prev,
          [activeSubtabId]: [
            ...itemsNewestFirst,
            ...(Array.isArray(prev[activeSubtabId]) ? prev[activeSubtabId] : []),
          ],
        }))
      }
      setCodeInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка добавления кода')
    } finally {
      setIsSaving(false)
    }
  }

  const handleUsedChange = async (codeId, nextStatus) => {
    if (!codeId) return
    setUpdatingCodeId(codeId)
    setError('')
    try {
      const result = await updateTableCodeUsed(codeId, nextStatus)
      const nextStatusChangedAt =
        result && typeof result.statusChangedAt === 'number'
          ? result.statusChangedAt
          : Math.floor(Date.now() / 1000)
      setCodesBySubtab((prev) => ({
        ...prev,
        [activeSubtabId]: (Array.isArray(prev[activeSubtabId]) ? prev[activeSubtabId] : []).map((item) =>
          item.id === codeId
            ? { ...item, status: nextStatus, used: nextStatus === 'used', statusChangedAt: nextStatusChangedAt }
            : item
        ),
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка обновления статуса')
    } finally {
      setUpdatingCodeId(null)
    }
  }

  const handleDeleteCode = async (codeId) => {
    if (!codeId) return
    const confirmed = window.confirm('Удалить эту строку?')
    if (!confirmed) return
    setDeletingCodeId(codeId)
    setError('')
    try {
      await deleteTableCode(codeId)
      setCodesBySubtab((prev) => ({
        ...prev,
        [activeSubtabId]: (Array.isArray(prev[activeSubtabId]) ? prev[activeSubtabId] : []).filter(
          (item) => item.id !== codeId
        ),
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления кода')
    } finally {
      setDeletingCodeId(null)
    }
  }

  const handleCreateTab = async () => {
    if (isCreatingTab) return
    const name = window.prompt('Название вкладки')
    const trimmedName = String(name || '').trim()
    if (!trimmedName) return
    setIsCreatingTab(true)
    setError('')
    try {
      const result = await createTableTab(trimmedName)
      const item = result?.item && typeof result.item === 'object'
        ? result.item
        : { id: Date.now(), name: trimmedName, createdAt: Math.floor(Date.now() / 1000) }
      setTabs((prev) => [...prev, { ...item, subtabs: [] }])
      setActiveTabId(item.id)
      setActiveSubtabId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания вкладки')
    } finally {
      setIsCreatingTab(false)
    }
  }

  const startRenameSubtab = (subtab) => {
    if (!subtab?.id) return
    setRenamingSubtabId(subtab.id)
    setRenamingSubtabName(subtab.name || '')
  }

  const cancelRenameSubtab = () => {
    setRenamingSubtabId(null)
    setRenamingSubtabName('')
  }

  const commitRenameSubtab = async (subtabId) => {
    const trimmedName = renamingSubtabName.trim()
    if (!subtabId) {
      cancelRenameSubtab()
      return
    }
    const subtab = activeSubtabs.find((item) => item.id === subtabId)
    if (!trimmedName || trimmedName === subtab?.name) {
      cancelRenameSubtab()
      return
    }
    setError('')
    try {
      await renameTableSubtab(subtabId, trimmedName)
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTabId
            ? {
                ...tab,
                subtabs: (Array.isArray(tab.subtabs) ? tab.subtabs : []).map((item) =>
                  item.id === subtabId ? { ...item, name: trimmedName } : item
                ),
              }
            : tab
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка переименования')
    } finally {
      cancelRenameSubtab()
    }
  }

  const handleDeleteTab = async (tab) => {
    if (!tab?.id || deletingTabId) return
    clearDeleteHoverHint()
    const confirmed = window.confirm(`Удалить «${tab.name}»?`)
    if (!confirmed) return
    const subtabIds = (Array.isArray(tab.subtabs) ? tab.subtabs : []).map((item) => item.id)
    setDeletingTabId(tab.id)
    setError('')
    try {
      await deleteTableTab(tab.id)
      setTabs((prev) => {
        const next = prev.filter((item) => item.id !== tab.id)
        if (activeTabId === tab.id) {
          const first = next[0] || null
          setActiveTabId(first ? first.id : null)
          setActiveSubtabId(first?.subtabs?.[0]?.id ?? null)
        }
        return next
      })
      if (subtabIds.length > 0) {
        setCodesBySubtab((prev) => {
          const next = { ...prev }
          for (const subtabId of subtabIds) delete next[subtabId]
          return next
        })
        setColumnsBySubtab((prev) => {
          const next = { ...prev }
          for (const subtabId of subtabIds) delete next[subtabId]
          return next
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления вкладки')
    } finally {
      setDeletingTabId(null)
    }
  }

  const handleDeleteSubtab = async (subtab) => {
    if (!subtab?.id || deletingSubtabId) return
    clearDeleteHoverHint()
    const confirmed = window.confirm(`Удалить «${subtab.name}»?`)
    if (!confirmed) return
    setDeletingSubtabId(subtab.id)
    setError('')
    try {
      await deleteTableSubtab(subtab.id)
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTabId
            ? {
                ...tab,
                subtabs: (Array.isArray(tab.subtabs) ? tab.subtabs : []).filter((item) => item.id !== subtab.id),
              }
            : tab
        )
      )
      setCodesBySubtab((prev) => {
        const next = { ...prev }
        delete next[subtab.id]
        return next
      })
      setColumnsBySubtab((prev) => {
        const next = { ...prev }
        delete next[subtab.id]
        return next
      })
      if (activeSubtabId === subtab.id) {
        const remaining = activeSubtabs.filter((item) => item.id !== subtab.id)
        setActiveSubtabId(remaining[0]?.id ?? null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления таблицы')
    } finally {
      setDeletingSubtabId(null)
    }
  }

  const startRenameColumn = (column) => {
    if (!column?.id) return
    setRenamingColumnId(column.id)
    setRenamingColumnName(column.name || '')
  }

  const cancelRenameColumn = () => {
    setRenamingColumnId(null)
    setRenamingColumnName('')
  }

  const commitRenameColumn = async (columnId) => {
    const trimmedName = renamingColumnName.trim()
    if (!columnId) {
      cancelRenameColumn()
      return
    }
    const column = activeColumns.find((item) => item.id === columnId)
    if (!trimmedName || trimmedName === column?.name) {
      cancelRenameColumn()
      return
    }
    setError('')
    try {
      await renameTableColumn(columnId, trimmedName)
      setColumnsBySubtab((prev) => ({
        ...prev,
        [activeSubtabId]: (Array.isArray(prev[activeSubtabId]) ? prev[activeSubtabId] : []).map((item) =>
          item.id === columnId ? { ...item, name: trimmedName } : item
        ),
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка переименования столбца')
    } finally {
      cancelRenameColumn()
    }
  }

  const handleCreateColumn = async () => {
    if (isCreatingColumn || !activeSubtabId) return
    const name = window.prompt('Название столбца')
    const trimmedName = String(name || '').trim()
    if (!trimmedName) return
    setIsCreatingColumn(true)
    setError('')
    try {
      const result = await createTableColumn(activeSubtabId, trimmedName)
      const item = result?.item && typeof result.item === 'object'
        ? result.item
        : { id: Date.now(), name: trimmedName, sortOrder: 0, createdAt: Math.floor(Date.now() / 1000) }
      setColumnsBySubtab((prev) => ({
        ...prev,
        [activeSubtabId]: [...(Array.isArray(prev[activeSubtabId]) ? prev[activeSubtabId] : []), item],
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания столбца')
    } finally {
      setIsCreatingColumn(false)
    }
  }

  const handleDeleteColumn = async (column) => {
    if (!column?.id || deletingColumnId) return
    clearDeleteHoverHint()
    const confirmed = window.confirm(`Удалить столбец «${column.name}»?`)
    if (!confirmed) return
    setDeletingColumnId(column.id)
    setError('')
    try {
      await deleteTableColumn(column.id)
      setColumnsBySubtab((prev) => ({
        ...prev,
        [activeSubtabId]: (Array.isArray(prev[activeSubtabId]) ? prev[activeSubtabId] : []).filter(
          (item) => item.id !== column.id
        ),
      }))
      const columnKey = String(column.id)
      setCodesBySubtab((prev) => ({
        ...prev,
        [activeSubtabId]: (Array.isArray(prev[activeSubtabId]) ? prev[activeSubtabId] : []).map((code) => {
          if (!code.customValues || !Object.prototype.hasOwnProperty.call(code.customValues, columnKey)) return code
          const nextValues = { ...code.customValues }
          delete nextValues[columnKey]
          return { ...code, customValues: nextValues }
        }),
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления столбца')
    } finally {
      setDeletingColumnId(null)
    }
  }

  const getCustomCellValue = (code, columnId) => {
    const values = code?.customValues && typeof code.customValues === 'object' ? code.customValues : {}
    return values[String(columnId)] ?? ''
  }

  const handleCustomCellChange = (codeId, columnId, value) => {
    const columnKey = String(columnId)
    setCodesBySubtab((prev) => ({
      ...prev,
      [activeSubtabId]: (Array.isArray(prev[activeSubtabId]) ? prev[activeSubtabId] : []).map((code) =>
        code.id === codeId
          ? {
              ...code,
              customValues: {
                ...(code.customValues && typeof code.customValues === 'object' ? code.customValues : {}),
                [columnKey]: value,
              },
            }
          : code
      ),
    }))
  }

  const handleCustomCellBlur = async (codeId, columnId, value) => {
    if (!codeId || !columnId) return
    const cellKey = String(codeId) + '-' + String(columnId)
    setSavingCellKey(cellKey)
    setError('')
    try {
      await updateTableCodeCellValue(codeId, columnId, value)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения ячейки')
    } finally {
      setSavingCellKey((prev) => (prev === cellKey ? null : prev))
    }
  }

  const handleCreateSubtab = async () => {
    if (isCreatingSubtab || !activeTabId) return
    const name = window.prompt('Название таблицы')
    const trimmedName = String(name || '').trim()
    if (!trimmedName) return
    setIsCreatingSubtab(true)
    setError('')
    try {
      const result = await createTableSubtab(activeTabId, trimmedName)
      const item = result?.item && typeof result.item === 'object'
        ? result.item
        : { id: Date.now(), tabId: activeTabId, name: trimmedName, createdAt: Math.floor(Date.now() / 1000) }
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTabId
            ? { ...tab, subtabs: [...(Array.isArray(tab.subtabs) ? tab.subtabs : []), item] }
            : tab
        )
      )
      setActiveSubtabId(item.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания таблицы')
    } finally {
      setIsCreatingSubtab(false)
    }
  }

  const formatDateTime = (unixTs) => {
    const ts = Number(unixTs)
    if (!Number.isFinite(ts) || ts <= 0) return '—'
    try {
      return new Date(ts * 1000).toLocaleString('ru-RU')
    } catch (_) {
      return '—'
    }
  }

  const copyText = async (text) => {
    const value = String(text || '')
    if (!value) return false
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'absolute'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  }

  const handleCopyCode = async (event, codeId, codeText) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const hintX = rect.right + 10
    const hintY = rect.top + rect.height / 2
    try {
      const ok = await copyText(codeText)
      setCopyState({ id: codeId, status: ok ? 'ok' : 'error', x: hintX, y: hintY })
    } catch (_) {
      setCopyState({ id: codeId, status: 'error', x: hintX, y: hintY })
    } finally {
      setTimeout(() => {
        setCopyState((prev) => (prev.id === codeId ? { id: null, status: '', x: 0, y: 0 } : prev))
      }, 1400)
    }
  }

  return (
    <div className="tab-page">
      <header className="tab-page-header">
        <h1>Таблица</h1>
      </header>

      <div className="card">
        <div className="balance-hub__tabs" role="tablist">
          {tabs.map((tab) => (
            <span
              key={tab.id}
              className="table-tab-item-wrap"
              onMouseEnter={() => scheduleDeleteHoverHint('tab', tab.id)}
              onMouseLeave={clearDeleteHoverHint}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTabId === tab.id}
                className={'balance-hub__tab' + (activeTabId === tab.id ? ' balance-hub__tab--active' : '')}
                onClick={() => setActiveTabId(tab.id)}
              >
                {tab.name}
              </button>
              {deleteHoverHint?.kind === 'tab' && deleteHoverHint.id === tab.id ? (
                <button
                  type="button"
                  className="table-tab-delete-btn"
                  onClick={(event) => {
                    event.stopPropagation()
                    event.preventDefault()
                    handleDeleteTab(tab)
                  }}
                  disabled={deletingTabId === tab.id}
                  aria-label="Удалить"
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
          <button type="button" className="balance-hub__tab" onClick={handleCreateTab} disabled={isCreatingTab}>
            +
          </button>
        </div>

        <div className="balance-hub__tabs" role="tablist">
          {activeSubtabs.map((subtab) =>
            renamingSubtabId === subtab.id ? (
              <input
                key={subtab.id}
                type="text"
                className="input table-subtab-rename-input"
                value={renamingSubtabName}
                onChange={(event) => setRenamingSubtabName(event.target.value)}
                onBlur={() => commitRenameSubtab(subtab.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitRenameSubtab(subtab.id)
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelRenameSubtab()
                  }
                }}
                autoFocus
              />
            ) : (
              <span
                key={subtab.id}
                className="table-tab-item-wrap"
                onMouseEnter={() => scheduleDeleteHoverHint('subtab', subtab.id)}
                onMouseLeave={clearDeleteHoverHint}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeSubtabId === subtab.id}
                  className={'balance-hub__tab' + (activeSubtabId === subtab.id ? ' balance-hub__tab--active' : '')}
                  onClick={() => setActiveSubtabId(subtab.id)}
                  onDoubleClick={(event) => {
                    event.preventDefault()
                    startRenameSubtab(subtab)
                  }}
                >
                  {subtab.name}
                </button>
                {deleteHoverHint?.kind === 'subtab' && deleteHoverHint.id === subtab.id ? (
                  <button
                    type="button"
                    className="table-tab-delete-btn"
                    onClick={(event) => {
                      event.stopPropagation()
                      event.preventDefault()
                      handleDeleteSubtab(subtab)
                    }}
                    disabled={deletingSubtabId === subtab.id}
                    aria-label="Удалить"
                  >
                    ×
                  </button>
                ) : null}
              </span>
            )
          )}
          <button
            type="button"
            className="balance-hub__tab"
            onClick={handleCreateSubtab}
            disabled={isCreatingSubtab || !activeTabId}
          >
            +
          </button>
        </div>

        <h2 className="card-title">{activeTab?.name || 'Таблица'}</h2>

        <div className="lot-settings-row table-codes-add-row">
          <textarea
            className="input table-codes-input"
            rows={3}
            value={codeInput}
            onChange={(event) => setCodeInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                handleAddCode()
              }
            }}
            disabled={isSaving || !activeSubtabId}
          />
          <button type="button" className="btn-primary" onClick={handleAddCode} disabled={isSaving || !activeSubtabId}>
            Добавить код
          </button>
        </div>
        {!activeSubtabId ? <p className="card-text">Создайте таблицу через +.</p> : null}
        {error ? <p className="card-text card-text--error">{error}</p> : null}

        {activeSubtabId ? (
          <div className="table-filters profit-toolbar">
            <label className="table-filters__field">
              <span className="active-lots-filters__label">Дата с</span>
              <input
                type="date"
                className="input table-filters__date"
                value={activeFilters.dateFrom}
                onChange={(event) => setActiveSubtabFilter({ dateFrom: event.target.value })}
              />
            </label>
            <label className="table-filters__field">
              <span className="active-lots-filters__label">Дата по</span>
              <input
                type="date"
                className="input table-filters__date"
                value={activeFilters.dateTo}
                onChange={(event) => setActiveSubtabFilter({ dateTo: event.target.value })}
              />
            </label>
            <label className="table-filters__field">
              <span className="active-lots-filters__label">Использован</span>
              <select
                className="input table-filters__used"
                value={activeFilters.used}
                onChange={(event) => setActiveSubtabFilter({ used: event.target.value })}
              >
                <option value="all">Все</option>
                <option value="yes">Использован</option>
                <option value="pending">В ожидании</option>
                <option value="no">Нет</option>
              </select>
            </label>
          </div>
        ) : null}

        <div className="history-table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Код</th>
                <th className="table-col-used">Использован</th>
                <th>Id сделки</th>
                <th>id Товара</th>
                <th>Id чата</th>
                <th>Дата внесения кода</th>
                <th>Дата изменения статуса кода</th>
                {activeColumns.map((column) => (
                  <th key={column.id}>
                    {renamingColumnId === column.id ? (
                      <input
                        type="text"
                        className="input table-col-rename-input"
                        value={renamingColumnName}
                        onChange={(event) => setRenamingColumnName(event.target.value)}
                        onBlur={() => commitRenameColumn(column.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            commitRenameColumn(column.id)
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            cancelRenameColumn()
                          }
                        }}
                        autoFocus
                      />
                    ) : (
                      <span
                        className="table-col-header-wrap"
                        onMouseEnter={() => scheduleDeleteHoverHint('column', column.id)}
                        onMouseLeave={clearDeleteHoverHint}
                      >
                        <span
                          className="table-col-header-label"
                          onDoubleClick={(event) => {
                            event.preventDefault()
                            startRenameColumn(column)
                          }}
                        >
                          {column.name}
                        </span>
                        {deleteHoverHint?.kind === 'column' && deleteHoverHint.id === column.id ? (
                          <button
                            type="button"
                            className="table-tab-delete-btn"
                            onClick={(event) => {
                              event.stopPropagation()
                              event.preventDefault()
                              handleDeleteColumn(column)
                            }}
                            disabled={deletingColumnId === column.id}
                            aria-label="Удалить"
                          >
                            ×
                          </button>
                        ) : null}
                      </span>
                    )}
                  </th>
                ))}
                <th className="table-col-add-th">
                  <button
                    type="button"
                    className="table-col-add-btn"
                    onClick={handleCreateColumn}
                    disabled={isCreatingColumn || !activeSubtabId}
                    aria-label="Добавить столбец"
                  >
                    +
                  </button>
                </th>
                <th>Удалить</th>
              </tr>
            </thead>
            <tbody>
              {!isLoading && filteredCodes.length === 0 ? (
                <tr>
                  <td colSpan={tableColSpan}>Пусто</td>
                </tr>
              ) : null}
              {filteredCodes.map((code, index) => (
                <tr key={String(activeSubtabId) + '-' + (code.id || index)}>
                  <td>{index + 1}</td>
                  <td>
                    <button
                      type="button"
                      className="table-code-copy-btn"
                      onClick={(event) => handleCopyCode(event, code.id, code.code)}
                      title="Скопировать код"
                    >
                      {code.code}
                    </button>
                  </td>
                  <td className="table-col-used">
                    {(() => {
                      const status = codeStatusOf(code)
                      const statusClass =
                        status === 'used'
                          ? 'table-used-select--yes'
                          : status === 'pending'
                            ? 'table-used-select--pending'
                            : 'table-used-select--no'
                      return (
                        <select
                          className={'input table-used-select ' + statusClass}
                          value={status === 'used' ? 'used' : status === 'pending' ? 'pending' : 'unused'}
                          onChange={(event) => handleUsedChange(code.id, event.target.value)}
                          disabled={updatingCodeId === code.id}
                        >
                          <option value="used">✓ использован</option>
                          <option value="pending">⏳ в ожидании</option>
                          <option value="unused">✕ нет</option>
                        </select>
                      )
                    })()}
                  </td>
                  <td>{code.dealId || '—'}</td>
                  <td>{code.itemId || '—'}</td>
                  <td>{code.chatId || '—'}</td>
                  <td>{formatDateTime(code.createdAt)}</td>
                  <td>{formatDateTime(code.statusChangedAt)}</td>
                  {activeColumns.map((column) => {
                    const cellKey = String(code.id) + '-' + String(column.id)
                    const cellValue = getCustomCellValue(code, column.id)
                    return (
                      <td key={String(column.id) + '-' + String(code.id)}>
                        <input
                          type="text"
                          className="input table-custom-cell-input"
                          value={cellValue}
                          onChange={(event) => handleCustomCellChange(code.id, column.id, event.target.value)}
                          onBlur={(event) => handleCustomCellBlur(code.id, column.id, event.target.value)}
                          disabled={savingCellKey === cellKey}
                        />
                      </td>
                    )
                  })}
                  <td className="table-col-add-th" />
                  <td>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => handleDeleteCode(code.id)}
                      disabled={deletingCodeId === code.id}
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {copyState.id != null ? (
          <div
            className={'table-copy-floating-hint' + (copyState.status === 'ok' ? ' table-copy-floating-hint--ok' : ' table-copy-floating-hint--error')}
            style={{ left: copyState.x, top: copyState.y }}
          >
            {copyState.status === 'ok' ? 'Скопировано' : 'Не удалось'}
          </div>
        ) : null}
      </div>
    </div>
  )
}

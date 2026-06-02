import { useState } from 'react'
import { BalanceTab } from './BalanceTab.jsx'
import { ProfitTab } from '../profit/ProfitTab.jsx'
import { ActionsTab } from '../actions/ActionsTab.jsx'

const SUB_TABS = [
  { id: 'balance', label: 'Баланс' },
  { id: 'profit', label: 'Статистика' },
  { id: 'actions', label: 'Действия' },
]

export function BalanceHubTab({ token }) {
  const [sub, setSub] = useState('balance')

  return (
    <div className="balance-hub">
      <div className="balance-hub__tabs" role="tablist">
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={sub === t.id}
            className={'balance-hub__tab' + (sub === t.id ? ' balance-hub__tab--active' : '')}
            onClick={() => setSub(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Держим все разделы смонтированными (hidden), чтобы не терять их состояние
          при переключении под-вкладок. */}
      <div className="balance-hub__panel" hidden={sub !== 'balance'}>
        <BalanceTab token={token} />
      </div>
      <div className="balance-hub__panel" hidden={sub !== 'profit'}>
        <ProfitTab token={token} />
      </div>
      <div className="balance-hub__panel" hidden={sub !== 'actions'}>
        <ActionsTab token={token} />
      </div>
    </div>
  )
}

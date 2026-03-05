import React from 'react'

export function CompletedLotsTab() {
  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Завершенные лоты</h1>
        <p className="tab-page-description">
          Архив лотов, которые уже были завершены — проданы, отменены или
          истекли по времени.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card">
          <h2 className="card-title">История сделок</h2>
          <p className="card-text">
            Здесь появится список завершенных лотов с датой, итоговой ценой и
            статусом завершения.
          </p>
        </section>

        <section className="card">
          <h2 className="card-title">Аналитика</h2>
          <p className="card-text">
            В будущем добавим сводку по выручке, марже, самым эффективным
            стратегиям выставления и поднятия лотов.
          </p>
        </section>
      </div>
    </div>
  )
}


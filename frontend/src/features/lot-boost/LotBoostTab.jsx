import React from 'react'

export function LotBoostTab() {
  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Поднятие лотов</h1>
        <p className="tab-page-description">
          Управляйте автоматическим поднятием ваших лотов в выдаче.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card">
          <h2 className="card-title">Стратегия поднятия</h2>
          <p className="card-text">
            Здесь будут настраиваться правила, когда и какие лоты поднимать.
          </p>
        </section>

      <section className="card">
          <h2 className="card-title">Ограничения и бюджеты</h2>
          <p className="card-text">
            В этой секции появятся лимиты по бюджету, суточные ограничения и
            другие параметры безопасности.
          </p>
        </section>
      </div>
    </div>
  )
}


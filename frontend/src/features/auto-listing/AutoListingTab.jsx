import React from 'react'

export function AutoListingTab() {
  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Автовыставление</h1>
        <p className="tab-page-description">
          Настройте автоматическое выставление лотов по заданным правилам.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card">
          <h2 className="card-title">Основные параметры</h2>
          <p className="card-text">
            Здесь позже появятся поля для выбора аккаунтов, шаблонов лотов и
            интервалов выставления.
          </p>
        </section>

        <section className="card">
          <h2 className="card-title">Расписание</h2>
          <p className="card-text">
            В этой секции будет настройка расписания и временных окон для
            автодобавления лотов.
          </p>
        </section>
      </div>
    </div>
  )
}


import React from 'react'

export function HistoryTab() {
  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>История операций</h1>
        <p className="tab-page-description">
          Журнал всех действий с лотами: автоворонка, поднятия, изменения цен и
          статусов.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card">
          <h2 className="card-title">Лог событий</h2>
          <p className="card-text">
            Здесь позже появится список событий с временем, типом операции и
            результатом (успешно / ошибка).
          </p>
        </section>

        <section className="card">
          <h2 className="card-title">Фильтры истории</h2>
          <p className="card-text">
            Сюда добавим фильтрацию по типу события, аккаунту, игре и
            периодам времени для анализа.
          </p>
        </section>
      </div>
    </div>
  )
}


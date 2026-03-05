import React from 'react'

export function AutoDeliveryTab() {
  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Автовыдача</h1>
        <p className="tab-page-description">
          Настройка автоматической выдачи товара после успешной сделки.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card">
          <h2 className="card-title">Шаблоны выдачи</h2>
          <p className="card-text">
            Здесь появятся настройки шаблонов для автоматической отправки ключей,
            логинов, инструкций и других данных покупателю.
          </p>
        </section>

        <section className="card">
          <h2 className="card-title">Правила и ограничения</h2>
          <p className="card-text">
            В этой секции будут задаваться условия, когда включать автовыдачу,
            задержки между оплатой и выдачей, а также защита от ошибок.
          </p>
        </section>
      </div>
    </div>
  )
}


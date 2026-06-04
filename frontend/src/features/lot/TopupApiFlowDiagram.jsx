import React from 'react'

/* --- Иконки актёров и решений (inline SVG, наследуют currentColor) --- */
function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l1-8z" />
    </svg>
  )
}
function IconBot() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="8" width="16" height="11" rx="2.5" />
      <path d="M12 8V4M9 4h6" />
      <circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}
function IconUser() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6" />
    </svg>
  )
}
function IconCheckShield() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.2 2.9 7.8 7 9 4.1-1.2 7-4.8 7-9V6l-7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )
}
function IconCard() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M3 10h18M7 15h4" />
    </svg>
  )
}
function IconFlag() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
    </svg>
  )
}

const ACTOR_META = {
  buyer: { label: 'Покупатель', Icon: IconUser },
  bot: { label: 'Бот', Icon: IconBot },
  system: { label: 'Система', Icon: IconBolt },
  check: { label: 'Проверка', Icon: IconCheckShield },
}

/** Шаг на основной «оси» (счастливый путь идёт прямо вниз). */
function Step({ n, actor, icon, title, last, children }) {
  const meta = ACTOR_META[actor] || ACTOR_META.system
  const Icon = icon || meta.Icon
  return (
    <div className={`tflow-step tflow-step--${actor}${last ? ' tflow-step--last' : ''}`}>
      <div className="tflow-step__rail">
        <span className="tflow-step__badge">
          <Icon />
          {n != null ? <span className="tflow-step__num">{n}</span> : null}
        </span>
      </div>
      <div className="tflow-step__card">
        <span className="tflow-step__actor">
          <span className="tflow-step__dot" />
          {meta.label}
        </span>
        <span className="tflow-step__title">{title}</span>
        {children ? <div className="tflow-step__body">{children}</div> : null}
      </div>
    </div>
  )
}

/** Боковая ветка (ошибка / альтернатива), уходит вправо и зацикливается назад. */
function Branch({ tone = 'fail', tag, children }) {
  return (
    <div className={`tflow-branch tflow-branch--${tone}`}>
      <span className="tflow-branch__connector" aria-hidden="true" />
      <div className="tflow-branch__inner">
        {tag ? <span className="tflow-branch__tag">{tag}</span> : null}
        {children}
      </div>
    </div>
  )
}

/** Карточка «бот отправляет сообщение» с редактируемым текстом. */
function BotMessage({ caption, value, placeholder, onChange, readOnly }) {
  return (
    <div className="tflow-msg">
      <span className="tflow-msg__caption">
        <IconBot />
        {caption}
      </span>
      {readOnly ? (
        <p className="tflow-msg__preview">{value || <em>текст не задан</em>}</p>
      ) : (
        <textarea
          className="lot-settings-textarea tflow-msg__input"
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

function LoopBack({ children }) {
  return (
    <p className="tflow-loop">
      <span className="tflow-loop__icon" aria-hidden="true">↩</span>
      {children}
    </p>
  )
}

export function TopupApiFlowDiagram({ settings, onFieldChange, autoCompleteDeal }) {
  const askIdMessage = settings?.askIdMessage ?? ''
  const confirmTemplate = settings?.confirmTemplate ?? ''
  const invalidIdMessage = settings?.invalidIdMessage ?? ''
  const successMessage = settings?.successMessage ?? ''

  return (
    <div className="tflow" aria-label="Схема автопополнения по API">
      <div className="tflow__head">
        <h4 className="tflow__title">Как срабатывает автопополнение</h4>
        <div className="tflow__legend">
          <span className="tflow__legend-item tflow__legend-item--system"><span className="tflow__legend-dot" />Событие</span>
          <span className="tflow__legend-item tflow__legend-item--bot"><span className="tflow__legend-dot" />Бот</span>
          <span className="tflow__legend-item tflow__legend-item--buyer"><span className="tflow__legend-dot" />Покупатель</span>
          <span className="tflow__legend-item tflow__legend-item--check"><span className="tflow__legend-dot" />Проверка</span>
        </div>
      </div>

      <div className="tflow__track">
        {/* 1 — старт */}
        <Step n={1} actor="system" icon={IconCard} title="Покупатель оплатил лот">
          <p className="tflow-hint">Флоу пополнения запускается автоматически после оплаты.</p>
        </Step>

        {/* 2 — запрос ID */}
        <Step n={2} actor="bot" title="Запрос игрового ID / логина">
          <p className="tflow-hint">Текст берётся из плитки «Api.Пополнение» на этапе «Покупка».</p>
          <BotMessage caption="Бот пишет" value={askIdMessage} readOnly />
        </Step>

        {/* 3 — покупатель присылает ID */}
        <Step n={3} actor="buyer" title="Присылает свой ID или логин в чат" />

        {/* 4 — проверка ID */}
        <Step n={4} actor="check" title="Проверка ID через AppRoute">
          <p className="tflow-hint">Тестовый запрос без списания — только валидация ID.</p>
          <Branch tone="fail" tag="✕ ID не прошёл">
            <BotMessage
              caption="Бот пишет"
              value={invalidIdMessage}
              placeholder="Сообщение о неверном ID…"
              onChange={(v) => onFieldChange('invalidIdMessage', v)}
            />
            <LoopBack>возврат к шагу 2 — снова ждём ID</LoopBack>
          </Branch>
          <Branch tone="muted" tag="⏳ Временная ошибка">
            <p className="tflow-hint tflow-hint--tight">
              Сеть / баланс / нет в наличии — бот молча повторит попытку позже.
            </p>
          </Branch>
        </Step>

        {/* 5 — подтверждение */}
        <Step n={5} actor="bot" title="Подтверждение ID">
          <p className="tflow-hint">
            <code className="tflow-code">{'{id}'}</code> подставляется автоматически.
          </p>
          <BotMessage
            caption="Бот пишет"
            value={confirmTemplate}
            placeholder="Подтвердите: ваш ID — {id}. Верно?"
            onChange={(v) => onFieldChange('confirmTemplate', v)}
          />
        </Step>

        {/* 6 — ответ покупателя */}
        <Step n={6} actor="buyer" title="Отвечает на подтверждение">
          <div className="tflow-replies">
            <div className="tflow-reply tflow-reply--no">
              <span className="tflow-reply__key">«нет»</span>
              <span className="tflow-reply__val">↩ снова запрос ID (шаг 2)</span>
            </div>
            <div className="tflow-reply tflow-reply--new">
              <span className="tflow-reply__key">новый ID</span>
              <span className="tflow-reply__val">↻ повторная проверка → подтверждение</span>
            </div>
            <div className="tflow-reply tflow-reply--yes">
              <span className="tflow-reply__key">«да»</span>
              <span className="tflow-reply__val">→ оформляем заказ</span>
            </div>
          </div>
        </Step>

        {/* 7 — заказ в AppRoute */}
        <Step n={7} actor="check" title="Пополнение через AppRoute">
          <p className="tflow-hint">Реальный заказ, идемпотентный по сделке — двойного списания не будет.</p>
          <Branch tone="fail" tag="✕ Заказ не прошёл">
            <p className="tflow-hint tflow-hint--tight">Бот отправит то же сообщение о неверном ID.</p>
            <LoopBack>возврат к шагу 2 — снова ждём ID</LoopBack>
          </Branch>
        </Step>

        {/* 8 — успех */}
        <Step n={8} actor="bot" title="Пополнение выполнено" last={!autoCompleteDeal}>
          <BotMessage
            caption="Бот пишет"
            value={successMessage}
            placeholder="Готово! Пополнение выполнено."
            onChange={(v) => onFieldChange('successMessage', v)}
          />
        </Step>

        {/* 9 — автозавершение (опционально) */}
        {autoCompleteDeal ? (
          <Step n={9} actor="system" icon={IconFlag} title="Сделка переводится в «Отправлен»" last>
            <p className="tflow-hint">Активно, потому что включена плитка «Автозавершение».</p>
          </Step>
        ) : null}
      </div>
    </div>
  )
}

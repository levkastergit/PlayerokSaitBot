function sendJson(res, statusCode, data) {
  // Защита от повторной отправки: если ответ уже начат/завершён (например, обработчик
  // упал после первого sendJson, или сработал глобальный catch), второй вызов молча
  // выходит — иначе ERR_HTTP_HEADERS_SENT роняет процесс.
  if (res.headersSent || res.writableEnded) return
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

module.exports = { sendJson }


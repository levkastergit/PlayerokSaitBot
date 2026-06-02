'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { sendJson } = require('./sendJson')
const { readJsonBody } = require('./readJsonBody')

const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // 8 МБ
const MAX_BODY_BYTES = 12 * 1024 * 1024 // base64 ~ +33%

const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
const EXT_TO_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function userDir(baseDir, userId) {
  return path.join(baseDir, String(Number(userId)))
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([\s\S]+)$/i)
  if (!m) return null
  const mime = m[1].toLowerCase()
  const ext = MIME_TO_EXT[mime]
  if (!ext) return null
  let buffer
  try {
    buffer = Buffer.from(m[2], 'base64')
  } catch (_) {
    return null
  }
  if (!buffer || buffer.length === 0) return null
  return { mime, ext, buffer }
}

// Лёгкая проверка по сигнатуре, чтобы не сохранять не-картинки.
function looksLikeImage(buffer, ext) {
  if (!buffer || buffer.length < 12) return false
  const b = buffer
  if (ext === 'png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  if (ext === 'jpg' || ext === 'jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  if (ext === 'gif') return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46
  if (ext === 'webp')
    return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  return false
}

async function dispatchAutomessageImage({ req, res, pathname, currentUserId, deps }) {
  const baseDir = deps && deps.automessageImagesDir
  if (!baseDir) return false

  // Загрузка картинки
  if (req.method === 'POST' && pathname === '/api/automessage-image') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {}, maxBytes: MAX_BODY_BYTES })
    } catch (err) {
      const code = err && err.statusCode === 413 ? 413 : 400
      sendJson(res, code, { error: code === 413 ? 'Файл слишком большой' : 'Invalid JSON body' })
      return true
    }

    const parsed = parseDataUrl(payload && payload.dataUrl)
    if (!parsed) {
      sendJson(res, 400, { error: 'Ожидается dataUrl изображения (png/jpg/gif/webp)' })
      return true
    }
    if (parsed.buffer.length > MAX_IMAGE_BYTES) {
      sendJson(res, 413, { error: 'Картинка больше 8 МБ' })
      return true
    }
    if (!looksLikeImage(parsed.buffer, parsed.ext)) {
      sendJson(res, 400, { error: 'Файл не похож на изображение' })
      return true
    }

    const dir = userDir(baseDir, currentUserId)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (_) {}

    const imageId = crypto.randomBytes(16).toString('hex')
    const fileName = `${imageId}.${parsed.ext}`
    try {
      fs.writeFileSync(path.join(dir, fileName), parsed.buffer)
    } catch (err) {
      sendJson(res, 500, { error: 'Не удалось сохранить картинку' })
      return true
    }

    const rawName =
      payload && typeof payload.filename === 'string' ? payload.filename.slice(0, 120) : ''
    sendJson(res, 200, {
      ok: true,
      image: {
        imageId,
        ext: parsed.ext,
        filename: rawName || fileName,
        url: `/api/automessage-image/${Number(currentUserId)}/${fileName}`,
      },
    })
    return true
  }

  // Отдача картинки (превью). Доступ только своему пользователю.
  if (req.method === 'GET' && pathname.startsWith('/api/automessage-image/')) {
    const rest = pathname.slice('/api/automessage-image/'.length)
    const parts = rest.split('/')
    if (parts.length !== 2) {
      sendJson(res, 400, { error: 'bad path' })
      return true
    }
    const ownerId = Number(parts[0])
    const file = parts[1]
    if (!Number.isFinite(ownerId) || ownerId !== Number(currentUserId)) {
      sendJson(res, 403, { error: 'forbidden' })
      return true
    }
    if (!/^[a-f0-9]{8,}\.(png|jpg|jpeg|gif|webp)$/i.test(file)) {
      sendJson(res, 400, { error: 'bad file name' })
      return true
    }
    const filePath = path.join(userDir(baseDir, ownerId), file)
    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { error: 'not found' })
      return true
    }
    const ext = path.extname(file).slice(1).toLowerCase()
    res.setHeader('Content-Type', EXT_TO_MIME[ext] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.statusCode = 200
    res.end(fs.readFileSync(filePath))
    return true
  }

  return false
}

// Путь к файлу картинки для отправки (используется обработчиком автосообщения).
function automessageImagePath(baseDir, userId, imageId, ext) {
  const id = String(imageId || '').replace(/[^a-f0-9]/gi, '')
  const e = String(ext || '').replace(/[^a-z0-9]/gi, '')
  if (!id || !e) return null
  return path.join(userDir(baseDir, userId), `${id}.${e}`)
}

module.exports = { dispatchAutomessageImage, automessageImagePath, EXT_TO_MIME }

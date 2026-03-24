'use strict'

function extractItemImageUrl(item) {
  if (!item || typeof item !== 'object') return null
  const directFields = [
    'imageUrl',
    'image',
    'previewImage',
    'picture',
    'thumbnail',
    'mainImage',
  ]

  for (const key of directFields) {
    const v = item[key]
    if (!v) continue
    if (typeof v === 'string') return v
    if (typeof v === 'object') {
      if (typeof v.url === 'string') return v.url
      if (typeof v.src === 'string') return v.src
      if (typeof v.link === 'string') return v.link
      if (typeof v.href === 'string') return v.href
    }
  }

  const arrayFields = ['images', 'gallery', 'pictures', 'media', 'attachments']
  for (const key of arrayFields) {
    const arr = item[key]
    if (!Array.isArray(arr) || arr.length === 0) continue
    for (const el of arr) {
      if (!el) continue
      if (typeof el === 'string') return el
      if (typeof el === 'object') {
        if (typeof el.url === 'string') return el.url
        if (typeof el.src === 'string') return el.src
        if (typeof el.link === 'string') return el.link
        if (typeof el.href === 'string') return el.href
      }
    }
  }

  // chat-image debug logging removed
  return null
}

module.exports = { extractItemImageUrl }


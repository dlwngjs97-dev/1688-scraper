const express = require('express')
const { chromium } = require('playwright-extra')
const stealth = require('puppeteer-extra-plugin-stealth')

chromium.use(stealth())

const app = express()
app.use(express.json())

const SECRET = process.env.PROXY_SECRET || ''

// 동시성 1로 제한 (512MB RAM 보호)
let busy = false

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
  '--no-zygote',
]

const CONTEXT_OPTS = {
  locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

// 상품 정보 추출 함수 (page.evaluate에서 실행)
const EXTRACT_PRODUCT = () => {
  const result = {
    title: '',
    titleCn: '',
    priceCny: null,
    priceRange: '',
    moq: '',
    images: [],
    shop: '',
    shopUrl: '',
    attributes: {},
    url: window.location.href,
  }

  // 상품명 (d-title 첫 줄 = 영문/중문 상품명)
  const dTitle = document.querySelector('[class*="d-title"]')
  if (dTitle) {
    const lines = dTitle.innerText.trim().split('\n')
    result.title = lines[0] || ''
    // 중문명은 보통 두 번째 줄이거나 title 안에 포함
  }
  if (!result.title) {
    const h1 = document.querySelector('h1')
    if (h1) result.title = h1.innerText.trim().split('\n')[0]
  }

  // 가격 — price-info가 가장 깔끔
  const priceInfo = document.querySelector('.price-info')
  if (priceInfo) {
    const nums = priceInfo.innerText.match(/[\d.]+/g)
    if (nums && nums.length > 0) {
      result.priceCny = parseFloat(nums.join(''))
    }
  }
  // 폴백: module-od-main-price
  if (!result.priceCny) {
    const mainPrice = document.querySelector('[class*="module-od-main-price"]')
    if (mainPrice) {
      const nums = mainPrice.innerText.match(/[\d.]+/g)
      if (nums) result.priceCny = parseFloat(nums.join(''))
    }
  }

  // 가격 범위 (계량 할인 래더)
  const ladderEls = document.querySelectorAll('[class*="step-price"], [class*="ladder-price"], [class*="sku-price-item"]')
  if (ladderEls.length > 0) {
    result.priceRange = Array.from(ladderEls).map(el => el.innerText.trim()).filter(t => t.length < 80).join(' | ')
  }

  // MOQ — 텍스트에서 "起批", "件起批" 패턴
  const bodyText = document.body.innerText
  const moqMatch = bodyText.match(/(\d+)\s*件?\s*起批/) || bodyText.match(/≥\s*(\d+)\s*件/)
  if (moqMatch) result.moq = moqMatch[0]

  // 이미지 — cbu01.alicdn.com 상품 이미지만 (SVG 아이콘 제외)
  const imgs = document.querySelectorAll('img')
  result.images = Array.from(imgs)
    .map(i => i.src || i.getAttribute('data-src') || '')
    .filter(s => s.includes('cbu01.alicdn.com/img/ibank/'))
    .map(s => s.replace(/_.+?\.(jpg|png|webp)/, '.$1')) // 썸네일 suffix 제거 → 원본
    .filter((v, i, a) => a.indexOf(v) === i) // dedup
    .slice(0, 10)

  // 상점명
  const shopEl = document.querySelector('[class*="company-name"]') || document.querySelector('[class*="companyName"]')
  if (shopEl) result.shop = shopEl.innerText.trim()

  // 상점 링크
  const shopLink = document.querySelector('a[href*="shop"][class*="company"]') || document.querySelector('a[href*=".1688.com"]')
  if (shopLink) result.shopUrl = shopLink.href

  // 속성 테이블
  const attrRows = document.querySelectorAll('[class*="attr"] tr, [class*="attribute"] tr, [class*="detail-attributes"] tr')
  attrRows.forEach(row => {
    const cells = row.querySelectorAll('td, th, span')
    if (cells.length >= 2) {
      const key = cells[0].innerText.trim()
      const val = cells[1].innerText.trim()
      if (key && val && key.length < 30) result.attributes[key] = val
    }
  })

  return result
}

// 1688 이미지 프록시 — 브라우저 세션으로 이미지 다운로드 후 바이너리 반환
// GET /image-proxy?url=https://cbu01.alicdn.com/img/ibank/xxx.jpg_.webp
app.get('/image-proxy', async (req, res) => {
  if (req.headers['x-proxy-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const imageUrl = req.query.url
  if (!imageUrl || !imageUrl.includes('alicdn.com')) {
    return res.status(400).json({ error: 'alicdn.com image url required' })
  }

  try {
    // 브라우저 없이 직접 fetch — alicdn은 Referer만 맞으면 됨
    const response = await fetch(imageUrl, {
      headers: {
        'Referer': 'https://detail.1688.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
    })
    if (!response.ok) {
      return res.status(response.status).json({ error: `upstream ${response.status}` })
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') || 'image/jpeg'
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', buffer.length)
    res.send(buffer)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /download-images — 이미지 URL 배열 → base64 배열 반환
// 1688 이미지를 SmartStore에 업로드하기 위해 이 서버에서 다운로드
app.post('/download-images', async (req, res) => {
  if (req.headers['x-proxy-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const urls = req.body.urls
  if (!Array.isArray(urls)) {
    return res.status(400).json({ error: 'urls array required' })
  }

  const results = await Promise.all(urls.slice(0, 10).map(async (url) => {
    try {
      const response = await fetch(url, {
        headers: {
          'Referer': 'https://detail.1688.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        },
      })
      if (!response.ok) return { url, success: false, error: `${response.status}` }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 5000) return { url, success: false, error: 'too small' }
      const contentType = response.headers.get('content-type') || 'image/jpeg'
      return { url, success: true, base64: buffer.toString('base64'), contentType, size: buffer.length }
    } catch (err) {
      return { url, success: false, error: err.message }
    }
  }))

  res.json({ results })
})

app.get('/health', (_, res) => res.json({ ok: true, service: '1688-scraper' }))

app.get('/my-ip', async (_, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json')
    res.json(await r.json())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 1688 상품 스크래핑
// GET /scrape?url=https://detail.1688.com/offer/XXXXX.html
app.get('/scrape', async (req, res) => {
  if (req.headers['x-proxy-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const url = req.query.url
  if (!url || !url.includes('1688.com')) {
    return res.status(400).json({ error: 'url parameter required (1688.com)' })
  }

  if (busy) {
    return res.status(429).json({ error: 'busy, try again in 10s' })
  }

  busy = true
  let browser = null

  try {
    browser = await chromium.launch({ headless: true, args: BROWSER_ARGS })
    const context = await browser.newContext(CONTEXT_OPTS)
    const page = await context.newPage()

    // 네트워크 인터셉션으로 이미지 응답 캡처
    const capturedImages = new Map() // url → Buffer
    if (req.query.include_images === 'true') {
      page.on('response', async (response) => {
        try {
          const respUrl = response.url()
          if (respUrl.includes('cbu01.alicdn.com/img/ibank/') && response.status() === 200) {
            const ct = response.headers()['content-type'] || ''
            if (ct.startsWith('image/') || respUrl.match(/\.(jpg|png|webp)/i)) {
              const body = await response.body()
              if (body.length > 3000) {
                capturedImages.set(respUrl, { buffer: body, contentType: ct || 'image/jpeg' })
              }
            }
          }
        } catch {} // 일부 응답은 body 접근 불가 — 무시
      })
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // punish/wrongpage 체크
    const loadedUrl = page.url()
    if (loadedUrl.includes('punish') || loadedUrl.includes('x5secdata')) {
      await page.waitForTimeout(5000)
      if (page.url().includes('punish')) {
        await browser.close()
        busy = false
        return res.status(403).json({ error: 'anti-bot challenge not bypassed' })
      }
    }
    if (loadedUrl.includes('wrongpage') || loadedUrl.includes('notfound')) {
      await browser.close()
      busy = false
      return res.status(404).json({ error: 'product not found (removed or invalid URL)' })
    }

    // 페이지 렌더링 대기
    await page.waitForTimeout(4000)

    const data = await page.evaluate(EXTRACT_PRODUCT)

    // include_images=true → 네트워크 인터셉션으로 캡처한 이미지 반환
    const includeImages = req.query.include_images === 'true'
    let imageData = []
    if (includeImages) {
      // 캡처된 이미지 중 data.images URL과 매칭되는 것 찾기
      for (const imgUrl of data.images.slice(0, 6)) {
        // URL 패턴으로 매칭 (캡처 URL은 정확히 같거나 suffix만 다를 수 있음)
        const imgId = imgUrl.split('/').pop()?.split('.')[0] || ''
        let matched = capturedImages.get(imgUrl)
        if (!matched) {
          // 부분 매칭
          for (const [capturedUrl, capturedData] of capturedImages) {
            if (capturedUrl.includes(imgId)) { matched = capturedData; break }
          }
        }
        if (matched) {
          imageData.push({
            url: imgUrl,
            success: true,
            base64: matched.buffer.toString('base64'),
            contentType: matched.contentType,
            size: matched.buffer.length,
          })
        } else {
          imageData.push({ url: imgUrl, success: false, error: 'not captured during page load' })
        }
      }
    }

    await browser.close()
    busy = false

    if (!data.title && data.images.length === 0) {
      return res.json({
        success: false,
        error: 'page loaded but no product data extracted',
        data,
      })
    }

    res.json({ success: true, data, ...(includeImages ? { imageData } : {}) })

  } catch (err) {
    if (browser) await browser.close().catch(() => {})
    busy = false
    res.status(500).json({ error: err.message })
  }
})

// 다중 상품 벌크 스크래핑 (최대 5개, 브라우저 1개로 순차)
app.post('/scrape-bulk', async (req, res) => {
  if (req.headers['x-proxy-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const urls = req.body.urls
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array required' })
  }
  if (urls.length > 5) {
    return res.status(400).json({ error: 'max 5 urls per request' })
  }
  if (busy) {
    return res.status(429).json({ error: 'busy, try again in 30s' })
  }

  busy = true
  let browser = null
  const results = []

  try {
    browser = await chromium.launch({ headless: true, args: BROWSER_ARGS })
    const context = await browser.newContext(CONTEXT_OPTS)

    for (const url of urls) {
      try {
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })

        const loadedUrl = page.url()
        if (loadedUrl.includes('punish')) {
          await page.waitForTimeout(5000)
          if (page.url().includes('punish')) {
            results.push({ url, success: false, error: 'anti-bot' })
            await page.close()
            continue
          }
        }
        if (loadedUrl.includes('wrongpage') || loadedUrl.includes('notfound')) {
          results.push({ url, success: false, error: 'product not found' })
          await page.close()
          continue
        }

        await page.waitForTimeout(3000)
        const data = await page.evaluate(EXTRACT_PRODUCT)
        results.push({ url, success: !!data.title, data })
        await page.close()

      } catch (err) {
        results.push({ url, success: false, error: err.message.substring(0, 200) })
      }
    }

    await browser.close()
    busy = false
    res.json({ results })

  } catch (err) {
    if (browser) await browser.close().catch(() => {})
    busy = false
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 3002
app.listen(PORT, () => console.log(`1688-scraper running on :${PORT}`))

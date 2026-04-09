const express = require('express')
const { chromium } = require('playwright-extra')
const stealth = require('puppeteer-extra-plugin-stealth')

chromium.use(stealth())

const app = express()
app.use(express.json())

const SECRET = process.env.PROXY_SECRET || ''

// 동시성 1로 제한 (512MB RAM 보호)
let busy = false

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
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
      ],
    })

    const context = await browser.newContext({
      locale: 'zh-CN',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })

    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // punish 리다이렉트 감지 — 3초 대기 후 재시도
    const currentUrl = page.url()
    if (currentUrl.includes('punish') || currentUrl.includes('x5secdata')) {
      // 실제 브라우저면 자동으로 원래 페이지로 돌아감. 잠시 대기.
      await page.waitForTimeout(5000)
      if (page.url().includes('punish')) {
        await browser.close()
        busy = false
        return res.status(403).json({ error: 'anti-bot challenge not bypassed', finalUrl: page.url() })
      }
    }

    // 페이지 로드 대기
    await page.waitForTimeout(3000)

    // 상품 정보 추출
    const data = await page.evaluate(() => {
      const result = {
        title: '',
        price: '',
        priceRange: '',
        minOrder: '',
        images: [],
        attributes: {},
        shop: '',
        url: window.location.href,
      }

      // 상품명
      const titleEl = document.querySelector('.title-text') ||
        document.querySelector('[class*="title"]') ||
        document.querySelector('h1')
      if (titleEl) result.title = titleEl.innerText.trim()

      // 가격
      const priceEl = document.querySelector('.price-text') ||
        document.querySelector('[class*="price"]') ||
        document.querySelector('.num')
      if (priceEl) result.price = priceEl.innerText.trim()

      // 가격 범위 (계량 할인)
      const priceItems = document.querySelectorAll('[class*="price-item"], [class*="step-price"]')
      if (priceItems.length > 0) {
        result.priceRange = Array.from(priceItems).map(el => el.innerText.trim()).join(' | ')
      }

      // 최소주문량
      const moqEl = document.querySelector('[class*="min-order"]') ||
        document.querySelector('[class*="起批"]')
      if (moqEl) result.minOrder = moqEl.innerText.trim()

      // 이미지 (상위 10개)
      const imgs = document.querySelectorAll('[class*="detail-gallery"] img, [class*="image-view"] img, .detail-gallery-turn img')
      result.images = Array.from(imgs).slice(0, 10).map(img =>
        (img.src || img.getAttribute('data-src') || '').replace(/_.+?\.jpg/, '.jpg')
      ).filter(Boolean)

      // 상점명
      const shopEl = document.querySelector('[class*="company-name"]') ||
        document.querySelector('.shop-name')
      if (shopEl) result.shop = shopEl.innerText.trim()

      // 속성
      const attrRows = document.querySelectorAll('[class*="attr"] tr, [class*="attribute"] tr')
      attrRows.forEach(row => {
        const cells = row.querySelectorAll('td, th')
        if (cells.length >= 2) {
          result.attributes[cells[0].innerText.trim()] = cells[1].innerText.trim()
        }
      })

      return result
    })

    await browser.close()
    busy = false

    // 빈 응답 체크
    if (!data.title && data.images.length === 0) {
      return res.json({
        success: false,
        error: 'page loaded but no product data found (layout may have changed)',
        rawUrl: currentUrl,
        data,
      })
    }

    res.json({ success: true, data })

  } catch (err) {
    if (browser) await browser.close().catch(() => {})
    busy = false
    res.status(500).json({ error: err.message })
  }
})

// 다중 상품 벌크 스크래핑 (최대 5개)
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
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
      ],
    })

    const context = await browser.newContext({
      locale: 'zh-CN',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })

    for (const url of urls) {
      try {
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

        const currentUrl = page.url()
        if (currentUrl.includes('punish')) {
          await page.waitForTimeout(5000)
          if (page.url().includes('punish')) {
            results.push({ url, success: false, error: 'anti-bot' })
            await page.close()
            continue
          }
        }

        await page.waitForTimeout(2000)

        const data = await page.evaluate(() => {
          const r = { title: '', price: '', minOrder: '', images: [], shop: '' }
          const t = document.querySelector('.title-text') || document.querySelector('[class*="title"]') || document.querySelector('h1')
          if (t) r.title = t.innerText.trim()
          const p = document.querySelector('.price-text') || document.querySelector('[class*="price"]') || document.querySelector('.num')
          if (p) r.price = p.innerText.trim()
          const imgs = document.querySelectorAll('[class*="detail-gallery"] img, [class*="image-view"] img')
          r.images = Array.from(imgs).slice(0, 5).map(i => (i.src || i.getAttribute('data-src') || '').replace(/_.+?\.jpg/, '.jpg')).filter(Boolean)
          const s = document.querySelector('[class*="company-name"]') || document.querySelector('.shop-name')
          if (s) r.shop = s.innerText.trim()
          return r
        })

        results.push({ url, success: !!data.title, data })
        await page.close()

      } catch (err) {
        results.push({ url, success: false, error: err.message })
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

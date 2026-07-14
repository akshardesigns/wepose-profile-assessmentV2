/* ============================================================
   lib/pdf.js — generate PDF server-side pakai Puppeteer, dengan
   membuka public/print.html (yang pakai engine render SAMA PERSIS
   dengan preview di index.html). Ini yang menjamin PDF == preview.

   PERUBAHAN vs versi sebelumnya (untuk fix "PDF gagal dibuka"):
   1. Setelah page.pdf() selesai, buffer DIVALIDASI harus mulai
      dengan magic bytes "%PDF-". Kalau tidak, dilempar error yang
      jelas — supaya file rusak/kosong TIDAK PERNAH sampai ke
      browser sebagai response 200 (yang bikin file ke-download tapi
      gagal dibuka, seperti di screenshot).
   2. page.on('console'/'pageerror'/'requestfailed') di-log ke
      server, supaya kalau print.html gagal render (misal font
      Google gagal dimuat, gambar base64 korup, dsb) penyebabnya
      kelihatan di Vercel function logs, bukan cuma "gagal".
   3. Navigation & readiness timeout dibikin lebih longgar dan bisa
      di-override lewat env var, karena cold start Chromium di
      serverless (terutama request PERTAMA setelah deploy/idle)
      sering butuh >10 detik hanya untuk browser siap.
   ============================================================ */

const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const USE_TEMP_SERVER = IS_SERVERLESS || process.env.TEST_LOCAL_SERVER === '1';

const NAV_TIMEOUT_MS = Number(process.env.PDF_NAV_TIMEOUT_MS || 45000);
const READY_TIMEOUT_MS = Number(process.env.PDF_READY_TIMEOUT_MS || 40000);

let browserPromise = null;

async function launchServerless() {
  const path = require('path');
  const chromium = require('@sparticuz/chromium');
  const puppeteer = require('puppeteer-core');

  // Nonaktifkan graphics/WebGL mode — mengurangi dependency shared library
  // yang dibutuhkan Chromium saat startup di container serverless yang minim
  // (salah satu penyebab umum error "libnss3.so: cannot open shared object file").
  chromium.setGraphicsMode = false;

  const executablePath = await chromium.executablePath();

  // FIX UTAMA: setelah @sparticuz/chromium meng-extract binary + shared
  // libraries (termasuk libnss3.so) ke /tmp, sistem loader Linux (ld.so)
  // tetap butuh tahu DI MANA folder itu lewat LD_LIBRARY_PATH. Tanpa ini,
  // Chromium bisa gagal start walau file .so-nya sebenarnya sudah ada di
  // /tmp, karena loader mencarinya di path default yang tidak mencakup /tmp.
  const libDir = path.dirname(executablePath);
  process.env.LD_LIBRARY_PATH = [
    libDir,
    process.env.LD_LIBRARY_PATH || '',
  ].filter(Boolean).join(':');

  console.log('[PDF] chromium executablePath =', executablePath);
  console.log('[PDF] LD_LIBRARY_PATH =', process.env.LD_LIBRARY_PATH);

  return puppeteer.launch({
    args: [
      ...chromium.args,
      '--font-render-hinting=none', // hindari font fallback aneh di container tanpa font system
    ],
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });
}

async function launchLocal() {
  const puppeteer = require("puppeteer");

  // Jangan override executablePath — biarkan Puppeteer pakai Chromium
  // bawaannya sendiri (yang otomatis ter-download saat `npm install`).
  return puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (IS_SERVERLESS ? launchServerless() : launchLocal()).catch(err => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/**
 * Render PDF langsung dari sebuah state (object), tanpa token.
 * State di-inject ke window.__WEPOSE_STATE__ sebelum print.html
 * sempat menjalankan script-nya sendiri.
 */
async function renderPdfFromState(state, baseUrl) {
  let localServer = null;
  let renderUrl = baseUrl;

  if (USE_TEMP_SERVER) {
    const express = require('express');
    const path = require('path');
    const tempApp = express();
    const publicPath = path.join(__dirname, '../public');
    tempApp.use(express.static(publicPath));

    await new Promise((resolve, reject) => {
      localServer = tempApp.listen(0, '127.0.0.1', (err) => {
        if (err) return reject(err);
        const port = localServer.address().port;
        renderUrl = `http://127.0.0.1:${port}`;
        console.log(`[PDF] Temporary local server started on ${renderUrl} serving ${publicPath}`);
        resolve();
      });
    });
  }

  const browser = await getBrowser();
  const page = await browser.newPage();

  const pageLogs = [];
  page.on('console', (msg) => pageLogs.push(`[console:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageLogs.push(`[pageerror] ${err.message}`));
  page.on('requestfailed', (req) => {
    pageLogs.push(`[requestfailed] ${req.url()} — ${req.failure()?.errorText || 'unknown'}`);
  });

  try {
    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
    await page.emulateMediaType('print');

    await page.evaluateOnNewDocument((injectedState) => {
      window.__WEPOSE_STATE__ = injectedState;
    }, state);

    const url = `${renderUrl}/print.html?direct=1`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });

    await page.waitForFunction('window.__PDF_READY__ === true', { timeout: READY_TIMEOUT_MS });

    const errorMsg = await page.evaluate(() => window.__PDF_ERROR__ || null);
    if (errorMsg) {
      throw new Error('Render gagal di halaman print: ' + errorMsg + ' | logs: ' + pageLogs.join(' ; '));
    }

    // PENTING: sejak Puppeteer v23, page.pdf() me-return Uint8Array,
    // BUKAN Node Buffer. Kalau langsung dilempar ke res.send() di Express,
    // Buffer.isBuffer() akan bernilai false, dan Express diam-diam
    // fallback ke res.json() — isi file jadi teks JSON angka byte,
    // bukan data biner PDF asli (walau Content-Type tetap "application/pdf").
    // Ini yang bikin file "ke-download sukses" tapi gagal dibuka.
    // Fix: bungkus eksplisit jadi Buffer Node yang sebenarnya.
    const pdfBuffer = Buffer.from(await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    }));

    // --- Validasi: jangan pernah kirim file yang bukan PDF beneran ---
    // File PDF valid selalu mulai dengan byte "%PDF-".
    const isValidPdf = Buffer.isBuffer(pdfBuffer)
      && pdfBuffer.length > 500 // PDF kosong/rusak biasanya cuma beberapa ratus byte
      && pdfBuffer.subarray(0, 5).toString('utf8') === '%PDF-';

    if (!isValidPdf) {
      console.error('[PDF INVALID] length =', pdfBuffer ? pdfBuffer.length : 'null', '| logs:', pageLogs.join(' ; '));
      throw new Error(
        'PDF yang dihasilkan tidak valid (kemungkinan render timeout / crash di tengah proses). ' +
        'Cek Vercel function logs untuk detail. Logs halaman: ' + pageLogs.join(' ; ')
      );
    }

    console.log('[PDF OK] length =', pdfBuffer.length, 'bytes');
    return pdfBuffer;
  } catch (err) {
    console.error('[PDF RENDER ERROR]', err.message, '| logs:', pageLogs.join(' ; '));
    throw err;
  } finally {
    await page.close();
    if (localServer) {
      try {
        localServer.close();
        console.log('[PDF] Temporary local server stopped');
      } catch (closeErr) {
        console.error('[PDF] Failed to close temporary local server:', closeErr);
      }
    }
  }
}

async function shutdown() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser) await browser.close();
    browserPromise = null;
  }
}

module.exports = { renderPdfFromState, shutdown };

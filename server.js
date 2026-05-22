const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const API_TOKEN = (process.env.API_TOKEN || "").trim();

app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

function auth(req, res, next) {
  if (!API_TOKEN) return next();
  const h = (req.headers.authorization || "").trim();
  if (h === `Bearer ${API_TOKEN}`) return next();
  return res.status(401).json({ status: "ERRO", message: "Unauthorized" });
}

app.post("/emitir-certidao", auth, async (req, res) => {
  const cnpjRaw = String(req.body?.cnpj || "");
  const cnpj = cnpjRaw.replace(/\D/g, "");
  if (cnpj.length !== 14) {
    return res.status(400).json({ status: "ERRO", message: "CNPJ inválido (precisa 14 dígitos)" });
  }

  const url = "https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj";

  let browser;
  try {
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      acceptDownloads: true,
    });

    const page = await context.newPage();

    async function safeCount(locator) {
      try { return await locator.count(); } catch { return 0; }
    }

    async function tryClickCookieButtons() {
      const candidates = [
        /aceitar/i,
        /aceitar cookies/i,
        /aceitar todos/i,
        /concordo/i,
        /prosseguir/i,
        /fechar/i,
        /ok/i,
        /continuar/i,
        /permitir/i,
      ];

      for (const re of candidates) {
        try {
          const btn = page.getByRole("button", { name: re });
          if ((await btn.count().catch(() => 0)) > 0) {
            await btn.first().click({ timeout: 1500 }).catch(() => {});
            await page.waitForTimeout(300);
          }
        } catch {}
      }

      for (const re of candidates) {
        try {
          const el = page.getByText(re, { exact: false });
          if ((await el.count().catch(() => 0)) > 0) {
            await el.first().click({ timeout: 1500 }).catch(() => {});
            await page.waitForTimeout(300);
          }
        } catch {}
      }

      // extra: qualquer botão com "Aceitar"
      try {
        const btnAceitar = page.locator('button:has-text("Aceitar")');
        if ((await btnAceitar.count().catch(() => 0)) > 0) {
          await btnAceitar.first().click({ timeout: 1500 }).catch(() => {});
          await page.waitForTimeout(300);
        }
      } catch {}
    }

    async function respondWithDownload(download, message) {
      const fileName = await download.suggestedFilename();
      const filePath = `/tmp/${cnpj}-${Date.now()}-${fileName}`;
      await download.saveAs(filePath);
      const pdfBase64 = fs.readFileSync(filePath).toString("base64");

      await browser.close();
      return res.status(200).json({
        status: "EMITIDA",
        message,
        fileName,
        pdfBase64,
      });
    }

    async function respondWithBuffer(buffer, fileName, message) {
      const pdfBase64 = Buffer.from(buffer).toString("base64");
      await browser.close();
      return res.status(200).json({
        status: "EMITIDA",
        message,
        fileName: fileName || `certidao-${cnpj}-${Date.now()}.pdf`,
        pdfBase64,
      });
    }

    // 🔥 Tenta baixar PDF na página de resultado:
    // 1) clica link e espera download
    // 2) pega href e baixa via context.request.get (mantém cookies/sessão)
    // 3) se abrir popup/aba, captura PDF pela response
    async function downloadFromResultPage() {
      const linkSelector =
        'a:has-text("download do documento PDF"), a:has-text("documento PDF"), a:has-text("PDF da certidão"), a:has-text("PDF da certidao")';

      const link = page.locator(linkSelector).first();
      if ((await link.count().catch(() => 0)) === 0) return null;

      // 1) tentar download event direto
      const dl = page.waitForEvent("download", { timeout: 20000 }).catch(() => null);
      await link.click().catch(() => {});
      const d = await dl;
      if (d) return { mode: "download", download: d };

      // 2) tentar baixar pelo href usando request do context (com cookies)
      const href = await link.getAttribute("href").catch(() => null);
      if (href) {
        const absolute = href.startsWith("http")
          ? href
          : new URL(href, page.url()).toString();

        const resp = await context.request.get(absolute).catch(() => null);
        if (resp && resp.ok()) {
          const ct = (resp.headers()["content-type"] || "").toLowerCase();
          if (ct.includes("application/pdf")) {
            const buf = await resp.body();
            return { mode: "buffer", buffer: buf, fileName: `certidao-${cnpj}-${Date.now()}.pdf` };
          }
        }
      }

      // 3) popup/aba nova (alguns links abrem nova page)
      const popupPromise = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
      await link.click().catch(() => {});
      const popup = await popupPromise;

      if (popup) {
        const pdfResp = await popup
          .waitForResponse((r) => {
            const ct = (r.headers()["content-type"] || "").toLowerCase();
            return ct.includes("application/pdf") && r.status() >= 200 && r.status() < 300;
          }, { timeout: 20000 })
          .catch(() => null);

        if (pdfResp) {
          const buf = await pdfResp.body().catch(() => null);
          if (buf) return { mode: "buffer", buffer: buf, fileName: `certidao-${cnpj}-${Date.now()}.pdf` };
        }
      }

      return null;
    }

    // --------- execução ---------
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    await page.waitForTimeout(800);
    await tryClickCookieButtons();
    await page.waitForTimeout(800);
    await tryClickCookieButtons();
    await page.waitForTimeout(800);

    const inputSelector =
      'input[placeholder*="CNPJ"], input[aria-label*="CNPJ"], input[inputmode="numeric"]';

    await page.waitForSelector(inputSelector, { timeout: 20000 });
    await page.fill(inputSelector, cnpj);
    await page.waitForTimeout(300);

    const emitirSelector = 'button:has-text("Emitir Certidão")';
    await tryClickCookieButtons();

    const dl1 = page.waitForEvent("download", { timeout: 25000 }).catch(() => null);
    await page.click(emitirSelector).catch(() => {});
    await page.waitForTimeout(1200);

    // Modal "Certidão Válida Encontrada"
    const modalExists = (await safeCount(page.locator("text=Certidão Válida Encontrada"))) > 0;
    if (modalExists) {
      await tryClickCookieButtons();
      const dl2 = page.waitForEvent("download", { timeout: 25000 }).catch(() => null);
      await page.click('button:has-text("Emitir Nova Certidão")').catch(() => {});
      const d2 = await dl2;
      if (d2) return await respondWithDownload(d2, "Emitida via modal (Emitir Nova Certidão) - download automático");

      const resultDl2 = await downloadFromResultPage();
      if (resultDl2?.mode === "download") return await respondWithDownload(resultDl2.download, "Emitida via modal - download pelo link/resultado");
      if (resultDl2?.mode === "buffer") return await respondWithBuffer(resultDl2.buffer, resultDl2.fileName, "Emitida via modal - PDF capturado via link/resultado");
    }

    // Download automático após "Emitir Certidão"
    const d1 = await dl1;
    if (d1) return await respondWithDownload(d1, "Emitida - download automático");

    // Sem download automático → tenta pelo resultado
    const resultDl1 = await downloadFromResultPage();
    if (resultDl1?.mode === "download") return await respondWithDownload(resultDl1.download, "Emitida - download pelo link/resultado");
    if (resultDl1?.mode === "buffer") return await respondWithBuffer(resultDl1.buffer, resultDl1.fileName, "Emitida - PDF capturado via link/resultado");

    // Se chegou aqui, não conseguiu capturar PDF. Retorna diagnóstico.
    const bodyText = await page.textContent("body").catch(() => "");
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    await browser.close();

    return res.status(200).json({
      status: "NAO_EMITIDA",
      message: "Sem download do PDF (pode haver pendência/débito, cookies bloqueando ou fluxo diferente)",
      fileName: "",
      pdfBase64: "",
      currentUrl,
      pageTitle,
      debugSnippet: (bodyText || "").slice(0, 2000),
    });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ status: "ERRO", message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`rf-certidao-service running on port ${PORT}`);
});

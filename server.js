// server.js (com cookies + emissão + download pelo link da página de resultado)

const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const API_TOKEN = (process.env.API_TOKEN || "").trim();

// Healthcheck
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

function auth(req, res, next) {
  if (!API_TOKEN) return next(); // se não definir token, fica aberto
  const h = (req.headers.authorization || "").trim();
  if (h === `Bearer ${API_TOKEN}`) return next();
  return res.status(401).json({ status: "ERRO", message: "Unauthorized" });
}

app.post("/emitir-certidao", auth, async (req, res) => {
  const cnpjRaw = String(req.body?.cnpj || "");
  const cnpj = cnpjRaw.replace(/\D/g, "");

  if (cnpj.length !== 14) {
    return res
      .status(400)
      .json({ status: "ERRO", message: "CNPJ inválido (precisa 14 dígitos)" });
  }

  const url =
    "https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj";

  let browser;
  try {
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      acceptDownloads: true,
      // userAgent opcional (às vezes ajuda com sites mais chatos)
      // userAgent:
      //   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    });

    const page = await context.newPage();

    // ---------------- Helpers ----------------

    async function safeCount(locator) {
      try {
        return await locator.count();
      } catch {
        return 0;
      }
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

      // tenta por role button
      for (const re of candidates) {
        try {
          const btn = page.getByRole("button", { name: re });
          const count = await btn.count().catch(() => 0);
          if (count > 0) {
            await btn.first().click({ timeout: 1500 }).catch(() => {});
            await page.waitForTimeout(400);
          }
        } catch {}
      }

      // fallback por texto
      for (const re of candidates) {
        try {
          const el = page.getByText(re, { exact: false });
          const count = await el.count().catch(() => 0);
          if (count > 0) {
            await el.first().click({ timeout: 1500 }).catch(() => {});
            await page.waitForTimeout(400);
          }
        } catch {}
      }

      // fallback extra: qualquer botão com "Aceitar"
      try {
        const btnAceitar = page.locator('button:has-text("Aceitar")');
        if ((await btnAceitar.count().catch(() => 0)) > 0) {
          await btnAceitar.first().click({ timeout: 1500 }).catch(() => {});
          await page.waitForTimeout(300);
        }
      } catch {}
    }

    /**
     * Tenta baixar o PDF a partir da página de resultado
     * ("Resultado da Emissão de Certidão"), clicando no link de download.
     * Retorna:
     *  - { mode: "download", download } se disparar evento download
     *  - { mode: "inline", buffer, fileName } se vier PDF inline (response application/pdf)
     *  - null se não encontrar o link / não conseguir baixar
     */
    async function downloadFromResultPage() {
      // o texto pode variar, então colocamos várias opções
      const linkSelector =
        'a:has-text("download do documento PDF"), a:has-text("download do documento PDF da certidão"), a:has-text("documento PDF da certidão"), a:has-text("documento PDF")';

      const link = page.locator(linkSelector).first();
      const hasLink = (await link.count().catch(() => 0)) > 0;

      if (!hasLink) return null;

      // tenta como download real
      const dl = page
        .waitForEvent("download", { timeout: 25000 })
        .catch(() => null);

      await link.click().catch(() => {});
      const download = await dl;

      if (download) {
        return { mode: "download", download };
      }

      // fallback: às vezes abre PDF inline (sem download event)
      const pdfResp = await page
        .waitForResponse(
          (r) => {
            const ct = (r.headers()["content-type"] || "").toLowerCase();
            return (
              ct.includes("application/pdf") &&
              r.status() >= 200 &&
              r.status() < 300
            );
          },
          { timeout: 25000 }
        )
        .catch(() => null);

      if (!pdfResp) return null;

      const buf = await pdfResp.body().catch(() => null);
      if (!buf) return null;

      return {
        mode: "inline",
        buffer: buf,
        fileName: `certidao-${cnpj}-${Date.now()}.pdf`,
      };
    }

    /**
     * Normaliza saída "EMITIDA" salvando um download
     */
    async function respondWithDownload(download, msgPrefix) {
      const fileName = await download.suggestedFilename();
      const filePath = `/tmp/${cnpj}-${Date.now()}-${fileName}`;
      await download.saveAs(filePath);

      const pdfBase64 = fs.readFileSync(filePath).toString("base64");

      await browser.close();
      return res.status(200).json({
        status: "EMITIDA",
        message: msgPrefix,
        fileName,
        pdfBase64,
      });
    }

    /**
     * Normaliza saída "EMITIDA" salvando buffer inline
     */
    async function respondWithInlineBuffer(buffer, fileName, msgPrefix) {
      const pdfBase64 = Buffer.from(buffer).toString("base64");

      await browser.close();
      return res.status(200).json({
        status: "EMITIDA",
        message: msgPrefix,
        fileName: fileName || `certidao-${cnpj}-${Date.now()}.pdf`,
        pdfBase64,
      });
    }

    // ---------------- Navegação ----------------

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // cookies podem aparecer atrasados
    await page.waitForTimeout(800);
    await tryClickCookieButtons();
    await page.waitForTimeout(800);
    await tryClickCookieButtons();
    await page.waitForTimeout(1200);

    // input do CNPJ (evita pegar qualquer input do site)
    const inputSelector =
      'input[placeholder*="CNPJ"], input[aria-label*="CNPJ"], input[inputmode="numeric"]';
    await page.waitForSelector(inputSelector, { timeout: 20000 });
    await page.fill(inputSelector, cnpj);

    await page.waitForTimeout(300);

    const emitirSelector = 'button:has-text("Emitir Certidão")';

    // garante que cookie/overlay não bloqueia o clique
    await tryClickCookieButtons();

    // arma captura do download antes do clique
    const dl1 = page
      .waitForEvent("download", { timeout: 25000 })
      .catch(() => null);

    await page.click(emitirSelector);

    await page.waitForTimeout(1200);

    // Se aparecer o modal "Certidão Válida Encontrada"
    const modalExists =
      (await safeCount(page.locator("text=Certidão Válida Encontrada"))) > 0;

    if (modalExists) {
      await tryClickCookieButtons(); // por segurança

      const dl2 = page
        .waitForEvent("download", { timeout: 25000 })
        .catch(() => null);

      await page.click('button:has-text("Emitir Nova Certidão")');

      const d2 = await dl2;
      if (d2) {
        return await respondWithDownload(
          d2,
          "Emitida via modal (Emitir Nova Certidão) - download automático"
        );
      }

      // ✅ Se não baixou automaticamente, tenta baixar pelo link da página de resultado
      const resultDl2 = await downloadFromResultPage();
      if (resultDl2?.mode === "download") {
        return await respondWithDownload(
          resultDl2.download,
          "Emitida via modal (Emitir Nova Certidão) - download pelo link do resultado"
        );
      }
      if (resultDl2?.mode === "inline") {
        return await respondWithInlineBuffer(
          resultDl2.buffer,
          resultDl2.fileName,
          "Emitida via modal (Emitir Nova Certidão) - PDF capturado inline pelo resultado"
        );
      }
    }

    // Caso normal (download direto após "Emitir Certidão")
    const d1 = await dl1;
    if (d1) {
      return await respondWithDownload(
        d1,
        "Emitida via botão Emitir Certidão - download automático"
      );
    }

    // ✅ Se não baixou automaticamente, tenta baixar pelo link da página de resultado
    const resultDl1 = await downloadFromResultPage();
    if (resultDl1?.mode === "download") {
      return await respondWithDownload(
        resultDl1.download,
        "Emitida - download pelo link do resultado"
      );
    }
    if (resultDl1?.mode === "inline") {
      return await respondWithInlineBuffer(
        resultDl1.buffer,
        resultDl1.fileName,
        "Emitida - PDF capturado inline pelo resultado"
      );
    }

    // Sem download: provável pendência / fluxo diferente / bloqueio
    const bodyText = await page.textContent("body").catch(() => "");
    await browser.close();

    return res.status(200).json({
      status: "NAO_EMITIDA",
      message:
        "Sem download do PDF (pode haver pendência/débito, cookies bloqueando ou fluxo diferente)",
      fileName: "",
      pdfBase64: "",
      debugSnippet: (bodyText || "").slice(0, 1200),
    });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ status: "ERRO", message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`rf-certidao-service running on port ${PORT}`);
});

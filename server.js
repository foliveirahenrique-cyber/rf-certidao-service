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
    });

    const page = await context.newPage();

    // ---------- helpers ----------
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

      // role button
      for (const re of candidates) {
        try {
          const btn = page.getByRole("button", { name: re });
          if ((await btn.count().catch(() => 0)) > 0) {
            await btn.first().click({ timeout: 1500 }).catch(() => {});
            await page.waitForTimeout(250);
          }
        } catch {}
      }

      // text fallback
      for (const re of candidates) {
        try {
          const el = page.getByText(re, { exact: false });
          if ((await el.count().catch(() => 0)) > 0) {
            await el.first().click({ timeout: 1500 }).catch(() => {});
            await page.waitForTimeout(250);
          }
        } catch {}
      }

      // extra: qualquer botão com "Aceitar"
      try {
        const btnAceitar = page.locator('button:has-text("Aceitar")');
        if ((await btnAceitar.count().catch(() => 0)) > 0) {
          await btnAceitar.first().click({ timeout: 1500 }).catch(() => {});
          await page.waitForTimeout(250);
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
        fileName: fileName || `Certidao-${cnpj}.pdf`,
        pdfBase64,
      });
    }

    // ✅ Captura PDF pela rede (resolve “Salvar como”/PDF inline/attachment)
    async function waitForPdfResponse(timeoutMs = 45000) {
      const resp = await page
        .waitForResponse(
          (r) => {
            const headers = r.headers();
            const ct = (headers["content-type"] || "").toLowerCase();
            const cd = (headers["content-disposition"] || "").toLowerCase();
            const u = (r.url() || "").toLowerCase();

            const looksLikePdfByType = ct.includes("application/pdf");
            const looksLikeAttachmentPdf =
              cd.includes("attachment") && (cd.includes(".pdf") || cd.includes("pdf"));
            const looksLikePdfByUrl = u.includes("pdf") || u.includes("certidao");

            return (
              (looksLikePdfByType || looksLikeAttachmentPdf || looksLikePdfByUrl) &&
              r.status() >= 200 &&
              r.status() < 300
            );
          },
          { timeout: timeoutMs }
        )
        .catch(() => null);

      if (!resp) return null;

      const buf = await resp.body().catch(() => null);
      if (!buf || buf.length < 1000) return null;
      return buf;
    }

    async function waitForResultPageOrPdfLink() {
      const resultTitle = page.locator("text=Resultado da Emissão de Certidão");
      const pdfLinkByText = page.locator('a:has-text("PDF")');
      const pdfLinkByRole = page.getByRole("link", { name: /pdf/i });

      const start = Date.now();
      while (Date.now() - start < 25000) {
        if ((await resultTitle.count().catch(() => 0)) > 0) return true;
        if ((await pdfLinkByText.count().catch(() => 0)) > 0) return true;
        if ((await pdfLinkByRole.count().catch(() => 0)) > 0) return true;
        await page.waitForTimeout(400);
      }
      return false;
    }

    async function downloadFromResultPage() {
      const linkCandidates = [
        page.getByRole("link", { name: /download.*pdf/i }),
        page.getByRole("link", { name: /pdf/i }),
        page.locator('a:has-text("download do documento PDF")'),
        page.locator('a:has-text("documento PDF")'),
        page.locator('a:has-text("PDF da certidão")'),
        page.locator('a:has-text("PDF da certidao")'),
        page.locator("a[href*='pdf' i]"),
        page.locator("a[href*='download' i]"),
      ];

      let link = null;
      for (const cand of linkCandidates) {
        if ((await cand.count().catch(() => 0)) > 0) {
          link = cand.first();
          break;
        }
      }
      if (!link) return null;

      // 1) tentar download event
      const dl = page
        .waitForEvent("download", { timeout: 20000 })
        .catch(() => null);
      await link.click().catch(() => {});
      const d = await dl;
      if (d) return { mode: "download", download: d };

      // 2) tentar baixar via href usando request do context
      const href = await link.getAttribute("href").catch(() => null);
      if (href) {
        const absolute = href.startsWith("http")
          ? href
          : new URL(href, page.url()).toString();

        const resp = await context.request.get(absolute).catch(() => null);
        if (resp && resp.ok()) {
          const headers = resp.headers();
          const ct = (headers["content-type"] || "").toLowerCase();
          const cd = (headers["content-disposition"] || "").toLowerCase();

          if (ct.includes("application/pdf") || cd.includes(".pdf") || cd.includes("attachment")) {
            const buf = await resp.body();
            return { mode: "buffer", buffer: buf, fileName: `Certidao-${cnpj}.pdf` };
          }
        }
      }

      return null;
    }

    // ---------- execução ----------
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // cookies podem aparecer atrasados
    await page.waitForTimeout(800);
    await tryClickCookieButtons();
    await page.waitForTimeout(800);
    await tryClickCookieButtons();
    await page.waitForTimeout(800);

    // ======== BLOCO ROBUSTO (substitui o antigo page.fill + page.click) ========
    const cnpjDigits = cnpj;

    let cnpjInput = page.locator('input[placeholder*="CNPJ"]').first();
    if ((await cnpjInput.count().catch(() => 0)) === 0) {
      cnpjInput = page.locator('input[inputmode="numeric"]').first();
    }
    if ((await cnpjInput.count().catch(() => 0)) === 0) {
      cnpjInput = page.locator("form input").first();
    }

    await cnpjInput.waitFor({ timeout: 20000 });
    await cnpjInput.fill("");
    await cnpjInput.type(cnpjDigits, { delay: 30 });
    await cnpjInput.press("Tab").catch(() => {});
    await page.waitForTimeout(400);

    await tryClickCookieButtons();

    const emitirBtn = page.getByRole("button", { name: /emitir certidão/i });
    await emitirBtn.waitFor({ timeout: 20000 });
    await emitirBtn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(200);

    const isDisabled =
      (await emitirBtn.isDisabled().catch(() => false)) ||
      (await emitirBtn.getAttribute("disabled").catch(() => null)) !== null;

    if (isDisabled) {
      await cnpjInput.focus().catch(() => {});
      await cnpjInput.press("Tab").catch(() => {});
      await page.waitForTimeout(500);
    }

    // ✅ dl1 tem que existir aqui (antes do clique), porque usamos depois
    const dl1 = page.waitForEvent("download", { timeout: 25000 }).catch(() => null);

    await emitirBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);

    const modalPromise = page
      .locator("text=Certidão Válida Encontrada")
      .waitFor({ timeout: 15000 })
      .then(() => "MODAL")
      .catch(() => null);

    const urlPromise = page
      .waitForURL((u) => !u.toString().includes("#/home/cnpj"), { timeout: 15000 })
      .then(() => "NAV")
      .catch(() => null);

    const outcome = await Promise.race([modalPromise, urlPromise]);

    if (!outcome) {
      const currentUrl = page.url();
      const pageTitle = await page.title().catch(() => "");
      const inputVal = await cnpjInput.inputValue().catch(() => "");
      const btnDisabled2 = await emitirBtn.isDisabled().catch(() => null);
      const bodyText = await page.textContent("body").catch(() => "");

      await browser.close();
      return res.status(200).json({
        status: "NAO_EMITIDA",
        message: "Não conseguiu acionar o clique em 'Emitir Certidão' (sem modal e sem navegação).",
        fileName: "",
        pdfBase64: "",
        currentUrl,
        pageTitle,
        debug: { inputVal, btnDisabled: btnDisabled2 },
        debugSnippet: (bodyText || "").slice(0, 2000),
      });
    }
    // ======== FIM DO BLOCO ROBUSTO ========

    // modal “Certidão Válida Encontrada”
    const modalExists =
      (await safeCount(page.locator("text=Certidão Válida Encontrada"))) > 0;

    if (modalExists) {
      await tryClickCookieButtons();

      // ✅ arma captura de PDF antes do clique (resolve "Salvar como")
      const pdfPromise = waitForPdfResponse(45000);

      // ainda tentamos download event
      const dl2 = page.waitForEvent("download", { timeout: 25000 }).catch(() => null);

      await page.click('button:has-text("Emitir Nova Certidão")').catch(() => {});

      await waitForResultPageOrPdfLink();
      await tryClickCookieButtons();

      const d2 = await dl2;
      if (d2) {
        return await respondWithDownload(
          d2,
          "Emitida via modal (Emitir Nova Certidão) - download automático"
        );
      }

      const pdfBuf = await pdfPromise;
      if (pdfBuf) {
        return await respondWithBuffer(
          pdfBuf,
          `Certidao-${cnpj}.pdf`,
          "Emitida via modal (Emitir Nova Certidão) - PDF capturado por response"
        );
      }

      const resultDl2 = await downloadFromResultPage();
      if (resultDl2?.mode === "download") {
        return await respondWithDownload(
          resultDl2.download,
          "Emitida via modal - download pelo link/resultado"
        );
      }
      if (resultDl2?.mode === "buffer") {
        return await respondWithBuffer(
          resultDl2.buffer,
          resultDl2.fileName,
          "Emitida via modal - PDF capturado via link/resultado"
        );
      }
    }

    // fluxo sem modal: se baixou automático ao clicar Emitir Certidão
    const d1 = await dl1;
    if (d1) return await respondWithDownload(d1, "Emitida - download automático");

    await waitForResultPageOrPdfLink();
    await tryClickCookieButtons();

    const pdfBufNoModal = await waitForPdfResponse(25000);
    if (pdfBufNoModal) {
      return await respondWithBuffer(
        pdfBufNoModal,
        `Certidao-${cnpj}.pdf`,
        "Emitida - PDF capturado por response"
      );
    }

    const resultDl1 = await downloadFromResultPage();
    if (resultDl1?.mode === "download")
      return await respondWithDownload(
        resultDl1.download,
        "Emitida - download pelo link/resultado"
      );
    if (resultDl1?.mode === "buffer")
      return await respondWithBuffer(
        resultDl1.buffer,
        resultDl1.fileName,
        "Emitida - PDF capturado via link/resultado"
      );

    // diagnóstico final
    const bodyText = await page.textContent("body").catch(() => "");
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    await browser.close();

    return res.status(200).json({
      status: "NAO_EMITIDA",
      message:
        "Sem download do PDF (pode haver pendência/débito, cookies bloqueando ou fluxo diferente)",
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

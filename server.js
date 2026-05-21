const express = require("express");
const { chromium } = require("playwright");

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
    return res.status(400).json({ status: "ERRO", message: "CNPJ inválido (precisa 14 dígitos)" });
  }

  const url = "https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj";

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(800);

    const inputSelector = 'input[placeholder*="CNPJ"], input[aria-label*="CNPJ"], input';
    await page.waitForSelector(inputSelector, { timeout: 20000 });
    await page.fill(inputSelector, cnpj);

    const emitirSelector = 'button:has-text("Emitir Certidão")';
    const dl1 = page.waitForEvent("download", { timeout: 25000 }).catch(() => null);
    await page.click(emitirSelector);

    await page.waitForTimeout(1200);

    const modalExists = await page.locator("text=Certidão Válida Encontrada").count().catch(() => 0);
    if (modalExists > 0) {
      const dl2 = page.waitForEvent("download", { timeout: 25000 }).catch(() => null);
      await page.click('button:has-text("Emitir Nova Certidão")');
      const d2 = await dl2;

      if (d2) {
        const fileName = await d2.suggestedFilename();
        const filePath = `/tmp/${cnpj}-${Date.now()}-${fileName}`;
        await d2.saveAs(filePath);

        const fs = require("fs");
        const pdfBase64 = fs.readFileSync(filePath).toString("base64");

        await browser.close();
        return res.status(200).json({
          status: "EMITIDA",
          message: "Emitida via modal (Emitir Nova Certidão)",
          fileName,
          pdfBase64
        });
      }
    }

    const d1 = await dl1;
    if (d1) {
      const fileName = await d1.suggestedFilename();
      const filePath = `/tmp/${cnpj}-${Date.now()}-${fileName}`;
      await d1.saveAs(filePath);

      const fs = require("fs");
      const pdfBase64 = fs.readFileSync(filePath).toString("base64");

      await browser.close();
      return res.status(200).json({
        status: "EMITIDA",
        message: "Emitida via botão Emitir Certidão",
        fileName,
        pdfBase64
      });
    }

    const bodyText = await page.textContent("body").catch(() => "");
    await browser.close();

    return res.status(200).json({
      status: "NAO_EMITIDA",
      message: "Sem download do PDF (pode haver pendência/débito ou fluxo diferente)",
      fileName: "",
      pdfBase64: "",
      debugSnippet: (bodyText || "").slice(0, 800)
    });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ status: "ERRO", message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`rf-certidao-service running on port ${PORT}`);
});

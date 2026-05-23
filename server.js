const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "25mb" })); // base64 pode ser grande

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

function normalizeCnpj(cnpjRaw) {
  return String(cnpjRaw || "").replace(/\D/g, "");
}

async function safeClose(browser) {
  try { await browser?.close(); } catch (_) {}
}

function has023(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("por favor, tente novamente") ||
    t.includes("não foi possível concluir a ação") ||
    t.includes(" 023") ||
    t.includes("023 -")
  );
}

app.post("/emitir-certidao", auth, async (req, res) => {
  const cnpjRaw = String(req.body?.cnpj || "");
  const cnpj = normalizeCnpj(cnpjRaw);
  const includePdf = !!req.body?.includePdf;

  if (!cnpj || cnpj.length !== 14) {
    return res.status(400).json({
      status: "ERRO",
      message: "CNPJ inválido (precisa ter 14 dígitos)",
      cnpjRaw,
      cnpj,
    });
  }

  // Se includePdf=false, você pode optar por só consultar status
  // Mas como seu n8n pede pdf, vamos tentar baixar sempre que includePdf=true
  if (!includePdf) {
    return res.status(200).json({
      status: "OK",
      message: "includePdf=false (nenhum PDF gerado).",
      cnpj,
      fileName: "",
      pdfBase64: "",
    });
  }

  const URL = "https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj";

  let browser;
  let page;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1280, height: 720 },
    });

    page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(URL, { waitUntil: "domcontentloaded" });

    // (Opcional) tentar fechar/aceitar cookies se aparecer (não quebra se não existir)
    await page.locator("text=Aceitar").first().click({ timeout: 2000 }).catch(() => {});
    await page.locator("text=Concordo").first().click({ timeout: 2000 }).catch(() => {});

    // Seletores do input CNPJ (tentamos vários pra ficar robusto)
    const inputCandidates = [
      'input[placeholder*="Informe o CNPJ"]',
      'input[aria-label*="CNPJ"]',
      'input[name="cnpj"]',
      'input[type="text"]',
    ];

    let filled = false;
    for (const sel of inputCandidates) {
      const loc = page.locator(sel).first();
      if (await loc.count().catch(() => 0)) {
        await loc.fill(cnpj).catch(() => {});
        const v = await loc.inputValue().catch(() => "");
        if (v && v.replace(/\D/g, "").includes(cnpj.slice(0, 8))) {
          filled = true;
          break;
        }
      }
    }

    if (!filled) {
      const html = await page.content().catch(() => "");
      return res.status(500).json({
        status: "NAO_EMITIDA",
        message: "Não achei o campo de CNPJ para preencher.",
        currentUrl: page.url(),
        pageTitle: await page.title().catch(() => ""),
        debugSnippet: html.replace(/\s+/g, " ").slice(0, 2000),
        fileName: "",
        pdfBase64: "",
      });
    }

    // Clique "Emitir Certidão"
    await page.locator('button:has-text("Emitir Certidão")').first().click();

    // Espera um pouco por qualquer reação (modal/aviso)
    await page.waitForTimeout(1500);

    const bodyText = await page.textContent("body").catch(() => "");
    if (has023(bodyText)) {
      // ERRO TEMPORÁRIO -> n8n faz retry
      return res.status(503).json({
        status: "ERRO_TEMPORARIO",
        message: "Receita indisponível/bloqueou a ação (023). Tente novamente em alguns minutos.",
        currentUrl: page.url(),
        pageTitle: await page.title().catch(() => ""),
        debugSnippet: bodyText.replace(/\s+/g, " ").slice(0, 2000),
        fileName: "",
        pdfBase64: "",
      });
    }

    // Se aparecer modal "Certidão Válida Encontrada"
    const modalTitle = page.locator('text=Certidão Válida Encontrada');
    const modalExists = await modalTitle.count().catch(() => 0);

    // O clique que dispara o download pode variar.
    // Estratégia:
    // - se modal: tenta "Emitir Nova Certidão" primeiro (como você mostrou)
    // - se não modal: tenta capturar download após algum botão que gere o PDF.
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });

    if (modalExists) {
      // tenta clicar no botão do modal
      const btnNova = page.locator('button:has-text("Emitir Nova Certidão")').first();
      if (await btnNova.count().catch(() => 0)) {
        await btnNova.click();
      } else {
        // fallback: se não existir, tenta "Consultar Certidão"
        await page.locator('button:has-text("Consultar Certidão")').first().click();
      }
    } else {
      // Sem modal: tenta algum caminho que gere PDF
      // Alguns fluxos geram o PDF ao clicar "Consultar Certidão"
      const btnConsultar = page.locator('button:has-text("Consultar Certidão")').first();
      if (await btnConsultar.count().catch(() => 0)) {
        await btnConsultar.click();
      } else {
        // Se não houver, tenta novamente emitir (às vezes o primeiro clique só valida)
        await page.locator('button:has-text("Emitir Certidão")').first().click().catch(() => {});
      }
    }

    // Aguarda download
    const download = await downloadPromise;
    const filePath = await download.path();
    const suggested = download.suggestedFilename() || `Certidao-${cnpj}.pdf`;

    if (!filePath || !fs.existsSync(filePath)) {
      const html = await page.content().catch(() => "");
      return res.status(500).json({
        status: "NAO_EMITIDA",
        message: "Download não gerou arquivo (path vazio/inexistente).",
        currentUrl: page.url(),
        pageTitle: await page.title().catch(() => ""),
        debugSnippet: html.replace(/\s+/g, " ").slice(0, 2000),
        fileName: "",
        pdfBase64: "",
      });
    }

    const buffer = fs.readFileSync(filePath);
    const pdfBase64 = buffer.toString("base64");

    return res.status(200).json({
      status: "OK",
      message: "Certidão gerada com sucesso.",
      fileName: suggested,
      pdfBase64,
      currentUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
    });
  } catch (err) {
    const msg = err?.message || String(err);
    const snippet = page ? await page.textContent("body").catch(() => "") : "";
    return res.status(500).json({
      status: "NAO_EMITIDA",
      message: msg,
      currentUrl: page?.url?.() || "",
      pageTitle: page ? await page.title().catch(() => "") : "",
      debugSnippet: String(snippet).replace(/\s+/g, " ").slice(0, 2000),
      fileName: "",
      pdfBase64: "",
    });
  } finally {
    await safeClose(browser);
  }
});

app.listen(PORT, () => console.log(`rf-certidao-service listening on ${PORT}`));

/**
 * Booking.com scraper
 * --------------------
 * Récupère UNIQUEMENT la note (rating) et le nombre d'avis (count)
 * pour une liste d'hôtels, puis écrit/met à jour ./hotels.json
 *
 * Stratégie anti-blocage :
 *   - Playwright + Chromium headless
 *   - User-Agent réaliste (Chrome Desktop)
 *   - locale fr-FR + Accept-Language fr
 *   - viewport desktop standard
 *   - délai aléatoire entre 2 et 5s entre chaque hôtel
 *
 * Stratégie de sélection (robuste aux changements de classes obfusquées) :
 *   On s'appuie en priorité sur data-testid="review-score-component"
 *   puis sur des aria-label ("Score X.Y") et enfin sur du text-matching
 *   (regex sur "avis" / "reviews").
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OUTPUT_FILE = path.join(__dirname, "hotels.json");

// User-Agent Chrome Desktop récent (évite le blocage immédiat)
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Délai (ms) entre 2 hôtels pour rester discret
const MIN_DELAY = 2000;
const MAX_DELAY = 5000;

// Liste des hôtels à scraper (clé -> URL Booking)
// Pour ajouter un 8ème hôtel, ajoutez simplement une ligne ici.
const HOTELS = {
  hotel_1_Rotana:
    "https://www.booking.com/hotel/sa/al-manakha-rotana-madinah-madinah.fr.html?aid=2405329&label=brave_brand_organic_trigger_33bbf676-98fd-4780-a85d-abfc75863c4c_0&sid=ed0c990fde61572d978232e6e7d3f889&dest_id=-3092186&dest_type=city&dist=0&group_adults=2&group_children=0&hapos=1&hpos=1&no_rooms=1&req_adults=2&req_children=0&room1=A%2CA&sb_price_type=total&sr_order=popularity&srepoch=1783193890&srpvid=dd528a13a5751b91&type=total&ucfs=1&",
  hotel_2_Movenpick:
    "https://www.booking.com/hotel/sa/anwar-al-madinah-movenpick.fr.html?aid=2405329&label=brave_brand_organic_trigger_33bbf676-98fd-4780-a85d-abfc75863c4c_c58d20&sid=ed0c990fde61572d978232e6e7d3f889&dest_id=-3092186&dest_type=city&dist=0&group_adults=2&group_children=0&hapos=1&hpos=1&no_rooms=1&req_adults=2&req_children=0&room1=A%2CA&sb_price_type=total&sr_order=popularity&srepoch=1783193962&srpvid=cf238a39e8da02e1&type=total&ucfs=1&",
  hotel_3_NuskAlHijrah:
    "https://www.booking.com/hotel/sa/nsk-lhjr.fr.html?aid=2405612&label=mkt123sc-21e24450-3bd1-48e8-867c-62356f1400cf&sid=ed0c990fde61572d978232e6e7d3f889&dest_id=-3092186&dest_type=city&dist=0&group_adults=2&group_children=0&hapos=1&hpos=1&no_rooms=1&req_adults=2&req_children=0&room1=A%2CA&sb_price_type=total&sr_order=popularity&srepoch=1783194732&srpvid=1e7a8bb9352b02d1&type=total&ucfs=1&",
  hotel_4_makkah: "https://www.booking.com/hotel/sa/makkah-hotel.fr.html",
  hotel_5_conrad: "https://www.booking.com/hotel/sa/conrad-makkah.fr.html",
  hotel_6_DoubleTree:
    "https://www.booking.com/hotel/sa/doubletree-by-hilton-makkah-jabal-omar.fr.html?aid=2405329&label=brave_brand_organic_trigger_33bbf676-98fd-4780-a85d-abfc75863c4c_0&sid=ed0c990fde61572d978232e6e7d3f889&dest_id=-3096949&dest_type=city&dist=0&group_adults=2&group_children=0&hapos=1&hpos=1&no_rooms=1&req_adults=2&req_children=0&room1=A%2CA&sb_price_type=total&sr_order=popularity&srepoch=1783194883&srpvid=20578c0455281182&type=total&ucfs=1&",
  hotel_7_EBAA:
    "https://www.booking.com/searchresults.fr.html?aid=2405329&label=brave_brand_organic_trigger_33bbf676-98fd-4780-a85d-abfc75863c4c_0&highlighted_hotels=8668530&redirected=1&city=-3096949&hlrd=no_dates&source=hotel&expand_sb=1&keep_landing=1&sid=ed0c990fde61572d978232e6e7d3f889",
};

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () =>
  MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));

/**
 * Lit le hotels.json existant s'il existe (pour mise à jour / merge).
 */
function loadExisting() {
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
    }
  } catch (e) {
    console.warn(`⚠️  hotels.json illisible, on repart de zéro (${e.message})`);
  }
  return {};
}

// ---------------------------------------------------------------------------
// Extraction (exécutée DANS le navigateur via page.evaluate)
// ---------------------------------------------------------------------------

async function extractRatingAndCount(page) {
  // On attend qu'un composant de score apparaisse (ou timeout soft).
  try {
    await page.waitForSelector(
      '[data-testid="review-score-component"], [data-testid="review-score-link"], [data-testid="review-score"]',
      { timeout: 15000 }
    );
  } catch (_) {
    // On continue quand même : on tentera les fallbacks sur la page entière.
  }

  return page.evaluate(() => {
    const result = { rating: null, count: null };
    const txt = (el) => (el ? el.innerText || el.textContent || "" : "");

    // -------------------------------------------------------------------
    // Composant de score ciblé. Ordre de priorité :
    //   1) review-score-component  -> fiche hôtel
    //   2) review-score-link       -> page de résultats (hôtel mis en avant)
    //   3) review-score            -> variante
    // On prend le PREMIER du DOM : sur une page de résultats c'est l'hôtel
    // mis en avant (highlighted), sur une fiche c'est le bloc principal.
    // -------------------------------------------------------------------
    const scoreComponent = document.querySelector(
      '[data-testid="review-score-component"], ' +
        '[data-testid="review-score-link"], ' +
        '[data-testid="review-score"]'
    );

    // ---------------- RATING ----------------
    // Format Booking : "Avec une note de 8.4" ou "Avec une note de 8,4"
    // (note : séparateur point OU virgule selon la locale/page).
    const noteRe = /note\s+de\s+(\d+[.,]\d+)/i;

    // 1) Priorité au composant de score
    if (scoreComponent) {
      const m = txt(scoreComponent).match(noteRe);
      if (m) result.rating = m[1].replace(",", ".");
    }

    // 2) Fallback : n'importe quel "note de X.Y" sur la page
    if (!result.rating) {
      const m = (document.body.innerText || "").match(noteRe);
      if (m) result.rating = m[1].replace(",", ".");
    }

    // 3) Fallback : aria-label "Score X.Y"
    if (!result.rating) {
      for (const el of document.querySelectorAll("[aria-label]")) {
        const label = el.getAttribute("aria-label") || "";
        const m = label.match(/(\d+[.,]\d+)/);
        if (m && parseFloat(m[1].replace(",", ".")) <= 10) {
          result.rating = m[1].replace(",", ".");
          break;
        }
      }
    }

    // ---------------- COUNT ----------------
    // Booking utilise plusieurs libellés selon les pages :
    //   "8 708 expériences vécues"  (le plus courant sur les fiches FR)
    //   "8 708 avis" / "8 708 reviews" / "8 708 commentaires"
    // Regex : nombre (avec séparateurs de milliers) suivi du libellé.
    const reviewRe =
      /(\d[\d\s.,]*)\s*(exp[eé]riences\s+v[eé]cues?|exp[eé]riences|avis|reviews?|commentaires?|evaluaciones?|bewertungen?|opiniones?)/i;

    // 1) Priorité au composant de score (prend le 1er = bon hôtel)
    if (scoreComponent) {
      const m = txt(scoreComponent).match(reviewRe);
      if (m) result.count = m[1].replace(/[^\d]/g, "");
    }

    // 2) Fallback sur toute la page : on prend le MAX
    //    (le total d'avis est la plus grande valeur sur une fiche hôtel)
    if (!result.count) {
      const allText = document.body.innerText || "";
      const candidates = [];
      let m;
      const reGlobal = new RegExp(reviewRe.source, "gi");
      while ((m = reGlobal.exec(allText)) !== null) {
        const num = parseInt(m[1].replace(/[^\d]/g, ""), 10);
        if (!isNaN(num)) candidates.push(num);
      }
      if (candidates.length) {
        result.count = String(Math.max(...candidates));
      }
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Boucle principale
// ---------------------------------------------------------------------------

(async () => {
  console.log("🚀 Démarrage du scraper Booking\n");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "fr-FR",
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { "Accept-Language": "fr-FR,fr;q=0.9" },
  });

  // Anti-détection basique
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const results = loadExisting(); // merge avec l'existant

  for (const [name, url] of Object.entries(HOTELS)) {
    const page = await context.newPage();
    try {
      console.log(`🔎  ${name}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Petite pause pour laisser le JS charger le score
      await sleep(1500);

      const data = await extractRatingAndCount(page);

      results[name] = { rating: data.rating, count: data.count };
      console.log(
        `     ➜ rating: ${data.rating ?? "❌"}  |  count: ${data.count ?? "❌"}`
      );
    } catch (err) {
      console.error(`     ⛔ Erreur : ${err.message}`);
      results[name] = { rating: null, count: null };
    } finally {
      await page.close();
    }

    // Délai aléatoire avant le prochain hôtel
    await sleep(randomDelay());
  }

  await browser.close();

  // Écriture du fichier de sortie
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2) + "\n", "utf-8");
  console.log(`\n✅ Terminé. Résultats écrits dans ${OUTPUT_FILE}`);
})();

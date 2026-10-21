const { createHash } = require('node:crypto');

const companies = {
  COMI: ['البنك التجاري الدولي', 'التجاري الدولي', 'cib', 'commercial international bank'],
  TMGH: ['طلعت مصطفى', 'مجموعه طلعت مصطفى', 'tmg holding'],
  FWRY: ['فوري', 'fawry'],
  SWDY: ['السويدي اليكتريك', 'السويدي الكتريك', 'elsewedy electric'],
  EAST: ['الشرقيه للدخان', 'ايسترن كومباني', 'eastern company'],
  ABUK: ['ابو قير للاسمده', 'ابوقير للاسمده', 'abu qir fertilizers'],
  CCAP: ['القلعه', 'qalaa'],
  AMOC: ['اموك', 'الاسكندريه للزيوت المعدنيه', 'alexandria mineral oils']
};

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ').trim();
}

function has(text, phrase) {
  const p = normalize(phrase);
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(text);
}

function classify(text) {
  const n = normalize(text);
  const matches = Object.entries(companies).filter(([symbol, aliases]) =>
    has(n, symbol) || aliases.some(alias => has(n, alias))).map(([symbol]) => symbol);
  const market = ['البورصه المصريه', 'البورصه', 'egx', 'egx30', 'سهم', 'اسهم', 'تداول', 'مساهمين'].some(x => has(n, x));
  if (!matches.length && !market) return [[], []];
  const groups = {
    buy_recommendation: ['توصيه شراء', 'ننصح بالشراء', 'انصح بالشراء', 'فرصه شراء', 'شراء السهم', 'اشتري', 'اشتروا', 'تجميع السهم', 'buy recommendation', 'buy signal'],
    sell_recommendation: ['توصيه بيع', 'ننصح بالبيع', 'انصح بالبيع', 'فرصه بيع', 'بيع السهم', 'بيعوا', 'جني ارباح', 'تخفيف المراكز', 'sell recommendation', 'sell signal']
  };
  const categories = Object.entries(groups).filter(([, phrases]) => phrases.some(x => has(n, x))).map(([name]) => name);
  const acquisition = ['استحواذ', 'الاستحواذ', 'عرض شراء', 'استحوذت', 'acquisition', 'takeover'].some(x => has(n, x));
  const rumor = ['اشاعه', 'اشاعات', 'شائعه', 'شائعات', 'انباء غير مؤكده', 'تردد ان', 'مصادر غير رسميه', 'غير مؤكد', 'rumor', 'rumour', 'unconfirmed'].some(x => has(n, x));
  if (acquisition && rumor) categories.push('acquisition_rumor');
  return [categories, matches];
}

function contentHash(text) {
  const n = normalize(String(text || '').replace(/https?:\/\/\S+/g, ' '))
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(n, 'utf8').digest('hex');
}

const countries = {
  egypt: ['مصر', 'مصري', 'مصريه', 'المصريه', 'egypt', 'egyptian'],
  saudi: ['السعوديه', 'سعودي', 'السعودي', 'saudi', 'saudi arabia', 'ksa'],
  uae: ['الامارات', 'اماراتي', 'اماراتيه', 'uae', 'united arab emirates', 'dubai', 'abu dhabi', 'دبي', 'ابوظبي'],
  qatar: ['قطر', 'قطري', 'qatar'],
  kuwait: ['الكويت', 'كويتي', 'kuwait'],
  bahrain: ['البحرين', 'بحريني', 'bahrain'],
  oman: ['عمان', 'عماني', 'oman'],
  morocco: ['المغرب', 'مغربي', 'morocco'],
  tunisia: ['تونس', 'تونسي', 'tunisia'],
  usa: ['امريكا', 'الولايات المتحده', 'امريكي', 'us', 'usa', 'united states', 'america'],
  china: ['الصين', 'صيني', 'china', 'chinese'],
  turkey: ['تركيا', 'تركي', 'turkey', 'turkiye']
};

function aliasesForStock(term) {
  const normalized = normalize(term);
  for (const [symbol, names] of Object.entries(companies)) {
    const all = [symbol, ...names];
    if (all.some(x => normalize(x) === normalized)) return all;
  }
  return [term];
}

function aliasesForCountry(term) {
  const normalized = normalize(term);
  for (const names of Object.values(countries)) {
    if (names.some(x => normalize(x) === normalized)) return names;
  }
  return [term];
}

function matchesFilters(text, { keywords = [], stocks = [], countries: selectedCountries = [] } = {}) {
  const normalized = normalize(text);
  return (!keywords.length || keywords.some(term => normalized.includes(normalize(term)))) &&
    (!stocks.length || stocks.some(term => aliasesForStock(term).some(alias => has(normalized, alias)))) &&
    (!selectedCountries.length || selectedCountries.some(term => aliasesForCountry(term).some(alias => has(normalized, alias))));
}

module.exports = { normalize, has, classify, contentHash, matchesFilters };

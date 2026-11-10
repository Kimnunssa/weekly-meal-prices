// 가격 수집: 한국소비자원 참가격(생필품 가격 정보_GW) + KAMIS 농산물유통정보(소매가격) → prices/prices.json
// - 키는 환경변수 DATA_GO_KR · KAMIS_KEY(깃허브 Secrets) 또는 ../credentials/price-keys.txt 에서 읽는다. 키를 파일에 쓰지 않는다.
// - KAMIS: 채소 · 과일 · 정육 · 수산 전국 평균 소매가격(날마다). 참가격 이마트 표본이 있는 가공식품은 참가격을 쓴다.
// - 참가격은 2주마다 금요일 조사 · 약 6일 뒤 입력. 가장 최근 조사일을 찾아 그날 가격을 쓴다.
// - 재료마다 '1g(ml · 개)당 가격' 중간값을 낸다. 이마트 표본이 3곳 이상이면 이마트, 아니면 전국 대형마트 · 슈퍼.
// 실행: node prices/collect.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://apis.data.go.kr/B551919/ProductPriceInfoService';

function readKey(name) {
  if (process.env[name]) return process.env[name].trim();
  const f = join(here, '..', 'credentials', 'price-keys.txt');
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'));
    if (m) return m[1].trim();
  }
  return '';
}
const KEY = readKey('DATA_GO_KR'); // 참가격
const KAMIS_KEY = readKey('KAMIS_KEY'); // KAMIS 농산물유통정보(11-10)
if (!KEY && !KAMIS_KEY) throw new Error('DATA_GO_KR · KAMIS_KEY 키가 둘 다 없습니다');

// 앱 재료 id → 참가격 상품 id. grams 는 '1묶음 · 1개' 단위 상품의 대략 무게(g)
const MAP = {
  egg: { goods: [1075, 1598] }, // 일반 1등급 계란(동물복지 등 고가 제외)
  kimchi: { goods: [1436, 1440, 1685] },
  sprout: { goods: [1395, 1623] },
  danmuji: { goods: [1737, 1768, 1769, 1770, 1774] },
  tofu: { goods: [1186, 965, 966, 967] },
  somen: { goods: [239, 821] },
  glassnoodle: { goods: [1184, 1185] },
  pasta: { goods: [1734, 1771, 1772, 1773] },
  fishcake: { goods: [1216, 1217, 1825] },
  tuna: { goods: [1218, 1219, 1687, 572, 1688] },
  myeongran: { goods: [1449] },
  crabstick: { goods: [1212, 1324, 1824] },
  flour: { goods: [557, 1408, 1410, 1414] },
  sausage: { goods: [1256, 1608] },
  spam: { goods: [1263] },
  milk: { goods: [1258, 1388, 1389, 224, 1517] },
  cheese: { goods: [1260, 1262, 1609, 1610, 201] },
  bacon: { goods: [1508, 1509, 1510, 1511, 1512] },
  duck: { goods: [1520, 1521, 1522, 1523] },
  bread: { goods: [1341, 1603] },
  porkbelly: { goods: [246] },
  porkneck: { goods: [1120] },
  beef: { goods: [157] },
  onion: { goods: [295], grams: 1500 },
  radish: { goods: [309], grams: 1500 },
  spinach: { goods: [927], grams: 300 },
  scallion: { goods: [935], grams: 650 },
  zucchini: { goods: [934], grams: 300 },
  cucumber: { goods: [945], grams: 200 },
  carrot: { goods: [928] },
  potato: { goods: [929] },
  sweetpotato: { goods: [930, 943] },
  // 버섯은 뺌: 조사가 양송이 위주(느타리 표본 1곳)라 '느타리 · 양송이' 재료 값이 3배 넘게 부풀어 나옴
  chili: { goods: [933] },
  kkaennip: { goods: [1036] },
  squid: { goods: [925, 941], grams: 250 },
  salmon: { goods: [1589, 1590, 1716, 1717] },
};

async function get(path, params) {
  const q = new URLSearchParams({ serviceKey: KEY, ...params });
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${BASE}/${path}?${q}`);
      if (r.ok) return await r.text();
    } catch {}
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`호출 실패 ${path}`);
}

const blocks = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const field = (b, f) => (b.match(new RegExp(`<${f}>([^<]*)</${f}>`)) || [])[1];
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

const report = [];
// ── 참가격 ──
async function collectCham() {
// 판매점 · 상품 정보
const stores = {};
for (const b of blocks(await get('getStoreInfoSvc.do', {}), 'iros.openapi.service.vo.entpInfoVO')) {
  stores[field(b, 'entpId')] = { name: field(b, 'entpName'), type: field(b, 'entpTypeCode') };
}
const goods = {};
for (const b of blocks(await get('getProductInfoSvc.do', {}), 'item')) {
  goods[field(b, 'goodId')] = { name: field(b, 'goodName'), cnt: Number(field(b, 'goodTotalCnt')), div: field(b, 'goodTotalDivCode') };
}

// 가장 최근 조사일(계란 1075 가격이 30곳 넘게 들어온 날)
let day = null;
for (let i = 0; i < 35 && !day; i++) {
  const d = new Date(Date.now() - i * 86400000);
  const xml = await get('getProductPriceInfoSvc', { goodInspectDay: ymd(d), goodId: '1075' });
  if ((xml.match(/<entpId>/g) || []).length >= 30) day = ymd(d);
}
if (!day) throw new Error('최근 35일 안에 조사일이 없습니다');

const items = {};
for (const [id, m] of Object.entries(MAP)) {
  // 점포마다 짝지은 상품 중 가장 싼 것(알뜰하게 사는 기준) → 점포들의 중간값
  const perStore = {};
  for (const g of m.goods) {
    const info = goods[g];
    if (!info) continue;
    // g · ml 상품은 총량 그대로. '1개 · 1묶음' 상품은 대략 무게(grams), 없으면 개수(계란 등 '개' 재료)
    const size = info.div === 'G' || info.div === 'ML' ? info.cnt : m.grams ?? (info.div === 'EA' ? info.cnt : null);
    if (!size) continue;
    const xml = await get('getProductPriceInfoSvc', { goodInspectDay: day, goodId: String(g) });
    for (const b of blocks(xml, 'iros.openapi.service.vo.goodPriceVO')) {
      const st = stores[field(b, 'entpId')];
      const price = Number(field(b, 'goodPrice'));
      if (!st || !price) continue;
      const unit = price / size;
      const sid = field(b, 'entpId');
      if (perStore[sid] === undefined || unit < perStore[sid]) perStore[sid] = unit;
    }
  }
  const emart = [];
  const all = [];
  for (const [sid, unit] of Object.entries(perStore)) {
    const st = stores[sid];
    if (st.type === 'LM' || st.type === 'SM') all.push(unit);
    if (st.type === 'LM' && st.name.startsWith('이마트') && !st.name.includes('트레이더스')) emart.push(unit);
  }
  const useEmart = emart.length >= 3;
  const src = useEmart ? emart : all;
  if (src.length < 3) {
    report.push(`${id}: 표본 ${src.length}곳 → 뺌`);
    continue;
  }
  items[id] = { unitPrice: Math.round(median(src) * 1000) / 1000, scope: useEmart ? 'emart' : 'national', n: src.length };
  report.push(`${id}: ${items[id].unitPrice}원/단위 · ${useEmart ? '이마트' : '전국'} ${src.length}곳`);
}
  return { day: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`, items };
}

// ── KAMIS(한국농수산식품유통공사 농산물유통정보) 소매가격 · 전국 평균 ──
// 참가격에 없는 채소 · 과일 · 정육 · 수산을 날마다 받는다(11-10). 키는 KAMIS_KEY.
// 앱 재료 id → [품목코드, 품종코드, 등급 글자, 조사 단위의 무게(g) 또는 개수]. 여러 줄이면 앞에서부터 값이 있는 것.
const KAMIS = {
  rice: [['111', '10', '상품', 10000], ['111', '11', '상품', 10000], ['111', '01', '상품', 20000]],
  sweetpotato: [['151', '00', '상품', 1000]],
  potato: [['152', '01', '상품', 100]],
  cabbage: [['212', '00', '상품', 2000]], // 1포기 약 2kg(앱은 1/2통 1kg)
  spinach: [['213', '00', '상품', 100]],
  ssamchae: [['214', '01', '상품', 100]],
  cucumber: [['223', '02', '상품', 2000], ['223', '01', '상품', 2000]], // 10개 · 1개 약 200g
  zucchini: [['224', '01', '상품', 300]],
  tomato: [['225', '00', '상품', 1000]],
  radish: [['231', '03', '상품', 1500], ['231', '02', '상품', 1500]],
  carrot: [['232', '01', '상품', 1000]],
  chili: [['242', '03', '상품', 100]],
  kkwari: [['242', '02', '상품', 100]],
  onion: [['245', '00', '상품', 1000]],
  scallion: [['246', '00', '상품', 1000]],
  jjokpa: [['246', '02', '상품', 1000]],
  eggplant: [['251', '00', '상품', 450]], // 3개
  minari: [['252', '00', '상품', 100]],
  kkaennip: [['253', '00', '상품', 50]],
  buchu: [['254', '00', '상품', 100]],
  pepper: [['256', '00', '상품', 150]], // 파프리카 1개
  napa: [['279', '00', '상품', 800]],
  broccoli: [['280', '00', '상품', 400]],
  mushroom: [['315', '01', '상품', 100], ['315', '00', '상품', 100]],
  enoki: [['316', '00', '상품', 150]],
  apple: [['411', '05', '상품', 3000], ['411', '07', '상품', 3000]], // 10개 · 1개 약 300g
  pear: [['412', '01', '상품', 5000]], // 10개 · 1개 약 500g
  grape: [['414', '12', 'L과', 2000], ['414', '01', 'L과', 1000]],
  tangerine: [['415', '01', 'M과', 900], ['415', '02', 'M과', 900]], // 10개 · 1개 약 90g
  persimmon: [['416', '00', '상품', 1000]], // 5개 · 1개 약 200g
  banana: [['418', '02', '상품', 100]],
  avocado: [['430', '00', '상품', 200]],
  pork: [['4304', '25', '앞다리', 100]],
  porkbelly: [['4304', '27', '삼겹살', 100]],
  porkneck: [['4304', '68', '목심', 100]],
  egg: [['9903', '23', '일반란', 30], ['9903', '21', '일반란', 10]], // 30구 · 10구 값의 평균(15구에 가깝게)
  mackerel: [['611', '05', '大', 300]], // 1마리 손질 뒤 약 300g
  squid: [['619', '04', '中', 250], ['619', '05', '中', 250]],
  anchovy: [['638', '00', '세멸', 100]],
  oyster: [['644', '00', '-', 1000]],
  kkotge: [['656', '05', '-', 1000], ['656', '00', '-', 1000]],
};
const KAMIS_CATS = ['100', '200', '300', '400', '500', '600'];
// 참가격 이마트 표본이 있어도 KAMIS 를 쓰는 재료(참가격 짝이 15구 한 판 값이라 개당 값이 두 배쯤 높게 나옴)
const KAMIS_FIRST = new Set(['egg']);

async function collectKamis(key) {
  const numOf = (s) => Number(String(s ?? '').replace(/,/g, '')) || 0;
  const rows = [];
  let day = null;
  // 주말 · 공휴일에는 값이 비어서, 오늘부터 7일 전까지 값이 있는 가장 가까운 날을 쓴다
  for (let back = 0; back < 8 && !day; back++) {
    const d = new Date(Date.now() + 9 * 3600000 - back * 86400000).toISOString().slice(0, 10);
    const got = [];
    for (const cat of KAMIS_CATS) {
      const q = new URLSearchParams({ action: 'dailyPriceByCategoryList', p_product_cls_code: '01', p_item_category_code: cat, p_country_code: '', p_regday: d, p_convert_kg_yn: 'N', p_cert_key: key, p_cert_id: 'weeklymeal', p_returntype: 'json' });
      let j = null;
      for (let i = 0; i < 3 && !j; i++) {
        try {
          const r = await fetch(`http://www.kamis.or.kr/service/price/xml.do?${q}`);
          if (r.ok) j = await r.json();
        } catch {}
        if (!j) await new Promise((res) => setTimeout(res, 2000));
      }
      if (j && Array.isArray(j.data?.item)) got.push(...j.data.item);
    }
    if (got.filter((x) => numOf(x.dpr1) > 0).length >= 60) {
      day = d;
      rows.push(...got);
    }
  }
  if (!day) throw new Error('KAMIS: 최근 7일 안에 값이 있는 날이 없습니다');
  const items = {};
  for (const [id, specs] of Object.entries(KAMIS)) {
    const units = [];
    for (const [item, kind, rank, size] of specs) {
      const row = rows.find((x) => x.item_code === item && x.kind_code === kind && x.rank === rank && numOf(x.dpr1) > 0);
      if (row) units.push(numOf(row.dpr1) / size);
      // 계란만 두 포장의 평균, 나머지는 처음 값이 있는 줄
      if (units.length && id !== 'egg') break;
    }
    if (!units.length) {
      report.push(`${id}: KAMIS 값 없음 → 뺌`);
      continue;
    }
    const unit = units.reduce((a, b) => a + b, 0) / units.length;
    items[id] = { unitPrice: Math.round(unit * 1000) / 1000, scope: 'kamis', n: units.length };
    report.push(`${id}: ${items[id].unitPrice}원/단위 · KAMIS 전국 소매`);
  }
  return { day, items };
}

const file = join(here, 'prices.json');
const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
// 한쪽을 못 받으면(키 없음 · 서버 장애) 지난 파일의 그쪽 값을 그대로 둔다
const keep = (scopes) => Object.fromEntries(Object.entries(prev?.items ?? {}).filter(([, v]) => scopes.includes(v.scope)));
let cham = { day: prev?.surveyDay ?? '', items: keep(['emart', 'national']) };
if (KEY) {
  try {
    cham = await collectCham();
  } catch (e) {
    report.push(`참가격 실패 → 지난 값 유지: ${e.message}`);
  }
}
let kamis = { day: prev?.kamisDay ?? '', items: keep(['kamis']) };
if (KAMIS_KEY) {
  try {
    kamis = await collectKamis(KAMIS_KEY);
  } catch (e) {
    report.push(`KAMIS 실패 → 지난 값 유지: ${e.message}`);
  }
}
// 합치기: 참가격 이마트 표본이 있으면 그것(앱 기준 마트), 없으면 KAMIS, 그것도 없으면 참가격 전국
const items = {};
for (const id of new Set([...Object.keys(cham.items), ...Object.keys(kamis.items)])) {
  const c = cham.items[id];
  const k = kamis.items[id];
  items[id] = k && (!c || c.scope !== 'emart' || KAMIS_FIRST.has(id)) ? k : c;
}
const out = {
  v: 1,
  source: '한국소비자원 참가격 · KAMIS 농산물유통정보',
  surveyDay: cham.day,
  ...(kamis.day ? { kamisDay: kamis.day } : {}),
  fetchedAt: new Date().toISOString(),
  items,
};
// 조사일 · 가격이 그대로면 파일을 건드리지 않는다(깃허브가 매일 돌아도 바뀐 날만 커밋되게)
if (prev && prev.surveyDay === out.surveyDay && prev.kamisDay === out.kamisDay && JSON.stringify(prev.items) === JSON.stringify(out.items)) {
  console.log(`바뀐 것 없음(참가격 ${out.surveyDay} · KAMIS ${out.kamisDay ?? '-'})`);
} else {
  writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  const n = (s) => Object.values(items).filter((v) => s.includes(v.scope)).length;
  console.log(`참가격 ${out.surveyDay} ${n(['emart', 'national'])}개 · KAMIS ${out.kamisDay ?? '-'} ${n(['kamis'])}개 · 모두 ${Object.keys(items).length}개`);
}
console.log(report.join('\n'));

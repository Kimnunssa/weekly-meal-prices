// 주 1회 가격 수집: 한국소비자원 참가격(생필품 가격 정보_GW) → prices/prices.json
// - 키는 환경변수 DATA_GO_KR(깃허브 Secrets) 또는 ../credentials/price-keys.txt 에서 읽는다. 키를 파일에 쓰지 않는다.
// - 참가격은 2주마다 금요일 조사 · 약 6일 뒤 입력. 가장 최근 조사일을 찾아 그날 가격을 쓴다.
// - 재료마다 '1g(ml · 개)당 가격' 중간값을 낸다. 이마트 표본이 3곳 이상이면 이마트, 아니면 전국 대형마트 · 슈퍼.
// 실행: node prices/collect.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://apis.data.go.kr/B551919/ProductPriceInfoService';

function readKey() {
  if (process.env.DATA_GO_KR) return process.env.DATA_GO_KR.trim();
  const f = join(here, '..', 'credentials', 'price-keys.txt');
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(/^DATA_GO_KR=(.+)$/m);
    if (m) return m[1].trim();
  }
  throw new Error('DATA_GO_KR 키가 없습니다');
}
const KEY = readKey();

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
const report = [];
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

const out = {
  v: 1,
  source: '한국소비자원 참가격',
  surveyDay: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`,
  fetchedAt: new Date().toISOString(),
  items,
};
// 조사일 · 가격이 그대로면 파일을 건드리지 않는다(깃허브가 매일 돌아도 바뀐 날만 커밋되게)
const file = join(here, 'prices.json');
const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
if (prev && prev.surveyDay === out.surveyDay && JSON.stringify(prev.items) === JSON.stringify(out.items)) {
  console.log(`바뀐 것 없음(조사일 ${out.surveyDay})`);
} else {
  writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  console.log(`조사일 ${out.surveyDay} · 재료 ${Object.keys(items).length}개`);
}
console.log(report.join('\n'));

import admin from "firebase-admin";

const BATCH_SIZE = 15;
const HEADERS = { "User-Agent": "Mozilla/5.0 (game-catalog-price-refresh)" };

let app;
function getApp() {
  if (app) return app;
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf-8")
  );
  app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return app;
}

async function fetchJsonRetry(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === retries) { console.warn("fetch failed:", url, e.message); return null; }
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

let storeMapCache = null;
async function getStoreMap() {
  if (storeMapCache) return storeMapCache;
  const stores = await fetchJsonRetry("https://www.cheapshark.com/api/1.0/stores");
  const map = {};
  (stores || []).forEach(s => { map[s.storeID] = s.storeName; });
  storeMapCache = map;
  return map;
}

async function resolveCheapsharkId(title) {
  const data = await fetchJsonRetry(`https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(title)}&limit=1`);
  return data?.[0]?.gameID || null;
}

async function getNextBatch(db) {
  const cursorSnap = await db.collection("meta").doc("refreshCursor").get();
  const lastId = cursorSnap.exists() ? cursorSnap.data().lastId : null;

  let q = db.collection("games").orderBy("__name__").limit(BATCH_SIZE);
  if (lastId) q = db.collection("games").orderBy("__name__").startAfter(lastId).limit(BATCH_SIZE);

  let snap = await q.get();
  let wrapped = false;
  if (snap.empty) {
    // дошли до конца списка — начинаем сначала
    snap = await db.collection("games").orderBy("__name__").limit(BATCH_SIZE).get();
    wrapped = true;
  }
  return { docs: snap.docs, wrapped };
}

export async function handler() {
  getApp();
  const db = admin.firestore();
  const storeMap = await getStoreMap();

  const { docs } = await getNextBatch(db);
  let updated = 0;
  let lastProcessedId = null;

  for (const docSnap of docs) {
    const game = docSnap.data();
    lastProcessedId = docSnap.id;

    let cheapsharkId = game.cheapsharkGameId;
    if (!cheapsharkId) cheapsharkId = await resolveCheapsharkId(game.title);
    if (!cheapsharkId) continue;

    const details = await fetchJsonRetry(`https://www.cheapshark.com/api/1.0/games?id=${cheapsharkId}`);
    if (!details || !Array.isArray(details.deals)) continue;

    const platforms = details.deals.map(d => {
      const retail = Number(d.retailPrice);
      const price = Number(d.price);
      return {
        store: storeMap[d.storeID] || `Store #${d.storeID}`,
        price,
        retailPrice: retail,
        discountPercent: retail > 0 ? Math.round((1 - price / retail) * 100) : 0,
        url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`
      };
    });
    const lowestPrice = platforms.length ? Math.min(...platforms.map(p => p.price)) : 0;
    const bestDiscountPercent = platforms.length ? Math.max(...platforms.map(p => p.discountPercent)) : 0;

    await docSnap.ref.update({
      platforms,
      lowestPrice,
      bestDiscountPercent,
      cheapsharkGameId: cheapsharkId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    updated++;
    await new Promise(r => setTimeout(r, 150));
  }

  await db.collection("meta").doc("refreshCursor").set({ lastId: lastProcessedId });

  console.log(`price refresh: updated ${updated}/${docs.length} games`);
  return { statusCode: 200, body: JSON.stringify({ updated, total: docs.length }) };
}

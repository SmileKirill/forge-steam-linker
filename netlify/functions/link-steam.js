import admin from "firebase-admin";

let app;
function getApp() {
  if (app) return app;
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf-8")
  );
  app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return app;
}

function extractSteamId(input) {
  const clean = input.trim().replace(/\/+$/, "");
  const profilesMatch = clean.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (profilesMatch) return { steamId64: profilesMatch[1], vanity: null };
  const idMatch = clean.match(/steamcommunity\.com\/id\/([^/]+)/);
  if (idMatch) return { steamId64: null, vanity: idMatch[1] };
  if (/^\d{17}$/.test(clean)) return { steamId64: clean, vanity: null };
  return { steamId64: null, vanity: clean };
}

async function resolveVanity(vanity) {
  const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${process.env.STEAM_API_KEY}&vanityurl=${encodeURIComponent(vanity)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.response?.success !== 1) return null;
  return data.response.steamid;
}

async function getOwnedAppIds(steamId64) {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${process.env.STEAM_API_KEY}&steamid=${steamId64}&include_appinfo=0&format=json`;
  const res = await fetch(url);
  const data = await res.json();
  const games = data.response?.games;
  if (!Array.isArray(games)) return null; // приватный профиль или пустая библиотека
  return games.map(g => g.appid);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "method not allowed" }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const idToken = authHeader.replace("Bearer ", "");
  if (!idToken) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: "no auth token" }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }
  const { steamProfileUrl } = body;
  if (!steamProfileUrl) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "steamProfileUrl required" }) };
  }

  try {
    getApp();
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const { steamId64: directId, vanity } = extractSteamId(steamProfileUrl);
    const steamId64 = directId || await resolveVanity(vanity);
    if (!steamId64) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: "steam profile not found" }) };
    }

    const ownedAppIds = await getOwnedAppIds(steamId64);
    if (ownedAppIds === null) {
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ linkedCount: 0, warning: "profile is private or empty" }) };
    }

    const db = admin.firestore();
    const gamesSnap = await db.collection("games").select("steamAppId").get();
    const ownedSet = new Set(ownedAppIds);
    const matchedSlugs = [];
    gamesSnap.forEach(doc => {
      const appId = doc.data().steamAppId;
      if (appId && ownedSet.has(appId)) matchedSlugs.push(doc.id);
    });

    await db.collection("users").doc(uid).set({
      steamLinked: true,
      steamId64,
      library: admin.firestore.FieldValue.arrayUnion(...matchedSlugs)
    }, { merge: true });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ linkedCount: matchedSlugs.length, totalOwned: ownedAppIds.length })
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: "internal error" }) };
  }
}

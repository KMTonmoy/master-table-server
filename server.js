const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const dns = require("dns");
require("dotenv").config({ quiet: true });
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const passport = require("passport");
const PDFDocument = require("pdfkit");
const XLSX = require("xlsx");

const { signToken } = require("./utils/jwt");
const { sendPasswordResetEmail } = require("./utils/mailer");
const buildAuthMiddleware = require("./middleware/auth");
const requireAdmin = require("./middleware/admin");
const configurePassport = require("./config/passport");
const createRateLimiter = require("./utils/rateLimit");

try {
  dns.setServers(["8.8.8.8", "8.8.4.4"]);
} catch (e) {}

const app = express();
const port = process.env.PORT || 8000;

const stripe = require("stripe")(
  process.env.STRIPE_SECRET_KEY || "sk_test_placeholder",
);

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:8000",
  process.env.CLIENT_ORIGIN
    ? process.env.CLIENT_ORIGIN.replace(/\/+$/, "")
    : null,
  "https://mastertable.vercel.app",
  "https://master-table-server.vercel.app",
].filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(passport.initialize());

const uri =
  process.env.DB_URI || process.env.MONGODB_URI || process.env.MONGO_URI;

const client = uri
  ? new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
    })
  : null;

const db = client ? client.db("MasterTable") : null;
const col = (name) => (db ? db.collection(name) : null);

const products = col("products");
const orders = col("orders");
const customers = col("customers");
const categories = col("categories");
const reservations = col("reservations");
const activity = col("activity");
const reports = col("reports");
const analytics = col("analytics");
const settings = col("settings");
const usersCollection = col("users");
const paymentCollection = col("payments");
const bannerCollection = col("BannerCollection");
const carts = col("carts");

if (carts) {
  carts
    .createIndex({ userId: 1 }, { unique: true })
    .catch((e) => console.error("carts index error", e));
}

if (usersCollection) {
  usersCollection
    .createIndex({ email: 1 }, { unique: true })
    .catch((e) => console.error("users email index error", e));
  usersCollection
    .createIndex({ "addresses.id": 1 })
    .catch((e) => console.error("addresses id index error", e));
}

if (orders) {
  orders
    .createIndex({ orderId: 1 }, { unique: true })
    .catch((e) => console.error("orders orderId index error", e));
  orders
    .createIndex({ email: 1, time: -1 })
    .catch((e) => console.error("orders email index error", e));
}

const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function oid(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => {
    if (obj && obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

function toClient(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function pctDelta(current, previous) {
  if (!previous) return current > 0 ? "+100%" : "0%";
  const change = ((current - previous) / previous) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}%`;
}

function monthRange(offset = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const end = new Date(
    now.getFullYear(),
    now.getMonth() - offset + 1,
    0,
    23,
    59,
    59,
    999,
  );
  return { start, end };
}

function getRevenueRangeConfig(range) {
  const now = new Date();
  if (range === "7d") {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    const prevEnd = new Date(start);
    prevEnd.setDate(prevEnd.getDate() - 1);
    prevEnd.setHours(23, 59, 59, 999);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - 6);
    prevStart.setHours(0, 0, 0, 0);
    return { unit: "day", buckets: 7, start, end, prevStart, prevEnd };
  }
  if (range === "30d") {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
    const prevEnd = new Date(start);
    prevEnd.setDate(prevEnd.getDate() - 1);
    prevEnd.setHours(23, 59, 59, 999);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - 29);
    prevStart.setHours(0, 0, 0, 0);
    return { unit: "day", buckets: 30, start, end, prevStart, prevEnd };
  }
  const end = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23,
    59,
    59,
    999,
  );
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1, 0, 0, 0, 0);
  const prevEnd = new Date(
    start.getFullYear(),
    start.getMonth(),
    0,
    23,
    59,
    59,
    999,
  );
  const prevStart = new Date(
    prevEnd.getFullYear(),
    prevEnd.getMonth() - 11,
    1,
    0,
    0,
    0,
    0,
  );
  return { unit: "month", buckets: 12, start, end, prevStart, prevEnd };
}

function bucketSums(list, config, rangeStart) {
  const sums = new Array(config.buckets).fill(0);
  list.forEach((o) => {
    const t = new Date(o.time);
    let diff;
    if (config.unit === "day") {
      diff = Math.floor((t - rangeStart) / 86400000);
    } else {
      diff =
        (t.getFullYear() - rangeStart.getFullYear()) * 12 +
        (t.getMonth() - rangeStart.getMonth());
    }
    if (diff >= 0 && diff < config.buckets) sums[diff] += o.total;
  });
  return sums.map((n) => Math.round(n));
}

function buildLabels(config, rangeStart) {
  const dayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthShort = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const labels = [];
  for (let i = 0; i < config.buckets; i++) {
    if (config.unit === "day") {
      const d = new Date(rangeStart);
      d.setDate(d.getDate() + i);
      labels.push(
        config.buckets === 7 ? dayShort[d.getDay()] : String(d.getDate()),
      );
    } else {
      const d = new Date(
        rangeStart.getFullYear(),
        rangeStart.getMonth() + i,
        1,
      );
      labels.push(monthShort[d.getMonth()]);
    }
  }
  return labels;
}

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .map((img) => (typeof img === "string" ? img.trim() : ""))
    .filter(Boolean);
}

function normalizeStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
}

function levenshtein(a, b) {
  a = String(a || "");
  b = String(b || "");
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

function buildProductUpdate(p) {
  const update = {};
  if (p.name !== undefined) update.name = p.name;
  if (p.description !== undefined) update.description = p.description;
  if (p.category !== undefined) update.category = p.category;
  if (p.price !== undefined) update.price = Number(p.price);
  if (p.stock !== undefined) update.stock = Number(p.stock);
  if (p.sold !== undefined) update.sold = Number(p.sold);
  if (p.rating !== undefined) update.rating = Number(p.rating);
  if (p.status !== undefined) update.status = p.status;
  if (p.images !== undefined) update.images = normalizeImages(p.images);
  if (p.ingredients !== undefined)
    update.ingredients = normalizeStringArray(p.ingredients);
  if (p.diet !== undefined) update.diet = p.diet;
  if (p.cuisine !== undefined) update.cuisine = p.cuisine;
  if (p.spiceLevel !== undefined) update.spiceLevel = Number(p.spiceLevel);
  if (p.prepTime !== undefined) update.prepTime = Number(p.prepTime);
  if (p.calories !== undefined) update.calories = Number(p.calories);
  if (p.tags !== undefined) update.tags = normalizeStringArray(p.tags);
  if (p.isFeatured !== undefined) update.isFeatured = p.isFeatured === true;
  if (p.isfeatured !== undefined) update.isfeatured = p.isfeatured === true;
  if (p.isAvailable !== undefined) update.isAvailable = p.isAvailable !== false;
  return update;
}

function formatOrderTime(time) {
  return new Date(time).toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function formatOrder(o) {
  return {
    id: o.orderId,
    customer: o.customer,
    email: o.email || null,
    userId: o.userId || null,
    channel: o.channel,
    table: o.table,
    status: o.status,
    payment: o.payment,
    items: o.items,
    addressId: o.addressId || null,
    address: o.address || null,
    phone: o.phone || null,
    total: +Number(o.total || 0).toFixed(2),
    time: formatOrderTime(o.time),
  };
}

function relativeTime(date) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const toSearchResult = (doc) => {
  const id = doc._id.toString();
  return { ...doc, _id: id, id };
};

const searchWords = (s) =>
  String(s || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const allowedTypos = (len) => (len <= 3 ? 0 : len <= 5 ? 1 : 2);

function prepareProduct(p) {
  const name = String(p.name || "").toLowerCase();
  const category = String(p.category || "").toLowerCase();
  const cuisine = String(p.cuisine || "").toLowerCase();
  const tags = (Array.isArray(p.tags) ? p.tags : []).map((t) =>
    String(t).toLowerCase(),
  );
  const ingredients = (Array.isArray(p.ingredients) ? p.ingredients : []).map(
    (t) => String(t).toLowerCase(),
  );
  const description = String(p.description || "").toLowerCase();

  return {
    name,
    nameWords: searchWords(name),
    category,
    cuisine,
    tags,
    ingredients,
    description,
    fuzzyWords: [
      ...searchWords(name),
      ...searchWords(category),
      ...searchWords(cuisine),
      ...tags.flatMap(searchWords),
      ...ingredients.flatMap(searchWords),
    ],
  };
}

function scoreToken(token, f) {
  if (f.nameWords.some((w) => w.startsWith(token))) return { score: 12 };
  if (f.name.includes(token)) return { score: 9 };
  if (
    f.category.includes(token) ||
    f.cuisine.includes(token) ||
    f.tags.some((t) => t.includes(token))
  )
    return { score: 7 };
  if (f.ingredients.some((i) => i.includes(token))) return { score: 5 };
  if (f.description.includes(token)) return { score: 3 };

  // Typo tolerance (only for tokens of 4+ letters)
  const maxDist = allowedTypos(token.length);
  if (maxDist > 0) {
    let best = Infinity;
    for (const w of f.fuzzyWords) {
      if (Math.abs(w.length - token.length) > maxDist) continue;
      const d = levenshtein(token, w);
      if (d < best) best = d;
    }
    if (best <= maxDist) return { score: 4 - best, fuzzy: true };
  }
  return { score: 0 };
}

async function keywordSearch(req, res, mapFn) {
  const q = (req.query.q || "").toString().trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 60);

  if (!q) return res.json({ query: "", count: 0, fuzzy: false, results: [] });

  const tokens = searchWords(q);
  if (tokens.length === 0)
    return res.json({ query: q, count: 0, fuzzy: false, results: [] });

  const qLower = q.toLowerCase();
  const all = await products.find().toArray();

  const matched = [];
  for (const doc of all) {
    const f = prepareProduct(doc);
    let total = 0;
    let usedFuzzy = false;
    let ok = true;

    for (const token of tokens) {
      const r = scoreToken(token, f);
      if (r.score <= 0) {
        ok = false;
        break;
      }
      total += r.score;
      if (r.fuzzy) usedFuzzy = true;
    }
    if (!ok) continue;

    if (f.name.includes(qLower)) total += 5; // whole phrase in the name
    matched.push({ doc, score: total, fuzzy: usedFuzzy });
  }

  matched.sort(
    (a, b) => b.score - a.score || (b.doc.sold || 0) - (a.doc.sold || 0),
  );

  const results = matched.slice(0, limit).map((m) => mapFn(m.doc));
  res.json({
    query: q,
    count: results.length,
    fuzzy: matched.length > 0 && matched.every((m) => m.fuzzy),
    results,
  });
}

function requireEmail(req, res) {
  const email = req.query.email || req.body?.email || req.params?.email || null;
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return null;
  }
  return email;
}

async function logActivity(text, tone = "gold") {
  try {
    await activity.insertOne({
      text,
      tone,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error("activity insert failed", e);
  }
}

async function buildCartResponse(userId) {
  if (!userId) return { items: [], count: 0, subtotal: 0 };

  const cart = await carts.findOne({ userId });
  const rawItems = Array.isArray(cart?.items) ? cart.items : [];
  if (rawItems.length === 0) return { items: [], count: 0, subtotal: 0 };

  const ids = rawItems
    .map((item) => oid(item.productId))
    .filter((id) => id !== null);

  const productDocs = ids.length
    ? await products.find({ _id: { $in: ids } }).toArray()
    : [];
  const byId = new Map(productDocs.map((p) => [p._id.toString(), p]));

  const items = rawItems.map((item) => {
    const product = byId.get(String(item.productId));
    const price = Number(product?.price ?? item.priceSnapshot ?? 0);
    const quantity = Math.max(1, Number(item.quantity) || 1);

    const deleted = !product;
    const outOfStock =
      !!product &&
      (Number(product.stock) <= 0 || product.status === "Out of stock");
    const unavailableFlag = !!product && product.isAvailable === false;

    const reason = deleted
      ? "This item is no longer on the menu."
      : outOfStock
        ? "Out of stock."
        : unavailableFlag
          ? "Currently unavailable."
          : null;

    return {
      productId: String(item.productId),
      name: product?.name ?? item.nameSnapshot ?? "Removed item",
      emoji: product?.emoji ?? "🍽️",
      image:
        Array.isArray(product?.images) && product.images[0]
          ? product.images[0]
          : null,
      category: product?.category ?? "",
      price,
      priceChanged: !!product && price !== Number(item.priceSnapshot ?? price),
      quantity,
      lineTotal: +(price * quantity).toFixed(2),
      available: !deleted && !outOfStock && !unavailableFlag,
      reason,
      addedAt: item.addedAt ?? null,
    };
  });

  const subtotal = items
    .filter((i) => i.available)
    .reduce((sum, i) => sum + i.lineTotal, 0);

  const count = items.reduce((sum, i) => sum + i.quantity, 0);

  return { items, count, subtotal: +subtotal.toFixed(2) };
}

function snapshotAddress(address, phone) {
  if (!address || typeof address !== "object") return null;
  return {
    label: address.label || "",
    line1: address.line1 || "",
    line2: address.line2 || "",
    city: address.city || "",
    postalCode: address.postalCode || "",
    country: address.country || "",
    phone: phone || address.phone || "",
  };
}

async function resolveOrderAddress({
  addressId,
  address,
  phone,
  email,
  userId,
}) {
  if (!addressId && !address)
    return { addressId: null, address: null, phone: phone || null };

  if (addressId && userId) {
    const user = await usersCollection.findOne(
      { email },
      { projection: { addresses: 1, phone: 1 } },
    );
    const list = Array.isArray(user?.addresses) ? user.addresses : [];
    const found = list.find((a) => String(a.id) === String(addressId));
    if (found) {
      return {
        addressId: found.id,
        address: snapshotAddress(found, phone),
        phone: phone || found.phone || user?.phone || null,
      };
    }
  }

  if (address) {
    const snapshot = snapshotAddress(address, phone);
    return {
      addressId: address.id || null,
      address: snapshot,
      phone: snapshot?.phone || phone || null,
    };
  }

  return { addressId: null, address: null, phone: phone || null };
}

async function createOrderHandler(req, res) {
  const {
    customer,
    email,
    channel,
    table,
    items,
    payment,
    addressId,
    address,
    phone,
  } = req.body || {};

  const authEmail = req.user?.email || null;
  const authUserId = req.user?.id || null;

  const finalEmail = (authEmail || email || "").trim().toLowerCase();
  const finalCustomer = customer || req.user?.name;

  if (
    !finalCustomer ||
    !finalEmail ||
    !channel ||
    !Array.isArray(items) ||
    !items.length
  )
    return res.status(400).json({ error: "Invalid order data" });

  if (channel === "Delivery" && !addressId && !address) {
    return res.status(400).json({ error: "A delivery address is required" });
  }

  const count = await orders.countDocuments({});
  const orderId = `MT-${4000 + count + 1}`;

  const productDocs = await products.find({ name: { $in: items } }).toArray();

  const subtotal = +items
    .reduce(
      (sum, name) =>
        sum + (productDocs.find((p) => p.name === name)?.price || 0),
      0,
    )
    .toFixed(2);

  const resolved = await resolveOrderAddress({
    addressId,
    address,
    phone,
    email: finalEmail,
    userId: authUserId,
  });

  const doc = {
    orderId,
    customer: finalCustomer,
    email: finalEmail,
    userId: authUserId,
    channel,
    table: table || null,
    status: "Pending",
    payment: payment || "Card",
    items,
    addressId: resolved.addressId,
    address: resolved.address,
    phone: resolved.phone,
    total: +(subtotal * 1.05).toFixed(2),
    time: new Date(),
  };

  await orders.insertOne(doc);

  await Promise.all(
    items.map((name) =>
      products.updateOne({ name }, { $inc: { sold: 1 } }).catch(() => null),
    ),
  );

  if (authUserId) {
    await carts
      .updateOne(
        { userId: authUserId },
        { $set: { items: [], updatedAt: new Date() } },
      )
      .catch(() => null);
  }

  await logActivity(
    `New order ${orderId} placed by ${finalCustomer} (${finalEmail})`,
    "gold",
  );

  res.status(201).json({
    message: "Order created",
    orderId,
    order: formatOrder(doc),
  });
}

async function createReservationHandler(req, res) {
  const { name, email, phone, date, time, guests, occasion, notes } =
    req.body || {};

  const finalEmail = req.user?.email || email;
  const finalName = name || req.user?.name;

  if (
    !finalName ||
    typeof finalName !== "string" ||
    finalName.trim().length < 2
  ) {
    return res.status(400).json({ error: "A valid name is required" });
  }
  if (!isValidEmail(finalEmail)) {
    return res.status(400).json({ error: "A valid email is required" });
  }
  if (!phone || typeof phone !== "string" || phone.trim().length < 5) {
    return res.status(400).json({ error: "A valid phone number is required" });
  }
  if (!date || !time) {
    return res.status(400).json({ error: "Date and time are required" });
  }
  const guestCount = Number(guests);
  if (!Number.isFinite(guestCount) || guestCount < 1 || guestCount > 50) {
    return res
      .status(400)
      .json({ error: "Guests must be a number between 1 and 50" });
  }

  const doc = {
    name: finalName.trim(),
    email: finalEmail.trim().toLowerCase(),
    userId: req.user?.id || null,
    phone: phone.trim(),
    date,
    time,
    guests: guestCount,
    occasion: occasion || "",
    notes: notes || "",
    status: "Pending",
    table: null,
    createdAt: new Date(),
  };

  const result = await reservations.insertOne(doc);

  await logActivity(
    `New reservation for ${finalName} on ${date} at ${time}`,
    "gold",
  );

  res.status(201).json(toClient({ _id: result.insertedId, ...doc }));
}

app.get("/", (req, res) => {
  res.send("Master Table server is running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    dbConfigured: Boolean(uri),
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
    clientOriginConfigured: Boolean(process.env.CLIENT_ORIGIN),
  });
});

app.use((req, res, next) => {
  if (!db) {
    return res.status(500).json({
      error:
        "Database is not configured. Set DB_URI in the Vercel environment variables and redeploy.",
    });
  }
  next();
});
if (db) {
  configurePassport(usersCollection);
}

const { authenticate, optionalAuthenticate } = buildAuthMiddleware(
  usersCollection,
  oid,
);

const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

function getCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

function getClearCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "strict",
    path: "/",
  };
}

function toSafeUser(user) {
  if (!user) return null;
  return {
    id: user._id.toString(),
    name: user.name || user.displayName || user.userName || "",
    email: user.email || user.userEmail || "",
    profileImage: user.profileImage || "",
    role: user.role || "user",
    provider: user.provider || "email",
    isVerified: user.isVerified === true,
    phone: user.phone || "",
    addresses: Array.isArray(user.addresses) ? user.addresses : [],
    defaultAddressId: user.defaultAddressId || null,
  };
}

function ownsRecord(record, identity) {
  if (!record || !identity) return false;
  if (identity.isAdmin) return true;
  if (identity.userId && record.userId && record.userId === identity.userId)
    return true;
  if (
    identity.email &&
    record.email &&
    record.email.toLowerCase() === identity.email.toLowerCase()
  )
    return true;
  return false;
}

function getIdentity(req) {
  if (!req.user) return null;
  return {
    email: req.user.email,
    userId: req.user.id,
    isAdmin: req.user.role === "admin",
  };
}

function requireStrategy(name) {
  return (req, res, next) => {
    if (!passport._strategy(name)) {
      return res.status(501).json({
        success: false,
        message: `${name} sign-in is not configured on this server.`,
      });
    }
    next();
  };
}

function clientOrigin() {
  return (process.env.CLIENT_ORIGIN || "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
}

function normalizeAddressInput(body) {
  return {
    label: typeof body.label === "string" ? body.label.trim() : "",
    line1: typeof body.line1 === "string" ? body.line1.trim() : "",
    line2: typeof body.line2 === "string" ? body.line2.trim() : "",
    city: typeof body.city === "string" ? body.city.trim() : "",
    postalCode:
      typeof body.postalCode === "string" ? body.postalCode.trim() : "",
    country: typeof body.country === "string" ? body.country.trim() : "",
    phone: typeof body.phone === "string" ? body.phone.trim() : "",
  };
}

function validateAddress(address) {
  if (!address.line1) return "Address line 1 is required";
  if (!address.city) return "City is required";
  if (!address.phone) return "Phone number is required";
  if (address.phone.length < 5) return "Phone number is too short";
  return null;
}

app.post(
  "/api/auth/register",
  authLimiter,
  ah(async (req, res) => {
    const { name, email, password } = req.body || {};

    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return res
        .status(400)
        .json({ success: false, message: "A valid name is required" });
    }
    if (!isValidEmail(email)) {
      return res
        .status(400)
        .json({ success: false, message: "A valid email is required" });
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await usersCollection.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists",
      });
    }

    const hashed = await bcrypt.hash(password, 12);
    const now = new Date();

    const doc = {
      name: name.trim(),
      email: normalizedEmail,
      password: hashed,
      profileImage: "",
      phone: "",
      addresses: [],
      defaultAddressId: null,
      provider: "email",
      providerId: null,
      role: "user",
      isVerified: false,
      createdAt: now,
      updatedAt: now,
    };

    const result = await usersCollection.insertOne(doc);
    const user = { _id: result.insertedId, ...doc };

    const token = signToken({ userId: user._id.toString(), role: user.role });
    res.cookie("token", token, getCookieOptions());

    res.status(201).json({
      success: true,
      message: "Registration successful",
      user: toSafeUser(user),
    });
  }),
);

app.post(
  "/api/auth/login",
  authLimiter,
  ah(async (req, res) => {
    const { email, password } = req.body || {};

    if (!isValidEmail(email) || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await usersCollection.findOne({ email: normalizedEmail });

    if (!user) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    if (!user.password) {
      return res.status(400).json({
        success: false,
        message: `This account uses ${user.provider || "a social"} sign-in. Please continue with ${user.provider || "your social provider"} instead.`,
      });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    const token = signToken({
      userId: user._id.toString(),
      role: user.role || "user",
    });
    res.cookie("token", token, getCookieOptions());

    res.json({
      success: true,
      message: "Login successful",
      user: toSafeUser(user),
    });
  }),
);

app.get(
  "/api/auth/me",
  authenticate,
  ah(async (req, res) => {
    const user = await usersCollection.findOne(
      { email: req.user.email },
      {
        projection: {
          password: 0,
          resetPasswordToken: 0,
          resetPasswordExpires: 0,
        },
      },
    );
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    res.json({ success: true, user: toSafeUser(user) });
  }),
);

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token", getClearCookieOptions());
  res.json({ success: true, message: "Logged out successfully" });
});

app.post(
  "/api/auth/forgot-password",
  authLimiter,
  ah(async (req, res) => {
    const { email } = req.body || {};
    if (!isValidEmail(email)) {
      return res
        .status(400)
        .json({ success: false, message: "A valid email is required" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await usersCollection.findOne({ email: normalizedEmail });

    if (user && user.provider === "email" && user.password) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const hashedToken = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");
      const expires = new Date(Date.now() + 30 * 60 * 1000);

      await usersCollection.updateOne(
        { _id: user._id },
        {
          $set: {
            resetPasswordToken: hashedToken,
            resetPasswordExpires: expires,
            updatedAt: new Date(),
          },
        },
      );

      const resetUrl = `${clientOrigin()}/reset-password/${rawToken}`;

      try {
        await sendPasswordResetEmail(user.email, resetUrl);
      } catch (e) {
        console.error("Failed to send reset email", e);
      }
    }

    res.json({
      success: true,
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });
  }),
);

app.post(
  "/api/auth/reset-password/:token",
  authLimiter,
  ah(async (req, res) => {
    const { password } = req.body || {};
    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const user = await usersCollection.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or expired reset link" });
    }

    const hashed = await bcrypt.hash(password, 12);
    await usersCollection.updateOne(
      { _id: user._id },
      {
        $set: { password: hashed, updatedAt: new Date() },
        $unset: { resetPasswordToken: "", resetPasswordExpires: "" },
      },
    );

    res.json({
      success: true,
      message: "Password has been reset. You can now log in.",
    });
  }),
);

app.post(
  "/api/auth/change-password",
  authenticate,
  authLimiter,
  ah(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current and new password are required",
      });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters",
      });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different",
      });
    }

    const user = await usersCollection.findOne({ email: req.user.email });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    if (!user.password) {
      return res.status(400).json({
        success: false,
        message: `This account signs in with ${user.provider}. Use "Forgot password" to set one.`,
      });
    }

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      return res
        .status(401)
        .json({ success: false, message: "Current password is incorrect" });
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { password: hashed, updatedAt: new Date() } },
    );

    await logActivity(`Password changed for ${user.email}`, "warning");

    res.json({ success: true, message: "Password updated successfully" });
  }),
);

app.get(
  "/api/auth/google",
  requireStrategy("google"),
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
  }),
);

app.get(
  "/api/auth/google/callback",
  requireStrategy("google"),
  passport.authenticate("google", {
    session: false,
    failureRedirect: `${clientOrigin()}/?authError=google`,
  }),
  ah(async (req, res) => {
    const user = req.user;
    const token = signToken({
      userId: user._id.toString(),
      role: user.role || "user",
    });
    res.cookie("token", token, getCookieOptions());
    res.redirect(clientOrigin());
  }),
);

app.get(
  "/api/auth/facebook",
  requireStrategy("facebook"),
  passport.authenticate("facebook", { scope: ["email"], session: false }),
);

app.get(
  "/api/auth/facebook/callback",
  requireStrategy("facebook"),
  passport.authenticate("facebook", {
    session: false,
    failureRedirect: `${clientOrigin()}/?authError=facebook`,
  }),
  ah(async (req, res) => {
    const user = req.user;
    const token = signToken({
      userId: user._id.toString(),
      role: user.role || "user",
    });
    res.cookie("token", token, getCookieOptions());
    res.redirect(clientOrigin());
  }),
);

app.get(
  "/api/me",
  authenticate,
  ah(async (req, res) => {
    const user = await usersCollection.findOne(
      { email: req.user.email },
      {
        projection: {
          password: 0,
          resetPasswordToken: 0,
          resetPasswordExpires: 0,
        },
      },
    );
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    res.json({ success: true, user: toSafeUser(user) });
  }),
);

app.patch(
  "/api/me",
  authenticate,
  ah(async (req, res) => {
    const { name, profileImage, phone } = req.body || {};
    const update = {};
    if (typeof name === "string" && name.trim().length >= 2)
      update.name = name.trim();
    if (typeof profileImage === "string")
      update.profileImage = profileImage.trim();
    if (typeof phone === "string") update.phone = phone.trim();

    if (Object.keys(update).length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No fields provided" });
    }
    update.updatedAt = new Date();

    const result = await usersCollection.updateOne(
      { email: req.user.email },
      { $set: update },
    );
    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const fresh = await usersCollection.findOne(
      { email: req.user.email },
      {
        projection: {
          password: 0,
          resetPasswordToken: 0,
          resetPasswordExpires: 0,
        },
      },
    );
    res.json({ success: true, user: toSafeUser(fresh) });
  }),
);

app.get(
  "/api/me/addresses",
  authenticate,
  ah(async (req, res) => {
    const user = await usersCollection.findOne(
      { email: req.user.email },
      { projection: { addresses: 1, phone: 1, defaultAddressId: 1 } },
    );
    res.json({
      addresses: Array.isArray(user?.addresses) ? user.addresses : [],
      phone: user?.phone || "",
      defaultAddressId: user?.defaultAddressId || null,
    });
  }),
);

app.post(
  "/api/me/addresses",
  authenticate,
  ah(async (req, res) => {
    const input = normalizeAddressInput(req.body || {});
    const err = validateAddress(input);
    if (err) {
      return res.status(400).json({ success: false, message: err });
    }

    const user = await usersCollection.findOne({ email: req.user.email });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const existing = Array.isArray(user.addresses) ? user.addresses : [];
    if (existing.length >= 7) {
      return res.status(400).json({
        success: false,
        message: "You can save up to 7 addresses",
      });
    }

    const address = {
      id: new ObjectId().toString(),
      label: input.label || `Address ${existing.length + 1}`,
      line1: input.line1,
      line2: input.line2,
      city: input.city,
      postalCode: input.postalCode,
      country: input.country,
      phone: input.phone,
      createdAt: new Date(),
    };

    const shouldBeDefault =
      req.body?.isDefault === true || existing.length === 0;

    const update = {
      $push: { addresses: address },
      $set: { updatedAt: new Date() },
    };
    if (!user.phone && address.phone) {
      update.$set.phone = address.phone;
    }
    if (shouldBeDefault) {
      update.$set.defaultAddressId = address.id;
      if (!user.phone && address.phone) update.$set.phone = address.phone;
    }

    await usersCollection.updateOne({ email: req.user.email }, update);

    res.status(201).json({ success: true, address });
  }),
);

app.patch(
  "/api/me/addresses/:id",
  authenticate,
  ah(async (req, res) => {
    const { id } = req.params;
    const user = await usersCollection.findOne({ email: req.user.email });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const list = Array.isArray(user.addresses) ? user.addresses : [];
    const idx = list.findIndex((a) => String(a.id) === String(id));
    if (idx < 0) {
      return res
        .status(404)
        .json({ success: false, message: "Address not found" });
    }

    const input = normalizeAddressInput({ ...list[idx], ...(req.body || {}) });
    const err = validateAddress(input);
    if (err) {
      return res.status(400).json({ success: false, message: err });
    }

    list[idx] = {
      ...list[idx],
      label: input.label || list[idx].label,
      line1: input.line1,
      line2: input.line2,
      city: input.city,
      postalCode: input.postalCode,
      country: input.country,
      phone: input.phone,
      updatedAt: new Date(),
    };

    const setFields = { addresses: list, updatedAt: new Date() };
    if (req.body?.isDefault === true) {
      setFields.defaultAddressId = id;
    }

    await usersCollection.updateOne(
      { email: req.user.email },
      { $set: setFields },
    );

    res.json({ success: true, address: list[idx] });
  }),
);

app.delete(
  "/api/me/addresses/:id",
  authenticate,
  ah(async (req, res) => {
    const { id } = req.params;
    const user = await usersCollection.findOne({ email: req.user.email });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const list = (Array.isArray(user.addresses) ? user.addresses : []).filter(
      (a) => String(a.id) !== String(id),
    );

    const setFields = { addresses: list, updatedAt: new Date() };
    if (String(user.defaultAddressId || "") === String(id)) {
      setFields.defaultAddressId = list[0]?.id || null;
    }

    await usersCollection.updateOne(
      { email: req.user.email },
      { $set: setFields },
    );

    res.json({ success: true, message: "Address removed" });
  }),
);

app.patch(
  "/api/me/addresses/:id/default",
  authenticate,
  ah(async (req, res) => {
    const { id } = req.params;
    const user = await usersCollection.findOne({ email: req.user.email });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const list = Array.isArray(user.addresses) ? user.addresses : [];
    const found = list.find((a) => String(a.id) === String(id));
    if (!found) {
      return res
        .status(404)
        .json({ success: false, message: "Address not found" });
    }

    await usersCollection.updateOne(
      { email: req.user.email },
      {
        $set: {
          defaultAddressId: id,
          phone: found.phone || user.phone || "",
          updatedAt: new Date(),
        },
      },
    );

    res.json({ success: true, defaultAddressId: id });
  }),
);

app.patch(
  "/api/me/phone",
  authenticate,
  ah(async (req, res) => {
    const { phone } = req.body || {};
    if (typeof phone !== "string" || phone.trim().length < 5) {
      return res
        .status(400)
        .json({ success: false, message: "A valid phone number is required" });
    }

    await usersCollection.updateOne(
      { email: req.user.email },
      { $set: { phone: phone.trim(), updatedAt: new Date() } },
    );

    res.json({ success: true, phone: phone.trim() });
  }),
);

app.get(
  "/api/admin/users",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const list = await usersCollection
      .find()
      .project({ password: 0, resetPasswordToken: 0, resetPasswordExpires: 0 })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ success: true, users: list.map(toClient) });
  }),
);

app.post(
  "/api/admin/users",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const { name, email, password, role } = req.body || {};

    if (!isValidEmail(email)) {
      return res
        .status(400)
        .json({ success: false, message: "A valid email is required" });
    }
    if (!["user", "admin"].includes(role)) {
      return res
        .status(400)
        .json({ success: false, message: "Role must be 'user' or 'admin'" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await usersCollection.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists",
      });
    }

    const now = new Date();
    const doc = {
      name: (name || "").trim(),
      email: normalizedEmail,
      password: password ? await bcrypt.hash(password, 12) : null,
      profileImage: "",
      phone: "",
      addresses: [],
      defaultAddressId: null,
      provider: "email",
      providerId: null,
      role,
      isVerified: true,
      createdAt: now,
      updatedAt: now,
    };

    const result = await usersCollection.insertOne(doc);
    res.status(201).json({
      success: true,
      user: toSafeUser({ _id: result.insertedId, ...doc }),
    });
  }),
);

app.patch(
  "/api/admin/users/:id/role",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id)
      return res
        .status(400)
        .json({ success: false, message: "Invalid user id" });

    const { role } = req.body || {};
    if (!["user", "admin"].includes(role)) {
      return res
        .status(400)
        .json({ success: false, message: "Role must be 'user' or 'admin'" });
    }

    const target = await usersCollection.findOne({ _id });
    if (!target)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    if (target.role === "admin" && role !== "admin") {
      const adminCount = await usersCollection.countDocuments({
        role: "admin",
      });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          message: "Cannot remove the last remaining admin",
        });
      }
    }

    await usersCollection.updateOne(
      { _id },
      { $set: { role, updatedAt: new Date() } },
    );
    res.json({ success: true, message: "Role updated successfully" });
  }),
);

app.delete(
  "/api/admin/users/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id)
      return res
        .status(400)
        .json({ success: false, message: "Invalid user id" });

    const target = await usersCollection.findOne({ _id });
    if (!target)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    if (target.role === "admin") {
      const adminCount = await usersCollection.countDocuments({
        role: "admin",
      });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          message: "Cannot delete the last remaining admin",
        });
      }
    }

    await usersCollection.deleteOne({ _id });
    res.json({ success: true, message: "User deleted successfully" });
  }),
);

app.get(
  "/api/dashboard/summary",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const thisMonth = monthRange(0);
    const lastMonth = monthRange(1);

    const [
      revThis,
      revLast,
      ordThis,
      ordLast,
      custTotal,
      custThis,
      custLast,
      prodTotal,
      lowStock,
    ] = await Promise.all([
      orders
        .aggregate([
          { $match: { time: { $gte: thisMonth.start, $lte: thisMonth.end } } },
          { $group: { _id: null, sum: { $sum: "$total" } } },
        ])
        .toArray(),
      orders
        .aggregate([
          { $match: { time: { $gte: lastMonth.start, $lte: lastMonth.end } } },
          { $group: { _id: null, sum: { $sum: "$total" } } },
        ])
        .toArray(),
      orders.countDocuments({
        time: { $gte: thisMonth.start, $lte: thisMonth.end },
      }),
      orders.countDocuments({
        time: { $gte: lastMonth.start, $lte: lastMonth.end },
      }),
      customers.countDocuments({}),
      customers.countDocuments({
        createdAt: { $gte: thisMonth.start, $lte: thisMonth.end },
      }),
      customers.countDocuments({
        createdAt: { $gte: lastMonth.start, $lte: lastMonth.end },
      }),
      products.countDocuments({}),
      products.countDocuments({
        status: { $in: ["Low stock", "Out of stock"] },
      }),
    ]);

    const revenueThis = revThis[0]?.sum || 0;
    const revenueLast = revLast[0]?.sum || 0;

    res.json({
      revenue: {
        value: Math.round(revenueThis),
        delta: pctDelta(revenueThis, revenueLast),
        trend: revenueThis >= revenueLast ? "up" : "down",
      },
      orders: {
        value: ordThis,
        delta: pctDelta(ordThis, ordLast),
        trend: ordThis >= ordLast ? "up" : "down",
      },
      customers: {
        value: custTotal,
        delta: pctDelta(custThis, custLast),
        trend: custThis >= custLast ? "up" : "down",
        newThisMonth: custThis,
      },
      products: { value: prodTotal, lowStock },
    });
  }),
);

app.get(
  "/api/dashboard/revenue",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const range = ["7d", "30d", "12m"].includes(req.query.range)
      ? req.query.range
      : "12m";
    const config = getRevenueRangeConfig(range);
    const allOrders = await orders
      .find({
        time: { $gte: config.prevStart, $lte: config.end },
        status: { $ne: "Cancelled" },
      })
      .project({ total: 1, time: 1 })
      .toArray();

    const current = allOrders.filter((o) => new Date(o.time) >= config.start);
    const previous = allOrders.filter((o) => new Date(o.time) < config.start);

    const data = bucketSums(current, config, config.start);
    const compare = bucketSums(previous, config, config.prevStart);
    const labels = buildLabels(config, config.start);
    const total = data.reduce((a, b) => a + b, 0);
    const prevTotal = compare.reduce((a, b) => a + b, 0);

    res.json({
      data,
      compare,
      labels,
      total,
      delta: pctDelta(total, prevTotal),
    });
  }),
);

app.get(
  "/api/dashboard/reservations",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const query = {};
    if (req.query.status && req.query.status !== "All")
      query.status = req.query.status;
    if (req.query.upcoming === "true") {
      query.date = { $gte: new Date().toISOString().slice(0, 10) };
    }
    if (req.query.date) query.date = req.query.date;

    const list = await reservations
      .find(query)
      .sort({ date: 1, time: 1, createdAt: 1 })
      .toArray();

    res.json(list.map(toClient));
  }),
);

app.get(
  "/api/dashboard/activity",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const list = await activity.find().sort({ _id: -1 }).limit(8).toArray();
    res.json(
      list.map((a) => ({
        id: a._id.toString(),
        text: a.text,
        tone: a.tone,
        time: a.createdAt ? relativeTime(a.createdAt) : a.time || "Just now",
      })),
    );
  }),
);

app.get(
  "/api/products",
  ah(async (req, res) => {
    const { category, status, search } = req.query;
    const query = {};
    if (category && category !== "All") query.category = category;
    if (status && status !== "All") query.status = status;
    if (search) query.name = { $regex: String(search), $options: "i" };
    const list = await products.find(query).sort({ _id: -1 }).toArray();
    res.json(list.map(toClient));
  }),
);

app.get(
  "/api/products/keyword",
  ah(async (req, res) => {
    await keywordSearch(req, res, toSearchResult);
  }),
);

app.post(
  "/api/products",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const p = req.body || {};
    if (!p.name || p.price === undefined || !p.category) {
      return res.status(400).json({ error: "Invalid product data" });
    }

    const doc = {
      name: p.name,
      description: p.description ?? "",
      category: p.category,
      price: Number(p.price),
      stock: Number(p.stock ?? 0),
      sold: Number(p.sold ?? 0),
      rating: Number(p.rating ?? 0),
      status: p.status ?? "Draft",
      images: normalizeImages(p.images),
      ingredients: normalizeStringArray(p.ingredients),
      diet: p.diet ?? "",
      cuisine: p.cuisine ?? "",
      spiceLevel: Number(p.spiceLevel ?? 0),
      prepTime: Number(p.prepTime ?? 0),
      calories: Number(p.calories ?? 0),
      tags: normalizeStringArray(p.tags),
      isFeatured: p.isFeatured === true,
      isAvailable: p.isAvailable !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await products.insertOne(doc);
    res.status(201).json(toClient({ _id: result.insertedId, ...doc }));
  }),
);

app.patch(
  "/api/products/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid product id" });

    const update = buildProductUpdate(req.body || {});
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "No fields provided" });
    }
    update.updatedAt = new Date();

    const result = await products.updateOne({ _id }, { $set: update });
    if (result.matchedCount === 0)
      return res.status(404).json({ error: "Product not found" });

    const fresh = await products.findOne({ _id });
    res.json(toClient(fresh));
  }),
);

app.delete(
  "/api/products/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid product id" });
    const result = await products.deleteOne({ _id });
    if (result.deletedCount === 0)
      return res.status(404).json({ error: "Product not found" });
    res.json({ message: "Product deleted" });
  }),
);

app.get(
  "/api/categories",
  ah(async (req, res) => {
    const list = await categories.find().toArray();
    res.json(list.map(toClient));
  }),
);

app.post(
  "/api/categories",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const { name, description, image } = req.body || {};
    if (!name) return res.status(400).json({ error: "Category name required" });
    const doc = {
      name,
      description: description || "",
      image: image || "",
      items: 0,
      revenue: 0,
      share: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await categories.insertOne(doc);
    res.status(201).json(toClient({ _id: result.insertedId, ...doc }));
  }),
);

app.patch(
  "/api/categories/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid category id" });
    const update = pick(req.body, [
      "name",
      "description",
      "image",
      "items",
      "revenue",
      "share",
    ]);
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "No fields provided" });
    }
    update.updatedAt = new Date();
    const result = await categories.updateOne({ _id }, { $set: update });
    if (result.matchedCount === 0)
      return res.status(404).json({ error: "Category not found" });
    res.json({ message: "Category updated" });
  }),
);

app.delete(
  "/api/categories/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid category id" });
    const result = await categories.deleteOne({ _id });
    if (result.deletedCount === 0)
      return res.status(404).json({ error: "Category not found" });
    res.json({ message: "Category deleted" });
  }),
);

function tierFor(spent) {
  if (spent >= 1000) return "VIP";
  if (spent >= 500) return "Gold";
  if (spent >= 200) return "Silver";
  return "Regular";
}

app.get(
  "/api/customers",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const { tier, search } = req.query;

    const baseQuery = {};
    if (search) {
      const s = String(search);
      baseQuery.$or = [
        { name: { $regex: s, $options: "i" } },
        { email: { $regex: s, $options: "i" } },
        { city: { $regex: s, $options: "i" } },
      ];
    }

    const list = await customers.find(baseQuery).toArray();

    const agg = await orders
      .aggregate([
        { $match: { status: { $ne: "Cancelled" } } },
        {
          $group: {
            _id: { $toLower: "$email" },
            orders: { $sum: 1 },
            spent: { $sum: "$total" },
            lastTime: { $max: "$time" },
          },
        },
      ])
      .toArray();
    const byEmail = new Map(agg.map((a) => [a._id, a]));

    const enriched = list.map((c) => {
      const a = byEmail.get((c.email || "").toLowerCase());
      const spent = Number(a?.spent || 0);
      return {
        ...toClient(c),
        orders: a?.orders || 0,
        spent: +spent.toFixed(2),
        tier: tierFor(spent),
        lastVisit: a?.lastTime
          ? new Date(a.lastTime).toISOString().slice(0, 10)
          : c.lastVisit || "",
      };
    });

    const filtered =
      tier && tier !== "All"
        ? enriched.filter((c) => c.tier === tier)
        : enriched;

    res.json(filtered.sort((a, b) => b.spent - a.spent));
  }),
);

app.post(
  "/api/customers",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const { name, email, city } = req.body || {};
    if (!name || !email)
      return res.status(400).json({ error: "Name and email required" });
    const doc = {
      name,
      email: email.trim().toLowerCase(),
      city: city || "",
      orders: 0,
      spent: 0,
      tier: "Regular",
      lastVisit: new Date().toISOString().slice(0, 10),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await customers.insertOne(doc);
    res.status(201).json(toClient({ _id: result.insertedId, ...doc }));
  }),
);

app.get(
  "/api/cart",
  authenticate,
  ah(async (req, res) => {
    const data = await buildCartResponse(req.user.id);
    res.json(data);
  }),
);

app.post(
  "/api/cart/items",
  authenticate,
  ah(async (req, res) => {
    const { productId, quantity } = req.body || {};
    const _id = oid(productId);
    if (!_id) return res.status(400).json({ error: "Invalid product id" });

    const qty = Math.max(1, Math.min(99, Number(quantity) || 1));
    const product = await products.findOne({ _id });
    if (!product) return res.status(404).json({ error: "Product not found" });

    const now = new Date();
    const existing = await carts.findOne({ userId: req.user.id });

    if (!existing) {
      await carts.insertOne({
        userId: req.user.id,
        email: req.user.email,
        items: [
          {
            productId: String(_id),
            quantity: qty,
            priceSnapshot: Number(product.price) || 0,
            nameSnapshot: product.name || "",
            addedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const items = Array.isArray(existing.items) ? existing.items : [];
      const idx = items.findIndex((i) => String(i.productId) === String(_id));
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          quantity: Math.max(
            1,
            Math.min(99, Number(items[idx].quantity) + qty),
          ),
          priceSnapshot: Number(product.price) || items[idx].priceSnapshot || 0,
          nameSnapshot: product.name || items[idx].nameSnapshot || "",
        };
      } else {
        items.push({
          productId: String(_id),
          quantity: qty,
          priceSnapshot: Number(product.price) || 0,
          nameSnapshot: product.name || "",
          addedAt: now,
        });
      }
      await carts.updateOne(
        { userId: req.user.id },
        { $set: { items, updatedAt: now } },
      );
    }

    const data = await buildCartResponse(req.user.id);
    res.json(data);
  }),
);

app.patch(
  "/api/cart/items/:productId",
  authenticate,
  ah(async (req, res) => {
    const _id = oid(req.params.productId);
    if (!_id) return res.status(400).json({ error: "Invalid product id" });

    const { quantity } = req.body || {};
    const qty = Math.floor(Number(quantity));
    if (!Number.isFinite(qty)) {
      return res.status(400).json({ error: "Invalid quantity" });
    }

    const existing = await carts.findOne({ userId: req.user.id });
    if (!existing) {
      return res.status(404).json({ error: "Cart is empty" });
    }

    let items = Array.isArray(existing.items) ? existing.items : [];
    if (qty <= 0) {
      items = items.filter((i) => String(i.productId) !== String(_id));
    } else {
      const clamped = Math.min(99, qty);
      const idx = items.findIndex((i) => String(i.productId) === String(_id));
      if (idx < 0) {
        return res.status(404).json({ error: "Item not in cart" });
      }
      items[idx] = { ...items[idx], quantity: clamped };
    }

    await carts.updateOne(
      { userId: req.user.id },
      { $set: { items, updatedAt: new Date() } },
    );

    const data = await buildCartResponse(req.user.id);
    res.json(data);
  }),
);

app.delete(
  "/api/cart",
  authenticate,
  ah(async (req, res) => {
    await carts.updateOne(
      { userId: req.user.id },
      { $set: { items: [], updatedAt: new Date() } },
    );
    res.json({ items: [], count: 0, subtotal: 0 });
  }),
);

app.get(
  "/api/orders",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const { status, search } = req.query;
    const query = {};
    if (status && status !== "All") query.status = status;
    if (search) {
      const s = String(search);
      query.$or = [
        { orderId: { $regex: s, $options: "i" } },
        { customer: { $regex: s, $options: "i" } },
        { email: { $regex: s, $options: "i" } },
      ];
    }
    const list = await orders
      .find(query)
      .sort({ time: -1 })
      .limit(200)
      .toArray();
    res.json(list.map(formatOrder));
  }),
);

app.post("/api/orders", optionalAuthenticate, ah(createOrderHandler));

app.patch(
  "/api/orders/:orderId",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const update = pick(req.body, [
      "status",
      "payment",
      "table",
      "customer",
      "channel",
      "items",
      "phone",
      "address",
      "addressId",
    ]);
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "No fields provided" });
    }
    const result = await orders.updateOne(
      { orderId: req.params.orderId },
      { $set: update },
    );
    if (result.matchedCount === 0)
      return res.status(404).json({ error: "Order not found" });
    res.json({ message: "Order updated" });
  }),
);

app.get(
  "/orders/my-orders",
  authenticate,
  ah(async (req, res) => {
    const query = req.user.id
      ? { $or: [{ userId: req.user.id }, { email: req.user.email }] }
      : { email: req.user.email };
    const list = await orders.find(query).sort({ time: -1 }).toArray();
    res.json(list.map(formatOrder));
  }),
);

app.get(
  "/orders/my-orders/:email",
  authenticate,
  ah(async (req, res) => {
    if (
      req.user.email !== String(req.params.email).toLowerCase() &&
      req.user.role !== "admin"
    ) {
      return res
        .status(403)
        .json({ error: "Not authorized to view these orders" });
    }
    const list = await orders
      .find({ $or: [{ userId: req.user.id }, { email: req.params.email }] })
      .sort({ time: -1 })
      .toArray();
    res.json(list.map(formatOrder));
  }),
);

app.get(
  "/orders/history/:email",
  authenticate,
  ah(async (req, res) => {
    if (
      req.user.email !== String(req.params.email).toLowerCase() &&
      req.user.role !== "admin"
    ) {
      return res
        .status(403)
        .json({ error: "Not authorized to view this history" });
    }
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      100,
    );
    const query = {
      $or: [{ userId: req.user.id }, { email: req.params.email }],
    };
    if (req.query.status) query.status = req.query.status;
    const list = await orders
      .find(query)
      .sort({ time: -1 })
      .limit(limit)
      .toArray();
    res.json({ count: list.length, limit, orders: list.map(formatOrder) });
  }),
);

app.get(
  "/orders/:orderId",
  authenticate,
  ah(async (req, res) => {
    const order = await orders.findOne({ orderId: req.params.orderId });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!ownsRecord(order, getIdentity(req)))
      return res.status(403).json({ error: "Not your order" });
    res.json({ ...formatOrder(order), email: order.email });
  }),
);

app.post("/orders", optionalAuthenticate, ah(createOrderHandler));

app.patch(
  "/orders/:orderId/cancel",
  authenticate,
  ah(async (req, res) => {
    const order = await orders.findOne({ orderId: req.params.orderId });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!ownsRecord(order, getIdentity(req)))
      return res.status(403).json({ error: "Not your order" });
    if (!["Pending", "Preparing"].includes(order.status))
      return res
        .status(409)
        .json({ error: "Order can no longer be cancelled" });
    await orders.updateOne(
      { orderId: req.params.orderId },
      { $set: { status: "Cancelled" } },
    );
    await logActivity(
      `Order ${order.orderId} was cancelled by ${req.user.email}`,
      "danger",
    );
    res.json({ message: "Order cancelled" });
  }),
);

app.get(
  "/api/reservations",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const { status, search, date, upcoming } = req.query;
    const query = {};
    if (status && status !== "All") query.status = status;
    if (date) query.date = date;
    if (upcoming === "true")
      query.date = { $gte: new Date().toISOString().slice(0, 10) };
    if (search) {
      const s = String(search);
      query.$or = [
        { name: { $regex: s, $options: "i" } },
        { email: { $regex: s, $options: "i" } },
        { phone: { $regex: s, $options: "i" } },
      ];
    }
    const list = await reservations
      .find(query)
      .sort({ date: 1, time: 1, createdAt: 1 })
      .toArray();
    res.json(list.map(toClient));
  }),
);

app.post(
  "/api/reservations",
  optionalAuthenticate,
  ah(createReservationHandler),
);

app.patch(
  "/api/reservations/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid reservation id" });
    const update = pick(req.body, [
      "name",
      "email",
      "phone",
      "date",
      "time",
      "guests",
      "occasion",
      "notes",
      "status",
      "table",
    ]);
    if (update.guests !== undefined) update.guests = Number(update.guests);
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "No fields provided" });
    }
    const result = await reservations.updateOne({ _id }, { $set: update });
    if (result.matchedCount === 0)
      return res.status(404).json({ error: "Reservation not found" });
    const fresh = await reservations.findOne({ _id });
    res.json(toClient(fresh));
  }),
);

app.delete(
  "/api/reservations/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid reservation id" });
    const result = await reservations.deleteOne({ _id });
    if (result.deletedCount === 0)
      return res.status(404).json({ error: "Reservation not found" });
    res.json({ message: "Reservation deleted" });
  }),
);

app.post("/reservations", optionalAuthenticate, ah(createReservationHandler));

app.get(
  "/reservations/my-reservations",
  authenticate,
  ah(async (req, res) => {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 100, 1),
      200,
    );
    const query = { $or: [{ userId: req.user.id }, { email: req.user.email }] };
    const list = await reservations
      .find(query)
      .sort({ date: 1, time: 1 })
      .limit(limit)
      .toArray();
    res.json(list.map(toClient));
  }),
);

app.get(
  "/reservations/my-reservations/:email",
  authenticate,
  ah(async (req, res) => {
    if (
      req.user.email !== String(req.params.email).toLowerCase() &&
      req.user.role !== "admin"
    ) {
      return res
        .status(403)
        .json({ error: "Not authorized to view these reservations" });
    }
    const list = await reservations
      .find({ $or: [{ userId: req.user.id }, { email: req.params.email }] })
      .sort({ date: 1, time: 1 })
      .toArray();
    res.json(list.map(toClient));
  }),
);

app.get(
  "/reservations/history/:email",
  authenticate,
  ah(async (req, res) => {
    if (
      req.user.email !== String(req.params.email).toLowerCase() &&
      req.user.role !== "admin"
    ) {
      return res
        .status(403)
        .json({ error: "Not authorized to view this history" });
    }
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      100,
    );
    const query = {
      $or: [{ userId: req.user.id }, { email: req.params.email }],
    };
    if (req.query.status) query.status = req.query.status;
    const list = await reservations
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json({
      count: list.length,
      limit,
      reservations: list.map(toClient),
    });
  }),
);

app.get(
  "/reservations/:id",
  authenticate,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid reservation id" });
    const reservation = await reservations.findOne({ _id });
    if (!reservation)
      return res.status(404).json({ error: "Reservation not found" });
    if (!ownsRecord(reservation, getIdentity(req)))
      return res.status(403).json({ error: "Not your reservation" });
    res.json(toClient(reservation));
  }),
);

app.patch(
  "/reservations/:id/cancel",
  authenticate,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid reservation id" });
    const reservation = await reservations.findOne({ _id });
    if (!reservation)
      return res.status(404).json({ error: "Reservation not found" });
    if (!ownsRecord(reservation, getIdentity(req)))
      return res.status(403).json({ error: "Not your reservation" });
    if (!["Confirmed", "Pending"].includes(reservation.status))
      return res
        .status(409)
        .json({ error: "Reservation can no longer be cancelled" });
    await reservations.updateOne({ _id }, { $set: { status: "Cancelled" } });
    await logActivity(
      `Reservation for ${reservation.name} on ${reservation.date} was cancelled`,
      "danger",
    );
    res.json({ message: "Reservation cancelled" });
  }),
);

app.get(
  "/api/analytics/traffic",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const doc = await analytics.findOne({ key: "traffic-sources" });
    res.json(doc?.segments || []);
  }),
);

app.get(
  "/api/analytics/funnel",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const doc = await analytics.findOne({ key: "funnel" });
    res.json(doc?.steps || []);
  }),
);

app.get(
  "/api/analytics/weekday-orders",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const since = new Date();
    since.setDate(since.getDate() - 90);
    const list = await orders
      .find({ time: { $gte: since } })
      .project({ time: 1 })
      .toArray();
    const counts = new Array(7).fill(0);
    list.forEach((o) => (counts[new Date(o.time).getDay()] += 1));
    res.json([
      counts[1],
      counts[2],
      counts[3],
      counts[4],
      counts[5],
      counts[6],
      counts[0],
    ]);
  }),
);

app.get(
  "/api/analytics/heatmap",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const since = new Date();
    since.setDate(since.getDate() - 90);
    const list = await orders
      .find({ time: { $gte: since } })
      .project({ time: 1 })
      .toArray();
    const hours = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
    const grid = Array.from({ length: 7 }, () =>
      new Array(hours.length).fill(0),
    );
    list.forEach((o) => {
      const d = new Date(o.time);
      const dow = (d.getDay() + 6) % 7;
      const hIdx = hours.indexOf(d.getHours());
      if (hIdx >= 0) grid[dow][hIdx] += 1;
    });
    res.json({ hours, grid });
  }),
);

app.get(
  "/api/analytics/top-dishes",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const list = await products.find().sort({ sold: -1 }).limit(5).toArray();
    const maxSold = list.reduce((m, p) => Math.max(m, p.sold || 0), 0) || 1;
    res.json(
      list.map((p) => ({
        name: p.name,
        image: (p.images && p.images[0]) || "",
        sold: p.sold || 0,
        share: Math.round(((p.sold || 0) / maxSold) * 100),
      })),
    );
  }),
);

const COLORS = {
  ink: "#1A1A1A",
  muted: "#6B6B6B",
  border: "#D9D9D9",
  headerBg: "#F2F2F2",
  gold: "#E0A526",
  zebra: "#FAFAFA",
  headerInk: "#2B1B10",
};

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(report, rows) {
  const meta = [
    [report.name || "Report"],
    [`Generated ${new Date().toLocaleString("en-US")}`],
    [`Period: ${report.range || "—"}`],
    [],
  ];
  const all = [...meta, ...rows];
  return "\uFEFF" + all.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

function buildXlsx(report, rows) {
  const meta = [
    [report.name || "Report"],
    ["Generated", new Date().toLocaleString("en-US")],
    ["Period", report.range || "—"],
    [],
  ];
  const aoa = [...meta, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const widths = [];
  rows.forEach((row) => {
    row.forEach((cell, i) => {
      const len = String(cell ?? "").length + 2;
      widths[i] = Math.max(widths[i] || 10, Math.min(len, 50));
    });
  });
  ws["!cols"] = widths.map((w) => ({ wch: w }));

  const headerRow = meta.length;
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: headerRow, c })];
    if (cell) {
      cell.s = {
        font: { bold: true, color: { rgb: "FFFFFFFF" } },
        fill: { fgColor: { rgb: "FFE0A526" } },
        alignment: { vertical: "center", horizontal: "left" },
      };
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Report");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function buildPdf(report, rows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 30,
      info: {
        Title: report.name || "Report",
        Author: "Master Table",
        Subject: report.range || "",
      },
    });

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth =
      doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const leftX = doc.page.margins.left;

    doc.rect(0, 0, doc.page.width, 90).fill(COLORS.gold);
    doc
      .fillColor(COLORS.headerInk)
      .font("Helvetica-Bold")
      .fontSize(20)
      .text("MASTER TABLE", leftX, 26, { width: pageWidth });
    doc
      .fillColor(COLORS.headerInk)
      .font("Helvetica")
      .fontSize(10)
      .text("Restaurant Analytics", leftX, 52, { width: pageWidth });

    let cursorY = 120;

    doc
      .fillColor(COLORS.ink)
      .font("Helvetica-Bold")
      .fontSize(18)
      .text(report.name || "Report", leftX, cursorY, { width: pageWidth });
    cursorY += 26;

    doc.fillColor(COLORS.muted).font("Helvetica").fontSize(10);
    doc.text(`Period: ${report.range || "—"}`, leftX, cursorY);
    cursorY += 14;
    doc.text(
      `Generated: ${new Date().toLocaleString("en-US")}`,
      leftX,
      cursorY,
    );
    cursorY += 14;
    doc.text(`Format: ${report.format || "PDF"}`, leftX, cursorY);
    cursorY += 20;

    doc
      .moveTo(leftX, cursorY)
      .lineTo(leftX + pageWidth, cursorY)
      .strokeColor(COLORS.border)
      .lineWidth(1)
      .stroke();
    cursorY += 16;

    if (!rows.length) {
      doc
        .fillColor(COLORS.muted)
        .font("Helvetica-Oblique")
        .fontSize(11)
        .text("No data available.", leftX, cursorY);
      doc.end();
      return;
    }

    const headers = rows[0];
    const body = rows.slice(1);
    const colCount = headers.length;
    const colWidth = pageWidth / colCount;
    const rowHeight = 22;
    const headerHeight = 28;
    const bottomLimit = doc.page.height - doc.page.margins.bottom - 20;

    const drawHeader = () => {
      doc.rect(leftX, cursorY, pageWidth, headerHeight).fill(COLORS.headerBg);
      doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(9);
      headers.forEach((h, i) => {
        doc.text(String(h), leftX + 8 + i * colWidth, cursorY + 9, {
          width: colWidth - 16,
          height: headerHeight,
          ellipsis: true,
        });
      });
      doc
        .rect(leftX, cursorY, pageWidth, headerHeight)
        .strokeColor(COLORS.border)
        .lineWidth(0.5)
        .stroke();
      cursorY += headerHeight;
    };

    drawHeader();
    doc.font("Helvetica").fontSize(9).fillColor(COLORS.ink);

    body.forEach((row, idx) => {
      if (cursorY + rowHeight > bottomLimit) {
        doc.addPage();
        cursorY = doc.page.margins.top;
        drawHeader();
        doc.font("Helvetica").fontSize(9).fillColor(COLORS.ink);
      }
      if (idx % 2 === 1) {
        doc.rect(leftX, cursorY, pageWidth, rowHeight).fill(COLORS.zebra);
      }
      row.forEach((cell, i) => {
        doc.fillColor(COLORS.ink);
        doc.text(String(cell ?? ""), leftX + 8 + i * colWidth, cursorY + 7, {
          width: colWidth - 16,
          height: rowHeight,
          ellipsis: true,
          lineBreak: false,
        });
      });
      doc
        .rect(leftX, cursorY, pageWidth, rowHeight)
        .strokeColor(COLORS.border)
        .lineWidth(0.3)
        .stroke();
      cursorY += rowHeight;
    });

    const range = doc.bufferedPageRange();
    for (let p = 0; p < range.count; p++) {
      doc.switchToPage(range.start + p);
      const y = doc.page.height - doc.page.margins.bottom + 5;
      doc
        .moveTo(leftX, y - 10)
        .lineTo(leftX + pageWidth, y - 10)
        .strokeColor(COLORS.border)
        .lineWidth(0.5)
        .stroke();
      doc
        .fillColor(COLORS.muted)
        .font("Helvetica")
        .fontSize(8)
        .text(`Master Table · ${report.name || "Report"}`, leftX, y, {
          width: pageWidth / 2,
          align: "left",
        });
      doc.text(`Page ${p + 1} of ${range.count}`, leftX, y, {
        width: pageWidth,
        align: "right",
      });
    }

    doc.end();
  });
}

async function buildReportRows(report) {
  const name = (report.name || "").toLowerCase();

  if (name.includes("inventory")) {
    const list = await products
      .find()
      .project({ name: 1, category: 1, stock: 1, sold: 1, price: 1, status: 1 })
      .sort({ stock: 1 })
      .toArray();
    return [
      ["Product", "Category", "Stock", "Sold", "Price", "Status"],
      ...list.map((p) => [
        p.name,
        p.category,
        p.stock ?? 0,
        p.sold ?? 0,
        `$${Number(p.price ?? 0).toFixed(2)}`,
        p.status ?? "Active",
      ]),
    ];
  }

  if (name.includes("customer")) {
    const list = await customers.find().sort({ spent: -1 }).toArray();
    const agg = await orders
      .aggregate([
        { $match: { status: { $ne: "Cancelled" } } },
        {
          $group: {
            _id: { $toLower: "$email" },
            orders: { $sum: 1 },
            spent: { $sum: "$total" },
            lastTime: { $max: "$time" },
          },
        },
      ])
      .toArray();
    const byEmail = new Map(agg.map((a) => [a._id, a]));

    return [
      ["Name", "Email", "City", "Orders", "Spent", "Tier", "Last visit"],
      ...list.map((c) => {
        const a = byEmail.get((c.email || "").toLowerCase());
        const spent = Number(a?.spent || c.spent || 0);
        return [
          c.name,
          c.email,
          c.city || "—",
          a?.orders || c.orders || 0,
          `$${spent.toFixed(2)}`,
          tierFor(spent),
          a?.lastTime
            ? new Date(a.lastTime).toISOString().slice(0, 10)
            : c.lastVisit || "—",
        ];
      }),
    ];
  }

  if (name.includes("menu")) {
    const list = await products.find().sort({ sold: -1 }).toArray();
    return [
      ["Product", "Category", "Price", "Sold", "Revenue", "Rating"],
      ...list.map((p) => [
        p.name,
        p.category,
        `$${Number(p.price ?? 0).toFixed(2)}`,
        p.sold ?? 0,
        `$${(Number(p.price ?? 0) * Number(p.sold ?? 0)).toFixed(2)}`,
        Number(p.rating ?? 0).toFixed(1),
      ]),
    ];
  }

  const list = await orders
    .find({ status: { $ne: "Cancelled" } })
    .sort({ time: -1 })
    .limit(500)
    .toArray();

  const rows = [
    ["Order ID", "Customer", "Phone", "Status", "Items", "Total", "Time"],
  ];

  list.forEach((o) => {
    rows.push([
      o.orderId,
      o.customer,
      o.phone || o.address?.phone || "—",
      o.status,
      (o.items || []).join(", "),
      `$${Number(o.total ?? 0).toFixed(2)}`,
      o.time instanceof Date
        ? o.time.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : String(o.time ?? ""),
    ]);
  });

  return rows;
}

app.get(
  "/api/reports",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const list = await reports.find().sort({ _id: -1 }).toArray();
    res.json(list.map(toClient));
  }),
);

app.post(
  "/api/reports/generate",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const { name, format } = req.body || {};
    const doc = {
      name: name || "Custom report",
      desc: "Generated on demand",
      range: "Last 30 days",
      format: format || "PDF",
      size: `${(200 + Math.random() * 900).toFixed(0)} KB`,
      updated: "Just now",
      createdAt: new Date(),
    };
    const result = await reports.insertOne(doc);
    res.status(201).json(toClient({ _id: result.insertedId, ...doc }));
  }),
);

app.get(
  "/api/reports/:id/download",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid report id" });

    const report = await reports.findOne({ _id });
    if (!report) return res.status(404).json({ error: "Report not found" });

    const format = (report.format || "CSV").toUpperCase();
    const safeName = (report.name || "report")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const stamp = new Date().toISOString().slice(0, 10);
    const rows = await buildReportRows(report);

    if (format === "CSV") {
      const csv = buildCsv(report, rows);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName}-${stamp}.csv"`,
      );
      return res.send(csv);
    }

    if (format === "XLSX") {
      const buf = buildXlsx(report, rows);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName}-${stamp}.xlsx"`,
      );
      return res.send(buf);
    }

    if (format === "PDF") {
      const buf = await buildPdf(report, rows);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName}-${stamp}.pdf"`,
      );
      return res.send(buf);
    }

    res.status(400).json({ error: `Unsupported format: ${format}` });
  }),
);

app.get(
  "/api/settings",
  ah(async (req, res) => {
    const doc = await settings.findOne({});
    res.json(doc ? toClient(doc) : null);
  }),
);

app.patch(
  "/api/settings",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const body = { ...(req.body || {}) };
    delete body._id;
    delete body.id;
    body.updatedAt = new Date();
    const existing = await settings.findOne({});
    if (!existing) {
      const result = await settings.insertOne(body);
      return res.json(toClient({ _id: result.insertedId, ...body }));
    }
    await settings.updateOne({ _id: existing._id }, { $set: body });
    res.json({ message: "Settings updated" });
  }),
);

app.get(
  "/users",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const users = await usersCollection
      .find()
      .project({ password: 0 })
      .toArray();
    res.send(users);
  }),
);

app.get(
  "/users/:email",
  authenticate,
  ah(async (req, res) => {
    if (
      req.user.email !== String(req.params.email).toLowerCase() &&
      req.user.role !== "admin"
    ) {
      return res.status(403).send({ error: "Not authorized" });
    }
    const result = await usersCollection.findOne(
      { email: req.params.email },
      { projection: { password: 0 } },
    );
    res.send(result);
  }),
);

app.patch(
  "/users/:email",
  authenticate,
  ah(async (req, res) => {
    const { email } = req.params;
    const isSelf = req.user.email === String(email).toLowerCase();
    const isAdmin = req.user.role === "admin";

    if (!isSelf && !isAdmin) {
      return res
        .status(403)
        .send({ error: "Not authorized to update this user" });
    }

    if (req.body?.role !== undefined && !isAdmin) {
      return res.status(403).send({ error: "Only admins can change roles" });
    }

    const allowedFields = isAdmin
      ? ["role", "userEmail", "userName", "name", "profileImage"]
      : ["userEmail", "userName", "name", "profileImage"];

    const set = pick(req.body, allowedFields);

    if (set.role !== undefined && !["user", "admin"].includes(set.role)) {
      return res.status(400).send({ error: "Invalid role value" });
    }

    if (Object.keys(set).length === 0) {
      return res.status(400).send({ error: "No fields provided for update" });
    }
    set.updatedAt = new Date();

    const result = await usersCollection.updateOne({ email }, { $set: set });
    if (result.matchedCount === 0) {
      return res.status(404).send({ error: "User not found" });
    }
    res.send({ message: "User updated successfully", result });
  }),
);

app.put(
  "/user",
  optionalAuthenticate,
  ah(async (req, res) => {
    const user = { ...(req.body || {}) };
    if (!user.email) {
      return res.status(400).send({ error: "Email required" });
    }

    const isAdmin = req.user && req.user.role === "admin";
    if (!isAdmin || !["user", "admin"].includes(user.role)) {
      delete user.role;
    }

    const query = { email: user.email, name: user.displayName };
    const isExist = await usersCollection.findOne(query);
    if (isExist) {
      if (user.status === "Requested") {
        const result = await usersCollection.updateOne(query, {
          $set: { status: user.status },
        });
        return res.send(result);
      }
      return res.send(isExist);
    }
    const result = await usersCollection.updateOne(
      query,
      { $set: { ...user, timestamp: Date.now() } },
      { upsert: true },
    );
    res.send(result);
  }),
);

app.get(
  "/banners",
  ah(async (req, res) => {
    const list = await bannerCollection.find().toArray();
    res.send(list);
  }),
);

app.post(
  "/banners",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const banner = req.body;
    if (!banner || !banner.image || !banner.heading || !banner.description) {
      return res.status(400).send({ error: "Invalid banner data" });
    }
    const result = await bannerCollection.insertOne({
      image: banner.image,
      heading: banner.heading,
      description: banner.description,
      timestamp: Date.now(),
    });
    res.status(201).send({ message: "Banner uploaded successfully", result });
  }),
);

const updateBanner = ah(async (req, res) => {
  const _id = oid(req.params.id);
  if (!_id) return res.status(400).send({ error: "Invalid banner id" });
  const { image, heading, description } = req.body || {};
  if (!image && !heading && !description) {
    return res.status(400).send({ error: "No fields provided for update" });
  }
  const updateDoc = {
    $set: {
      ...(image && { image }),
      ...(heading && { heading }),
      ...(description && { description }),
    },
  };
  const result = await bannerCollection.updateOne({ _id }, updateDoc);
  if (result.matchedCount === 0) {
    return res.status(404).send({ error: "Banner not found" });
  }
  res.send({ message: "Banner updated successfully", result });
});

app.patch("/banners/:id", authenticate, requireAdmin, updateBanner);
app.put("/banners/:id", authenticate, requireAdmin, updateBanner);

app.delete(
  "/api/reports/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid report id" });
    const result = await reports.deleteOne({ _id });
    if (result.deletedCount === 0)
      return res.status(404).json({ error: "Report not found" });
    res.json({ message: "Report deleted" });
  }),
);

app.delete(
  "/api/reports",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const result = await reports.deleteMany({});
    res.json({ message: `${result.deletedCount} reports deleted` });
  }),
);

app.delete(
  "/banners/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).send({ error: "Invalid banner id" });
    const result = await bannerCollection.deleteOne({ _id });
    if (result.deletedCount === 0) {
      return res.status(404).send({ error: "Banner not found" });
    }
    res.send({ message: "Banner deleted successfully" });
  }),
);

app.get(
  "/products",
  ah(async (req, res) => {
    const { category, diet, isfeatured } = req.query;
    const query = {};
    if (category) query.category = category;
    if (diet) query.diet = diet;
    if (isfeatured !== undefined) query.isfeatured = isfeatured === "true";
    const list = await products.find(query).toArray();
    res.send(list);
  }),
);

app.get(
  "/products/keyword",
  ah(async (req, res) => {
    await keywordSearch(req, res, toSearchResult);
  }),
);

app.get(
  "/products/:id",
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).send({ error: "Invalid product id" });
    const product = await products.findOne({ _id });
    if (!product) {
      return res.status(404).send({ error: "Product not found" });
    }
    res.send(product);
  }),
);

app.post(
  "/products",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const p = req.body || {};
    if (!p.name || p.price === undefined || !p.diet || !p.category) {
      return res.status(400).send({ error: "Invalid product data" });
    }

    const doc = {
      name: p.name,
      description: p.description ?? "",
      category: p.category,
      price: Number(p.price),
      stock: Number(p.stock ?? 0),
      sold: Number(p.sold ?? 0),
      rating: Number(p.rating ?? 0),
      status: p.status ?? "Active",
      images: normalizeImages(p.images),
      ingredients: normalizeStringArray(p.ingredients),
      diet: p.diet,
      cuisine: p.cuisine ?? "",
      spiceLevel: Number(p.spiceLevel ?? 0),
      prepTime: Number(p.prepTime ?? 0),
      calories: Number(p.calories ?? 0),
      tags: normalizeStringArray(p.tags),
      isFeatured: p.isFeatured === true,
      isAvailable: p.isAvailable !== false,
      isfeatured: p.isfeatured === true || p.isFeatured === true,
      timestamp: Date.now(),
    };

    const result = await products.insertOne(doc);
    res.status(201).send({ message: "Product created successfully", result });
  }),
);

app.patch(
  "/products/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).send({ error: "Invalid product id" });

    const update = buildProductUpdate(req.body || {});
    if (Object.keys(update).length === 0) {
      return res.status(400).send({ error: "No fields provided for update" });
    }
    update.updatedAt = new Date();

    const result = await products.updateOne({ _id }, { $set: update });
    if (result.matchedCount === 0) {
      return res.status(404).send({ error: "Product not found" });
    }
    const fresh = await products.findOne({ _id });
    res.send({ message: "Product updated successfully", product: fresh });
  }),
);

app.put(
  "/products/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).send({ error: "Invalid product id" });

    const p = req.body || {};
    if (!p.name || p.price === undefined || !p.diet || !p.category) {
      return res.status(400).send({ error: "Invalid product data" });
    }
    const update = {
      name: p.name,
      description: p.description ?? "",
      price: Number(p.price),
      diet: p.diet,
      category: p.category,
      isfeatured: p.isfeatured === true || p.isFeatured === true,
      images: normalizeImages(p.images),
      ingredients: normalizeStringArray(p.ingredients),
      cuisine: p.cuisine ?? "",
      spiceLevel: Number(p.spiceLevel ?? 0),
      prepTime: Number(p.prepTime ?? 0),
      calories: Number(p.calories ?? 0),
      tags: normalizeStringArray(p.tags),
      isFeatured: p.isFeatured === true,
      isAvailable: p.isAvailable !== false,
      status: p.status ?? "Active",
      updatedAt: new Date(),
    };
    const result = await products.updateOne({ _id }, { $set: update });
    if (result.matchedCount === 0) {
      return res.status(404).send({ error: "Product not found" });
    }
    res.send({ message: "Product updated successfully", result });
  }),
);

app.delete(
  "/products/:id",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).send({ error: "Invalid product id" });
    const result = await products.deleteOne({ _id });
    if (result.deletedCount === 0) {
      return res.status(404).send({ error: "Product not found" });
    }
    res.send({ message: "Product deleted successfully", result });
  }),
);

app.post(
  "/create-payment-intent",
  ah(async (req, res) => {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: "Stripe not configured" });
    }
    const { price } = req.body || {};
    if (!price || Number(price) <= 0) {
      return res.status(400).send({ error: "Invalid price" });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(Number(price) * 100),
      currency: "usd",
      payment_method_types: ["card"],
    });
    res.send({ clientSecret: paymentIntent.client_secret });
  }),
);

app.get(
  "/payments",
  authenticate,
  requireAdmin,
  ah(async (req, res) => {
    const payment = await paymentCollection.find().toArray();
    res.send(payment);
  }),
);

app.get(
  "/payments/:email",
  authenticate,
  ah(async (req, res) => {
    if (
      req.user.email !== String(req.params.email).toLowerCase() &&
      req.user.role !== "admin"
    ) {
      return res.status(403).send({ error: "Not authorized" });
    }
    const result = await paymentCollection
      .find({ email: req.params.email })
      .toArray();
    res.send(result);
  }),
);

app.post(
  "/payments",
  optionalAuthenticate,
  ah(async (req, res) => {
    const doc = { ...(req.body || {}) };
    if (req.user?.id) doc.userId = req.user.id;
    const result = await paymentCollection.insertOne(doc);
    res.send({ result });
  }),
);

app.get("/logout", (req, res) => {
  res
    .clearCookie("token", {
      maxAge: 0,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
    })
    .send({ success: true });
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const isProd = process.env.NODE_ENV === "production";
  res.status(500).json({
    error: isProd
      ? "Internal server error"
      : err.message || "Internal server error",
  });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;

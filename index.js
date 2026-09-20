const express = require("express");
const cors = require("cors");
const dns = require("dns");
require("dotenv").config({ quiet: true });
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

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
  process.env.CLIENT_ORIGIN
    ? process.env.CLIENT_ORIGIN.replace(/\/+$/, "")
    : null,
  "https://mastertable.vercel.app",
].filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

app.use(express.json({ limit: "10mb" }));

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

function buildProductUpdate(p) {
  const update = {};
  if (p.name !== undefined) update.name = p.name;
  if (p.description !== undefined) update.description = p.description;
  if (p.category !== undefined) update.category = p.category;
  if (p.price !== undefined) update.price = Number(p.price);
  if (p.stock !== undefined) update.stock = Number(p.stock);
  if (p.sold !== undefined) update.sold = Number(p.sold);
  if (p.rating !== undefined) update.rating = Number(p.rating);
  if (p.emoji !== undefined) update.emoji = p.emoji;
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

app.get(
  "/api/dashboard/summary",
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
          {
            $match: {
              time: { $gte: thisMonth.start, $lte: thisMonth.end },
            },
          },
          { $group: { _id: null, sum: { $sum: "$total" } } },
        ])
        .toArray(),
      orders
        .aggregate([
          {
            $match: {
              time: { $gte: lastMonth.start, $lte: lastMonth.end },
            },
          },
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
  ah(async (req, res) => {
    const list = await reservations.find().toArray();
    res.json(list.map(toClient));
  }),
);

app.get(
  "/api/dashboard/activity",
  ah(async (req, res) => {
    const list = await activity.find().sort({ _id: -1 }).limit(8).toArray();
    res.json(list.map(toClient));
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

app.post(
  "/api/products",
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
      emoji: p.emoji ?? "🍽️",
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
  ah(async (req, res) => {
    const { name, description, emoji } = req.body || {};
    if (!name) return res.status(400).json({ error: "Category name required" });
    const doc = {
      name,
      description: description || "",
      emoji: emoji || "🍽️",
      items: 0,
      revenue: 0,
      share: 0,
    };
    const result = await categories.insertOne(doc);
    res.status(201).json(toClient({ _id: result.insertedId, ...doc }));
  }),
);

app.patch(
  "/api/categories/:id",
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid category id" });
    const update = pick(req.body, [
      "name",
      "description",
      "emoji",
      "items",
      "revenue",
      "share",
    ]);
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "No fields provided" });
    }
    const result = await categories.updateOne({ _id }, { $set: update });
    if (result.matchedCount === 0)
      return res.status(404).json({ error: "Category not found" });
    res.json({ message: "Category updated" });
  }),
);

app.delete(
  "/api/categories/:id",
  ah(async (req, res) => {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ error: "Invalid category id" });
    const result = await categories.deleteOne({ _id });
    if (result.deletedCount === 0)
      return res.status(404).json({ error: "Category not found" });
    res.json({ message: "Category deleted" });
  }),
);

app.get(
  "/api/customers",
  ah(async (req, res) => {
    const { tier, search } = req.query;
    const query = {};
    if (tier && tier !== "All") query.tier = tier;
    if (search) {
      const s = String(search);
      query.$or = [
        { name: { $regex: s, $options: "i" } },
        { email: { $regex: s, $options: "i" } },
        { city: { $regex: s, $options: "i" } },
      ];
    }
    const list = await customers.find(query).sort({ spent: -1 }).toArray();
    res.json(list.map(toClient));
  }),
);

app.post(
  "/api/customers",
  ah(async (req, res) => {
    const { name, email, city } = req.body || {};
    if (!name || !email)
      return res.status(400).json({ error: "Name and email required" });
    const doc = {
      name,
      email,
      city: city || "",
      orders: 0,
      spent: 0,
      tier: "Regular",
      lastVisit: new Date().toISOString().slice(0, 10),
      createdAt: new Date(),
    };
    const result = await customers.insertOne(doc);
    res.status(201).json(toClient({ _id: result.insertedId, ...doc }));
  }),
);

app.get(
  "/api/orders",
  ah(async (req, res) => {
    const { status, search } = req.query;
    const query = {};
    if (status && status !== "All") query.status = status;
    if (search) {
      const s = String(search);
      query.$or = [
        { orderId: { $regex: s, $options: "i" } },
        { customer: { $regex: s, $options: "i" } },
      ];
    }
    const list = await orders
      .find(query)
      .sort({ time: -1 })
      .limit(200)
      .toArray();
    res.json(
      list.map((o) => ({
        id: o.orderId,
        customer: o.customer,
        channel: o.channel,
        table: o.table,
        status: o.status,
        payment: o.payment,
        items: o.items,
        total: +Number(o.total || 0).toFixed(2),
        time: new Date(o.time).toLocaleString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          month: "short",
          day: "numeric",
        }),
      })),
    );
  }),
);

app.post(
  "/api/orders",
  ah(async (req, res) => {
    const { customer, channel, table, items, payment } = req.body || {};
    if (!customer || !channel || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: "Invalid order data" });
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
    const doc = {
      orderId,
      customer,
      channel,
      table: table || null,
      status: "Pending",
      payment: payment || "Card",
      items,
      total: +(subtotal * 1.05).toFixed(2),
      time: new Date(),
    };
    await orders.insertOne(doc);
    res.status(201).json({ message: "Order created", orderId });
  }),
);

app.patch(
  "/api/orders/:orderId",
  ah(async (req, res) => {
    const update = pick(req.body, [
      "status",
      "payment",
      "table",
      "customer",
      "channel",
      "items",
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
  "/api/analytics/traffic",
  ah(async (req, res) => {
    const doc = await analytics.findOne({ key: "traffic-sources" });
    res.json(doc?.segments || []);
  }),
);

app.get(
  "/api/analytics/funnel",
  ah(async (req, res) => {
    const doc = await analytics.findOne({ key: "funnel" });
    res.json(doc?.steps || []);
  }),
);

app.get(
  "/api/analytics/weekday-orders",
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
  ah(async (req, res) => {
    const list = await products.find().sort({ sold: -1 }).limit(5).toArray();
    const max = list[0]?.sold || 1;
    res.json(
      list.map((p) => ({
        name: p.name,
        emoji: p.emoji,
        sold: p.sold,
        share: Math.round(((p.sold || 0) / max) * 100),
      })),
    );
  }),
);

app.get(
  "/api/reports",
  ah(async (req, res) => {
    const list = await reports.find().sort({ _id: -1 }).toArray();
    res.json(list.map(toClient));
  }),
);

app.post(
  "/api/reports/generate",
  ah(async (req, res) => {
    const { name, format } = req.body || {};
    const doc = {
      name: name || "Custom report",
      desc: "Generated on demand",
      range: "Last 30 days",
      format: format || "PDF",
      size: `${(200 + Math.random() * 900).toFixed(0)} KB`,
      updated: "Just now",
    };
    const result = await reports.insertOne(doc);
    res.status(201).json(toClient({ _id: result.insertedId, ...doc }));
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
  ah(async (req, res) => {
    const body = { ...(req.body || {}) };
    delete body._id;
    delete body.id;
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
  ah(async (req, res) => {
    const users = await usersCollection.find().toArray();
    res.send(users);
  }),
);

app.get(
  "/users/:email",
  ah(async (req, res) => {
    const result = await usersCollection.findOne({ email: req.params.email });
    res.send(result);
  }),
);

app.patch(
  "/users/:email",
  ah(async (req, res) => {
    const { email } = req.params;
    const set = pick(req.body, ["role", "userEmail", "userName"]);
    if (Object.keys(set).length === 0) {
      return res.status(400).send({ error: "No fields provided for update" });
    }
    const result = await usersCollection.updateOne({ email }, { $set: set });
    if (result.matchedCount === 0) {
      return res.status(404).send({ error: "User not found" });
    }
    if (result.modifiedCount === 0) {
      return res.status(400).send({ message: "No changes made to the user" });
    }
    res.send({ message: "User updated successfully", result });
  }),
);

app.put(
  "/user",
  ah(async (req, res) => {
    const user = req.body || {};
    if (!user.email) {
      return res.status(400).send({ error: "Email required" });
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
  ah(async (req, res) => {
    const banner = req.body;
    if (!banner || !banner.url || !banner.heading || !banner.description) {
      return res.status(400).send({ error: "Invalid banner data" });
    }
    const result = await bannerCollection.insertOne({
      url: banner.url,
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
  const { url, heading, description } = req.body || {};
  if (!url && !heading && !description) {
    return res.status(400).send({ error: "No fields provided for update" });
  }
  const updateDoc = {
    $set: {
      ...(url && { url }),
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

app.patch("/banners/:id", updateBanner);
app.put("/banners/:id", updateBanner);

app.delete(
  "/banners/:id",
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
      emoji: p.emoji ?? "🍽️",
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
  ah(async (req, res) => {
    const payment = await paymentCollection.find().toArray();
    res.send(payment);
  }),
);

app.get(
  "/payments/:email",
  ah(async (req, res) => {
    const result = await paymentCollection
      .find({ email: req.params.email })
      .toArray();
    res.send(result);
  }),
);

app.post(
  "/payments",
  ah(async (req, res) => {
    const result = await paymentCollection.insertOne(req.body);
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
  res.status(500).json({ error: err.message || "Internal server error" });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;

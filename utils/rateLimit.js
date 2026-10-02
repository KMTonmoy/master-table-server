function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 20 } = {}) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (now - entry.start > windowMs) hits.delete(key);
    }
  }, windowMs);
  if (typeof sweep.unref === "function") sweep.unref();

  return function rateLimit(req, res, next) {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      return res.status(429).json({
        success: false,
        message: "Too many requests. Please try again later.",
      });
    }

    next();
  };
}

module.exports = createRateLimiter;
const { verifyToken } = require("../utils/jwt");

function buildAuthMiddleware(usersCollection, oid) {
  async function loadUserFromRequest(req) {
    const token = req.cookies?.token;
    if (!token) return null;

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (e) {
      return null;
    }

    const _id = oid(decoded.userId);
    if (!_id) return null;

    const user = await usersCollection.findOne({ _id });
    if (!user) return null;

    return {
      id: user._id.toString(),
      name: user.name || user.displayName || user.userName || "",
      email: (user.email || user.userEmail || "").toLowerCase(),
      role: user.role || "user",
      provider: user.provider || "email",
      profileImage: user.profileImage || "",
      isVerified: user.isVerified === true,
    };
  }

  async function authenticate(req, res, next) {
    try {
      const user = await loadUserFromRequest(req);
      if (!user) {
        return res.status(401).json({ success: false, message: "Authentication required" });
      }
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  }

  async function optionalAuthenticate(req, res, next) {
    try {
      req.user = await loadUserFromRequest(req);
    } catch (err) {
      req.user = null;
    }
    next();
  }

  return { authenticate, optionalAuthenticate };
}

module.exports = buildAuthMiddleware;
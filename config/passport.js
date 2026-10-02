const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy;

async function findOrLinkUser(usersCollection, { provider, providerId, email, name, profileImage }) {
  let user = await usersCollection.findOne({ provider, providerId });
  if (user) return user;

  if (email) {
    const existing = await usersCollection.findOne({ email });
    if (existing) {
      const update = { updatedAt: new Date() };
      if (existing.provider === "email" || !existing.provider) {
        update.providerId = existing.providerId || providerId;
      } else {
        update.provider = provider;
        update.providerId = existing.providerId || providerId;
      }
      if (!existing.profileImage && profileImage) update.profileImage = profileImage;

      await usersCollection.updateOne({ _id: existing._id }, { $set: update });
      return usersCollection.findOne({ _id: existing._id });
    }
  }

  const now = new Date();
  const doc = {
    name: name || "",
    email: email || null,
    password: null,
    profileImage: profileImage || "",
    provider,
    providerId,
    role: "user",
    isVerified: true,
    createdAt: now,
    updatedAt: now,
  };
  const result = await usersCollection.insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

function configurePassport(usersCollection) {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(
      "google",
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: process.env.GOOGLE_CALLBACK_URL,
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const user = await findOrLinkUser(usersCollection, {
              provider: "google",
              providerId: profile.id,
              email: profile.emails?.[0]?.value?.toLowerCase() || null,
              name: profile.displayName,
              profileImage: profile.photos?.[0]?.value || "",
            });
            done(null, user);
          } catch (err) {
            done(err, null);
          }
        },
      ),
    );
  }

  if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
    passport.use(
      "facebook",
      new FacebookStrategy(
        {
          clientID: process.env.FACEBOOK_APP_ID,
          clientSecret: process.env.FACEBOOK_APP_SECRET,
          callbackURL: process.env.FACEBOOK_CALLBACK_URL,
          profileFields: ["id", "displayName", "emails", "photos"],
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const user = await findOrLinkUser(usersCollection, {
              provider: "facebook",
              providerId: profile.id,
              email: profile.emails?.[0]?.value?.toLowerCase() || null,
              name: profile.displayName,
              profileImage: profile.photos?.[0]?.value || "",
            });
            done(null, user);
          } catch (err) {
            done(err, null);
          }
        },
      ),
    );
  }

  return passport;
}

module.exports = configurePassport;
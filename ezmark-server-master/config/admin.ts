const DEFAULT_API_TOKEN_SALT = "ezmarkApiTokenSaltDefault";
const DEFAULT_TRANSFER_TOKEN_SALT = "ezmarkTransferTokenSaltDefault";

const readSalt = (env, key: string, fallback: string) => {
  const value = env(key, fallback);
  const trimmed = typeof value === "string" ? value.trim() : value;

  if (typeof trimmed !== "string" || trimmed.length === 0) {
    throw new Error(
      `${key} must be configured with a non-empty string. ` +
        `Set ${key} in your environment or update config/admin.ts.`
    );
  }

  return trimmed;
};

export default ({ env }) => ({
  auth: {
    secret: env("ADMIN_JWT_SECRET"),
  },
  apiToken: {
    salt: readSalt(env, "API_TOKEN_SALT", DEFAULT_API_TOKEN_SALT),
  },
  transfer: {
    token: {
      salt: readSalt(env, "TRANSFER_TOKEN_SALT", DEFAULT_TRANSFER_TOKEN_SALT),
    },
  },
  flags: {
    nps: env.bool("FLAG_NPS", true),
    promoteEE: env.bool("FLAG_PROMOTE_EE", true),
  },
});

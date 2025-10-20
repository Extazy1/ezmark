const STRAPI_PREFIX = "/strapi";
const API_PREFIX = `${STRAPI_PREFIX}/api`;

const shouldRewrite = (path: string) =>
  path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);

const stripPrefix = (value: string) =>
  value === STRAPI_PREFIX ? "/" : value.replace(/^\/strapi/, "");

export default () => {
  return async (ctx: any, next: () => Promise<void>) => {
    if (shouldRewrite(ctx.path)) {
      const rewrittenPath = stripPrefix(ctx.path);
      const rewrittenUrl = stripPrefix(ctx.url);

      ctx.url = rewrittenUrl;
      ctx.path = rewrittenPath;
      ctx.request.url = rewrittenUrl;
    }

    await next();
  };
};

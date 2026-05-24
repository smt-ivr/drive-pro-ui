import htmlContent from "./index.html";

export default {
  async fetch(request, env, ctx) {
    return new Response(htmlContent, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  },
};

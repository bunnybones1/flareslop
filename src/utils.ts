export const makeJsonResponse = (
  data: unknown,
  init?: ResponseInit,
): Response => {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    ...init,
  });
};

export const uuid = (): string => {
  return crypto.randomUUID();
};

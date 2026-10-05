import { getStore } from "@netlify/blobs";

const store = getStore("episodes");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function authorized(req) {
  const configured = process.env.ADMIN_PASSWORD;
  const supplied = req.headers.get("x-admin-password");

  return Boolean(
    configured &&
    supplied &&
    supplied === configured
  );
}

export default async (req) => {
  try {
    if (req.method === "GET") {
      const { blobs } = await store.list({
        prefix: "episode/"
      });

      const items = [];

      for (const blob of blobs) {
        const value = await store.get(blob.key, {
          type: "json"
        });

        if (value) {
          items.push(value);
        }
      }

      items.sort(
        (a, b) =>
          Number(b.season) - Number(a.season) ||
          Number(b.episode) - Number(a.episode)
      );

      return json(items);
    }

    if (req.method === "POST") {
      if (!authorized(req)) {
        return json(
          { error: "Invalid admin password." },
          401
        );
      }

      const body = await req.json();

      if (!body.videoUrl) {
        return json(
          { error: "Video URL is required." },
          400
        );
      }

      const item = {
        id: crypto.randomUUID(),

        title: String(
          body.title || "Untitled Episode"
        ).trim(),

        season: Math.max(
          1,
          Number(body.season || 1)
        ),

        episode: Math.max(
          1,
          Number(body.episode || 1)
        ),

        description: String(
          body.description || ""
        ).trim(),

        duration: String(
          body.duration || ""
        ).trim(),

        videoUrl: String(
          body.videoUrl
        ),

        thumbnailUrl: String(
          body.thumbnailUrl || ""
        ),

        videoType:
          body.videoType === "youtube"
            ? "youtube"
            : body.videoType === "r2"
              ? "r2"
              : "cloudinary",

        createdAt:
          new Date().toISOString()
      };

      await store.setJSON(
        `episode/${item.id}`,
        item
      );

      return json(item, 201);
    }

    if (req.method === "DELETE") {
      if (!authorized(req)) {
        return json(
          { error: "Invalid admin password." },
          401
        );
      }

      const url = new URL(req.url);
      const id = url.searchParams.get("id");

      if (!id) {
        return json(
          { error: "Episode id is required." },
          400
        );
      }

      await store.delete(`episode/${id}`);

      return json({ ok: true });
    }

    return json(
      { error: "Method not allowed." },
      405
    );

  } catch (error) {
    console.error(error);

    return json(
      {
        error:
          error?.message ||
          "Server error."
      },
      500
    );
  }
};

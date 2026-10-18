import type { MetadataRoute } from "next";

/** Lets phones install Metafarm like an app, for work in the field. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Metafarm",
    short_name: "Metafarm",
    description: "Run the farm with your team: tasks, inputs, harvests and equipment, also without signal.",
    start_url: "/tasks",
    scope: "/",
    display: "standalone",
    background_color: "#eef1ec",
    theme_color: "#173323",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
